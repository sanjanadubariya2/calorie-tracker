"""Phase 3 Tasks 4-5: recommendation API (list, detail, feedback, log proposals),
preference management and assistant parity, against an owner-scoped fake PostgREST."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.assistant.tools.base import ToolContext
from app.assistant.tools.recommend import RecommendArgs, run_recommend
from app.core.config import Settings
from app.core.security import AuthenticatedUser
from app.db.supabase import SupabaseRest
from app.llm.service import LLMService, RetryPolicy
from app.main import create_app
from tests.assistant_fakes import FakeNutritionDB, InMemoryProposals, InMemoryStore, ScriptedLLM, food, status_row
from tests.conftest import FakeSupabase

A = "aaaaaaaa-0000-0000-0000-00000000000a"
B = "bbbbbbbb-0000-0000-0000-00000000000b"
URL = "/v1/me/recommendations"
RECIPE = "e0000000-0000-0000-0000-000000000001"
FAMILY = "f0000000-0000-0000-0000-000000000001"

FOODS = [
    food("Paneer tikka", "paneer_dish", 250, 18, serving_g=150),
    food("Chicken curry", "non_veg", 180, 20, serving_g=200),
    food("Moong dal", "dal", 110, 7, serving_g=180),
    food("Rajma chawal", "rice_dish", 150, 6, serving_g=250),
    food("Karela sabzi", "sabzi", 90, 2, serving_g=150),
    food("Gulab jamun", "sweet", 380, 5, serving_g=60),
]


class Api:
    def __init__(self, client: TestClient, db: FakeNutritionDB, proposals: InMemoryProposals,
                 make_token: Callable[..., str]) -> None:
        self.c, self.db, self.proposals = client, db, proposals
        self.tokens = {A: make_token(A), B: make_token(B)}

    def h(self, uid: str = A) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.tokens[uid]}"}

    def list(self, uid: str = A, **params: Any) -> httpx.Response:
        return self.c.get(URL, params={"meal_type": "lunch", "count": 3, "mode": "foods", **params}, headers=self.h(uid))

    def ok(self, uid: str = A, **params: Any) -> dict[str, Any]:
        r = self.list(uid, **params)
        assert r.status_code == 200, r.text
        return r.json()

    def feedback(self, item_id: str, action: str, uid: str = A) -> httpx.Response:
        return self.c.post(f"{URL}/{item_id}/feedback", json={"action": action}, headers=self.h(uid))


@pytest.fixture
def api(settings: Settings, fake_supabase: FakeSupabase, make_token: Callable[..., str]) -> Iterator[Api]:
    db = FakeNutritionDB()
    db.foods = list(FOODS)
    for uid in (A, B):
        db.user(uid).status = status_row(consumed=0)
        db.user(uid).profile = {"goal": "maintain"}
    fake_supabase.rpc_handler = db.handle_rpc
    fake_supabase.rest_handler = db.handle_rest
    proposals = InMemoryProposals()
    app = create_app(settings, transport=httpx.MockTransport(fake_supabase.handle),
                     llm=LLMService(ScriptedLLM(), retry=RetryPolicy(attempts=1)), assistant_store=InMemoryStore(),
                     proposal_store=proposals)
    with TestClient(app, raise_server_exceptions=False) as c:
        yield Api(c, db, proposals, make_token)


# ============================================================================ auth and validation

def test_every_endpoint_requires_authentication(api: Api) -> None:
    some = str(uuid.uuid4())
    for method, path, body in [("GET", URL, None), ("GET", f"{URL}/{some}", None),
                               ("POST", f"{URL}/{some}/feedback", {"action": "viewed"}),
                               ("POST", f"{URL}/{some}/log-proposal", {}),
                               ("GET", "/v1/me/recommendation-feedback", None),
                               ("DELETE", f"/v1/me/recommendation-feedback/{some}", None),
                               ("PATCH", "/v1/me/preferences", {"diet": "vegan"})]:
        r = api.c.request(method, path, json=body, params={"meal_type": "lunch"} if path == URL else None)
        assert r.status_code == 401, (method, path)
    assert api.db.requests == []


@pytest.mark.parametrize("params", [{"meal_type": "brunch"}, {"count": 0}, {"count": 11}, {"max_kcal": 10},
                                    {"protein": "extreme"}, {"mode": "all"}, {"exclude": "food:not-a-uuid"},
                                    {"cuisine": "x"}, {"user_id": A}, {"tolerance": "loose"}])
def test_invalid_filters_are_rejected(api: Api, params: dict[str, Any]) -> None:
    assert api.list(**params).status_code == 422


# ============================================================================ list

def test_recommendations_are_ranked_priced_and_recorded(api: Api) -> None:
    data = api.ok()
    assert data["status"] == "ok" and data["engine_version"] == "rec-v2" and data["set_id"]
    assert data["budget"]["kcal"] == 700 and len(data["items"]) == 3
    priced = {(b["p_food_id"], b["p_grams"]) for _, what, b in api.db.requests if what == "rpc:food_portion"}
    for item in data["items"]:
        assert item["id"] and item["key"].startswith("food:") and item["image_url"] is None
        [p] = item["portions"]
        assert (str(p["id"]), p["grams"]) in priced
        assert set(item["score"]["components"]) >= {"calories", "protein", "history", "quality"}
        assert item["reasons"] and item["data"]["diet_status"] == "inferred"
    # History belongs to the caller only.
    assert len([r for r in api.db.rec["recommendation_items"] if r["user_id"] == A]) == 3
    assert not [r for r in api.db.rec["recommendation_items"] if r["user_id"] == B]
    # Nothing was logged.
    assert api.db.user(A).logs == []


def test_users_cannot_see_or_act_on_each_others_recommendations(api: Api) -> None:
    item = api.ok(A)["items"][0]["id"]
    assert api.c.get(f"{URL}/{item}", headers=api.h(B)).status_code == 404
    assert api.feedback(item, "saved", uid=B).status_code == 404
    assert api.c.post(f"{URL}/{item}/log-proposal", json={}, headers=api.h(B)).status_code == 404
    assert api.c.get(f"{URL}/{item}", headers=api.h(A)).status_code == 200


def test_preferences_are_applied_and_isolated(api: Api) -> None:
    r = api.c.patch("/v1/me/preferences", json={"diet": "vegetarian", "excluded_ingredients": ["karela"],
                                                 "dislikes": ["rajma"]}, headers=api.h(A))
    assert r.status_code == 200, r.text
    assert r.json()["excluded_ingredients"] == ["karela"] and r.json()["dislikes"] == ["rajma"]
    a = api.ok(A, count=5)
    names = [i["name"] for i in a["items"]]
    assert "Chicken curry" not in names and "Karela sabzi" not in names
    assert {"diet_conflict", "excluded_ingredient"} <= {e["reason"] for e in a["excluded"]}
    rajma = next((i for i in a["items"] if i["name"] == "Rajma chawal"), None)
    if rajma:                                       # disliked: lower, not removed
        assert rajma["score"]["adjustments"].get("dislike") == 0.15
    # B has no preferences: unaffected, and told so.
    b = api.ok(B, count=5)
    assert "Chicken curry" in [i["name"] for i in b["items"]]
    assert any("No food preferences are saved" in n for n in b["notes"])
    assert api.c.get("/v1/me/preferences", headers=api.h(B)).json() is None


def test_preference_management(api: Api) -> None:
    put = api.c.put("/v1/me/preferences", json={"diet": "eggetarian", "cuisines": ["South Indian"],
                                                "preferred_meal_styles": ["tiffin"], "max_prep_minutes": 30,
                                                "budget": "low", "equipment": ["stove", "tawa"]}, headers=api.h())
    assert put.status_code == 200, put.text
    patched = api.c.patch("/v1/me/preferences", json={"max_prep_minutes": None, "equipment": None},
                          headers=api.h()).json()
    assert patched["diet"] == "eggetarian" and patched["preferred_meal_styles"] == ["tiffin"]
    assert patched["max_prep_minutes"] is None and patched["equipment"] is None
    assert api.c.patch("/v1/me/preferences", json={"favourite_colour": "red"}, headers=api.h()).status_code == 422
    assert api.c.patch("/v1/me/preferences", json={"preferred_meal_styles": ["brunch"]},
                       headers=api.h()).status_code == 422
    assert api.c.delete("/v1/me/preferences", headers=api.h()).status_code == 204
    assert api.c.get("/v1/me/preferences", headers=api.h()).json() is None


def test_high_protein_and_max_kcal_filters(api: Api) -> None:
    data = api.ok(protein="high", max_kcal=450, count=5)
    assert data["budget"]["kcal"] == 450
    for i in data["items"]:
        n = i["nutrition"]
        assert n["kcal"] <= 450 and n["protein_g"] * 4 / n["kcal"] >= 0.19   # whole-gram rounding


def test_alternatives_exclude_what_was_shown(api: Api) -> None:
    first = api.ok(count=2)
    keys = [i["key"] for i in first["items"]]
    alt = api.ok(count=2, exclude=keys)
    assert not set(keys) & {i["key"] for i in alt["items"]}


def test_empty_results(api: Api) -> None:
    api.db.foods = []
    data = api.ok()
    assert (data["status"], data["items"], data["considered"]) == ("empty_catalogue", [], 0)
    api.db.foods = list(FOODS)
    assert api.ok(meal_type="lunch", mode="meals")["status"] == "empty_catalogue"   # no recipes or templates


def test_history_failure_does_not_hide_recommendations(api: Api) -> None:
    api.db.fail_history_insert = True
    data = api.ok()
    assert data["set_id"] is None and len(data["items"]) == 3 and all(i["id"] is None for i in data["items"])


# ============================================================================ detail

def test_detail_reprices_adjusted_servings(api: Api) -> None:
    item = api.ok()["items"][0]
    rec = api.c.get(f"{URL}/{item['id']}", headers=api.h()).json()
    assert rec["item"]["nutrition"] == item["nutrition"] and rec["recommended_servings"] == [item["portions"][0]["servings"]]
    doubled = api.c.get(f"{URL}/{item['id']}", params={"servings": item["portions"][0]["servings"] * 2},
                        headers=api.h()).json()
    assert doubled["item"]["portions"][0]["servings"] == item["portions"][0]["servings"] * 2
    assert abs(doubled["item"]["nutrition"]["kcal"] - 2 * item["nutrition"]["kcal"]) <= 1
    assert api.c.get(f"{URL}/{item['id']}", params={"servings": 50}, headers=api.h()).status_code == 422
    assert api.c.get(f"{URL}/{item['id']}", params={"servings": [1, 1]}, headers=api.h()).status_code == 422


def test_unavailable_meals_are_never_presented_as_available(api: Api) -> None:
    item = api.ok()["items"][0]
    food_id = item["portions"][0]["id"]
    api.db.foods = [f for f in api.db.foods if f["id"] != food_id]     # deactivated / removed
    api.c.app.state.recommendations.clear_cache()
    assert api.c.get(f"{URL}/{item['id']}", headers=api.h()).status_code == 410
    assert api.c.post(f"{URL}/{item['id']}/log-proposal", json={}, headers=api.h()).status_code == 410


# ============================================================================ feedback

def test_feedback_events_and_bookmarks(api: Api) -> None:
    items = api.ok()["items"]
    first, second = items[0], items[1]
    r = api.feedback(first["id"], "viewed")
    assert r.status_code == 201 and r.json()["event_recorded"] and r.json()["feedback"] is None
    saved = api.feedback(first["id"], "saved").json()["feedback"]
    assert saved["feedback"] == "saved" and saved["expires_at"] is None and saved["name"] == first["name"]
    listed = api.c.get("/v1/me/recommendation-feedback", params={"feedback": "saved"}, headers=api.h()).json()
    assert [f["name"] for f in listed] == [first["name"]]
    assert api.c.get(f"{URL}/{first['id']}", headers=api.h()).json()["saved"] is True
    api.feedback(first["id"], "unsaved")
    assert api.c.get("/v1/me/recommendation-feedback", headers=api.h()).json() == []
    # Events are stored against the user's own item.
    events = [e["event"] for e in api.db.rec["recommendation_events"] if e["user_id"] == A]
    assert events == ["viewed", "saved", "unsaved"]
    # B sees none of it.
    assert api.c.get("/v1/me/recommendation-feedback", headers=api.h(B)).json() == []
    assert api.feedback(second["id"], "bogus").status_code == 422


def test_never_removes_a_recommendation_until_the_feedback_is_deleted(api: Api) -> None:
    top = api.ok()["items"][0]
    fb = api.feedback(top["id"], "never").json()["feedback"]
    assert fb["feedback"] == "never"
    after = api.ok(count=5)
    assert top["key"] not in {i["key"] for i in after["items"]}
    assert any(e["reason"] == "never_feedback" for e in after["excluded"])
    assert api.c.delete(f"/v1/me/recommendation-feedback/{fb['id']}", headers=api.h()).status_code == 204
    assert api.c.delete(f"/v1/me/recommendation-feedback/{fb['id']}", headers=api.h()).status_code == 404
    assert top["key"] in {i["key"] for i in api.ok(count=5)["items"]}


def test_not_interested_and_repeats_demote_without_removing(api: Api) -> None:
    first = api.ok(count=5)
    top = first["items"][0]
    api.feedback(top["id"], "not_interested")
    later = api.ok(count=5)
    keys = [i["key"] for i in later["items"]]
    assert keys[0] != top["key"]
    if top["key"] in keys:
        demoted = later["items"][keys.index(top["key"])]
        assert demoted["score"]["adjustments"]["rejected"] == 0.15
    # Everything shown twice now carries a (small, temporary) novelty adjustment.
    assert all(i["score"]["adjustments"].get("novelty", 0) > 0 for i in later["items"]
               if i["key"] in {x["key"] for x in first["items"]})


# ============================================================================ logging through proposals

def test_log_proposal_reuses_the_confirmation_flow(api: Api) -> None:
    item = api.ok()["items"][0]
    r = api.c.post(f"{URL}/{item['id']}/log-proposal", json={"meal_type": "lunch"}, headers=api.h())
    assert r.status_code == 201, r.text
    proposal = r.json()
    assert proposal["status"] == "pending" and proposal["requires_user_confirmation"] is True
    [line] = proposal["items"]
    assert line["food_id"] == item["portions"][0]["id"] and line["grams"] == item["portions"][0]["grams"]
    assert round(line["nutrition"]["calories"]) == item["nutrition"]["kcal"]
    assert api.db.user(A).logs == []                       # nothing logged before confirmation
    done = api.c.post(f"/v1/assistant/proposals/{proposal['id']}/confirm", json={}, headers=api.h())
    assert done.status_code == 200, done.text
    [log] = api.db.user(A).logs
    assert log["source"] == "catalogue" and log["food_id"] == line["food_id"] and log["meal_type"] == "lunch"
    events = [e["event"] for e in api.db.rec["recommendation_events"] if e["user_id"] == A]
    assert events == ["selected", "logged"]
    # Single use.
    assert api.c.post(f"/v1/assistant/proposals/{proposal['id']}/confirm", json={}, headers=api.h()).status_code == 409


def _publish_recipe(db: FakeNutritionDB) -> None:
    db.recipe_rows = [{
        "recipe_id": RECIPE, "family_id": FAMILY, "version": 1, "slug": "dal-tadka", "name": "Dal tadka",
        "variant": None, "description": "Toor dal with a ghee tempering.", "servings": 4, "serving_label": "1 katori",
        "prep_minutes": 10, "cook_minutes": 30, "equipment": ["pressure_cooker", "stove"],
        "meal_types": ["dinner", "lunch"], "regions": ["north_indian"], "dish_types": ["dal"], "source": "curated",
        "verification": "curated", "quantities_estimated": True, "complete": True, "missing": [],
        "missing_nutrients": [], "per_serving": {"calories": 230, "protein_g": 12, "carbs_g": 30, "fat_g": 7},
        "ingredients": [{"position": 1, "food_name": "Toor dal (raw)", "quantity": 150, "unit": "g", "grams": 150,
                         "optional": False}],
        "main_food_name": "Toor dal (raw)", "diet_classes": ["vegetarian"], "diet_status": "inferred",
        "vegan_compatible": None, "jain_compatible": None, "allergens": ["milk"], "allergen_status": "inferred",
        "quality_flags": []}]
    db.recipe_kcal = {RECIPE: {"calories": 230, "protein_g": 12, "carbs_g": 30, "fat_g": 7}}
    db.recipe_instructions = {RECIPE: ["Pressure-cook the dal.", "Temper with ghee and cumin."]}


def test_recipe_recommendation_details_and_logging(api: Api) -> None:
    _publish_recipe(api.db)
    data = api.ok(mode="meals", meal_type="dinner", count=1, max_kcal=700)
    [item] = data["items"]
    assert item["kind"] == "recipe" and item["total_minutes"] == 40
    assert item["equipment"] == ["pressure_cooker", "stove"] and item["data"]["approximate"] is True
    servings = item["portions"][0]["servings"]
    assert item["ingredients"][0]["grams"] == round(150 * servings / 4, 1)      # scaled from 4 servings
    detail = api.c.get(f"{URL}/{item['id']}", headers=api.h()).json()
    assert detail["instructions"] == [["Pressure-cook the dal.", "Temper with ghee and cumin."]]
    proposal = api.c.post(f"{URL}/{item['id']}/log-proposal", json={"servings": [1]}, headers=api.h()).json()
    [line] = proposal["items"]
    assert line["recipe_id"] == RECIPE and line["food_id"] is None and line["nutrition"]["calories"] == 230
    done = api.c.post(f"/v1/assistant/proposals/{proposal['id']}/confirm", json={}, headers=api.h())
    assert done.status_code == 200, done.text
    [log] = api.db.user(A).logs
    assert log["food_name"] == "Dal tadka" and log["food_id"] is None and log["calories"] == 230


def test_equipment_preference_filters_recipes(api: Api) -> None:
    _publish_recipe(api.db)
    api.c.put("/v1/me/preferences", json={"equipment": ["stove", "tawa"]}, headers=api.h())
    data = api.ok(mode="meals", meal_type="dinner")
    assert data["items"] == [] and {e["reason"] for e in data["excluded"]} == {"equipment_missing"}


# ============================================================================ assistant parity

def test_assistant_tool_uses_the_same_logic_and_numbers(api: Api, settings: Settings,
                                                         fake_supabase: FakeSupabase) -> None:
    user = AuthenticatedUser(user_id=A, access_token=api.tokens[A])

    async def tool() -> Any:
        async with httpx.AsyncClient(transport=httpx.MockTransport(fake_supabase.handle)) as http:   # same backend
            ctx = ToolContext(user=user, db=SupabaseRest(settings, http), settings=settings, local_date=None)
            return await run_recommend(ctx, RecommendArgs(meal_type="lunch", count=3, mode="foods"))

    writes_before = len([r for r in api.db.requests if r[1].startswith("POST:")])
    from_tool = asyncio.run(tool())
    assert len([r for r in api.db.requests if r[1].startswith("POST:")]) == writes_before   # read-only
    from_api = api.ok()                                       # first recorded request: same history state
    assert [(r.key, r.nutrition.calories_kcal, r.nutrition.protein_g, r.score) for r in from_tool.recommendations] == \
        [(i["key"], i["nutrition"]["kcal"], i["nutrition"]["protein_g"], i["score"]["total"]) for i in from_api["items"]]
    assert from_tool.meal_target.calories_kcal == from_api["budget"]["kcal"]



# ============================================================================ optional template components

TEMPLATE = "44444444-4444-4444-4444-444444444444"


def _template(db: FakeNutritionDB) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    roti = food("Chapati", "bread", 280, 8, serving_g=36, label="1 chapati")
    dal = food("Moong dal", "dal", 110, 7, serving_g=180, label="1 katori")
    tea = food("Hot tea", "beverage", 16, 0.4, serving_g=210, label="1 tea cup")
    egg = food("Boiled egg", "egg_dish", 155, 13, serving_g=50, label="1 egg")
    db.foods = [roti, dal, tea, egg]

    def comp(f: dict[str, Any], pos: int, slot: str, default: float, lo: float, hi: float, step: float,
             optional: bool, **attrs: Any) -> dict[str, Any]:
        g = f["food_servings"][0]["grams"]
        return {"position": pos, "slot": slot, "food_id": f["id"], "food_name": f["name"], "category": f["category"],
                "verification": "curated", "default_servings": default, "min_servings": lo, "max_servings": hi,
                "servings_step": step, "optional": optional, "serving_label": f["food_servings"][0]["label"],
                "serving_grams": g,
                "per_serving": {"calories": round(f["kcal_per_100"] * g / 100),
                                "protein_g": round(f["protein_g_per_100"] * g / 100, 1),
                                "carbs_g": round(f["carbs_g_per_100"] * g / 100, 1),
                                "fat_g": round(f["fat_g_per_100"] * g / 100, 1)},
                "diet_class": "vegetarian", "diet_status": "inferred", "allergens": [], "allergen_status": "inferred",
                "quality_flags": [], **attrs}

    db.template_rows = [{
        "template_id": TEMPLATE, "slug": "roti-dal", "name": "Roti dal thali", "description": None, "version": 1,
        "approval_level": "provisional",
        "meal_types": ["lunch", "dinner"], "regions": ["north_indian"], "complete": True,
        "main_food_id": dal["id"], "main_food_name": "Moong dal",
        "components": [comp(roti, 1, "bread", 3, 1, 4, 1, False), comp(dal, 2, "main", 2, 0.5, 2, 0.5, False),
                       comp(tea, 3, "drink", 1, 1, 1, 1, True, allergens=["milk"], quality_flags=["density_assumed"]),
                       comp(egg, 4, "side", 1, 1, 2, 1, True, diet_class="egg", allergens=["egg"])],
        "diet_classes": ["vegetarian"], "diet_status": "inferred", "vegan_compatible": None, "jain_compatible": None,
        "allergens": ["wheat_gluten"], "allergen_status": "inferred", "quality_flags": []}]
    return tea, egg, dal


def test_optional_components_are_priced_separately_and_totals_reported_both_ways(api: Api) -> None:
    tea, egg, _ = _template(api.db)
    [item] = api.ok(mode="meals", count=1, meal_type="lunch")["items"]
    assert item["kind"] == "meal"
    assert [o["name"] for o in item["optional_components"]] == ["Hot tea", "Boiled egg"]
    tea_out = item["optional_components"][0]
    assert tea_out["nutrition"]["kcal"] == round(16 * 210 / 100) and tea_out["quality_flags"] == ["density_assumed"]
    assert tea_out["allergens_detected"] == ["milk"] and tea_out["allergen_status"] == "inferred"
    extra = sum(o["nutrition"]["kcal"] for o in item["optional_components"])
    assert abs(item["nutrition_with_optional"]["kcal"] - (item["nutrition"]["kcal"] + extra)) <= 1
    assert "Hot tea" not in [p["name"] for p in item["portions"]]          # base meal = required only
    assert item["data"]["approval_level"] == "provisional"
    assert any("provisionally approved" in w for w in item["warnings"])


def test_optional_components_respect_the_users_restrictions(api: Api) -> None:
    _template(api.db)
    api.c.put("/v1/me/preferences", json={"diet": "vegetarian"}, headers=api.h())
    [item] = api.ok(mode="meals", count=1, meal_type="lunch")["items"]
    assert [o["name"] for o in item["optional_components"]] == ["Hot tea"]
    assert item["optional_withheld"] == [{"name": "Boiled egg", "reason": "diet_conflict",
                                          "label": "Not suitable for your diet"}]


def test_detail_recalculates_with_selected_optional_components(api: Api) -> None:
    tea, egg, _ = _template(api.db)
    [item] = api.ok(mode="meals", count=1, meal_type="lunch")["items"]
    url = f"{URL}/{item['id']}"
    base = api.c.get(url, headers=api.h()).json()
    assert base["selected_optional"] == [] and base["total_nutrition"] == item["nutrition"]
    with_tea = api.c.get(url, params={"optional": tea["id"]}, headers=api.h()).json()
    assert with_tea["selected_optional"] == [tea["id"]]
    assert with_tea["total_nutrition"]["kcal"] == item["nutrition"]["kcal"] + round(16 * 210 / 100)
    assert with_tea["item"]["nutrition"] == item["nutrition"]                 # base unchanged
    # Not an optional component of this meal (or withheld from this user): rejected, never added.
    _, _, dal = _template(api.db)
    assert api.c.get(url, params={"optional": dal["id"]}, headers=api.h()).status_code == 422
    api.c.put("/v1/me/preferences", json={"diet": "vegetarian"}, headers=api.h())
    assert api.c.get(url, params={"optional": egg["id"]}, headers=api.h()).status_code == 422


def test_logging_includes_only_the_chosen_optional_components(api: Api) -> None:
    tea, _, _ = _template(api.db)
    [item] = api.ok(mode="meals", count=1, meal_type="lunch")["items"]
    proposal = api.c.post(f"{URL}/{item['id']}/log-proposal", json={"optional": [tea["id"]]}, headers=api.h()).json()
    assert [i["food_name"] for i in proposal["items"]] == ["Chapati", "Moong dal", "Hot tea"]
    assert api.db.user(A).logs == []
    assert api.c.post(f"/v1/assistant/proposals/{proposal['id']}/confirm", json={}, headers=api.h()).status_code == 200
    assert [log["food_name"] for log in api.db.user(A).logs] == ["Chapati", "Moong dal", "Hot tea"]
    plain = api.c.post(f"{URL}/{item['id']}/log-proposal", json={}, headers=api.h()).json()
    assert [i["food_name"] for i in plain["items"]] == ["Chapati", "Moong dal"]
