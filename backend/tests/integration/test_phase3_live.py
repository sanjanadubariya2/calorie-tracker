"""Phase 3 end-to-end against the LOCAL Supabase stack: real Auth, PostgREST,
RLS, migrations 017-018, database pricing and the proposal confirmation path.

    SUPABASE_INTEGRATION=1 SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=<anon key> \\
    ASSISTANT_DATABASE_URL=postgresql://...@127.0.0.1:54322/postgres \\
    pytest tests/integration/test_phase3_live.py

Never run against production: it signs up throwaway users and creates (then
deletes) one test recipe.
"""

from __future__ import annotations

import datetime as dt
import os
import time
import uuid
from collections.abc import Iterator

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient

from app.core.config import Environment, Settings
from app.main import create_app

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(os.getenv("SUPABASE_INTEGRATION") != "1", reason="set SUPABASE_INTEGRATION=1 to run"),
]

TODAY = dt.date(2026, 11, 21).isoformat()
URL = "/v1/me/recommendations"


@pytest.fixture(scope="module")
def live() -> dict[str, str]:
    url = os.environ["SUPABASE_URL"].rstrip("/")
    writer = os.environ.get("ASSISTANT_DATABASE_URL", "")
    assert "127.0.0.1" in url or "localhost" in url, "integration tests only run against a local stack"
    assert not writer or "127.0.0.1" in writer or "localhost" in writer, "writer must be the local database"
    return {"url": url, "anon": os.environ["SUPABASE_ANON_KEY"], "writer": writer}


def _app(live: dict[str, str]) -> TestClient:
    settings = Settings(environment=Environment.development, supabase_url=live["url"], supabase_anon_key=live["anon"],
                        assistant_database_url=live["writer"] or None)
    return TestClient(create_app(settings))


@pytest.fixture(scope="module")
def api(live: dict[str, str]) -> Iterator[TestClient]:
    with _app(live) as client:
        yield client


def _sign_up(live: dict[str, str]) -> tuple[str, str]:
    r = httpx.post(f"{live['url']}/auth/v1/signup", headers={"apikey": live["anon"]},
                   json={"email": f"p3-{uuid.uuid4().hex[:10]}@test.local", "password": "password-123456"})
    r.raise_for_status()
    return r.json()["access_token"], r.json()["user"]["id"]


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _rest(live: dict[str, str], token: str, method: str, path: str, **kw: object) -> httpx.Response:
    return httpx.request(method, f"{live['url']}/rest/v1/{path}",
                         headers={"apikey": live["anon"], **_h(token), "Prefer": "return=representation"}, **kw)


def _user(live: dict[str, str], goal: str = "maintain") -> tuple[str, str]:
    token, user_id = _sign_up(live)
    assert _rest(live, token, "POST", "profiles", json={
        "user_id": user_id, "age": 30, "height_cm": 170, "weight_kg": 70, "gender": "female", "goal": goal,
        "activity_level": "moderate", "daily_target_kcal": 1}).status_code == 201
    return token, user_id


def _recommend(api: TestClient, token: str, **params: object) -> dict:
    r = api.get(URL, headers=_h(token), params={"meal_type": "lunch", "count": 5, "mode": "foods", "date": TODAY,
                                                **params})
    assert r.status_code == 200, r.text
    return r.json()


def test_recommendations_end_to_end(live: dict[str, str], api: TestClient) -> None:
    token, user_id = _user(live, goal="lose")
    assert _rest(live, token, "POST", "food_logs", json={
        "user_id": user_id, "logged_date": TODAY, "meal_type": "breakfast", "food_name": "Poha", "calories": 300,
        "carbs_g": 50, "fat_g": 8, "protein_g": 6}).status_code == 201

    data = _recommend(api, token)
    if data["status"] == "empty_catalogue":
        pytest.skip("catalogue is empty: load INDB first")
    assert data["status"] == "ok" and len(data["items"]) == 5 and data["budget"]["basis"] == "targets"
    for item in data["items"]:
        assert item["id"] and item["kind"] == "food"
        # Priced by the database for exactly these portions (the function logging uses).
        [portion] = item["portions"]
        [priced] = _rest(live, token, "POST", "rpc/food_portion", json={
            "p_food_id": portion["id"], "p_grams": portion["grams"]}).json()
        assert item["nutrition"]["kcal"] == round(priced["calories"])
    assert len(_rest(live, token, "GET", "food_logs?select=id").json()) == 1          # nothing logged
    assert len(_rest(live, token, "GET", "recommendation_items?select=id").json()) == 5

    # Another user cannot see or act on it (RLS).
    other, _ = _sign_up(live)
    first = data["items"][0]
    assert _rest(live, other, "GET", "recommendation_sets?select=id").json() == []
    assert api.get(f"{URL}/{first['id']}", headers=_h(other)).status_code == 404
    assert api.post(f"{URL}/{first['id']}/feedback", json={"action": "saved"}, headers=_h(other)).status_code == 404

    # Detail, adjusted servings, events.
    detail = api.get(f"{URL}/{first['id']}", headers=_h(token)).json()
    assert detail["item"]["nutrition"] == first["nutrition"]
    assert api.post(f"{URL}/{first['id']}/feedback", json={"action": "viewed"}, headers=_h(token)).status_code == 201
    assert api.post(f"{URL}/{first['id']}/feedback", json={"action": "saved"}, headers=_h(token)).status_code == 201
    saved = api.get("/v1/me/recommendation-feedback", params={"feedback": "saved"}, headers=_h(token)).json()
    assert [s["name"] for s in saved] == [first["name"]]
    events = _rest(live, token, "GET", "recommendation_events?select=event&order=created_at").json()
    assert [e["event"] for e in events] == ["viewed", "saved"]

    # A declared diet and an excluded ingredient are hard filters.
    assert api.put("/v1/me/preferences", headers=_h(token),
                   json={"diet": "vegetarian", "excluded_ingredients": ["paneer"]}).status_code == 200
    veg = _recommend(api, token)
    assert veg["items"] and all(set(i["data"]["diet_classes"]) <= {"vegan", "vegetarian"} for i in veg["items"])
    assert all("paneer" not in i["name"].lower() for i in veg["items"])
    assert {e["reason"] for e in veg["excluded"]} >= {"diet_conflict", "diet_unknown", "excluded_ingredient"}

    # "Never" removes an item until that feedback is deleted.
    top = veg["items"][0]
    fb = api.post(f"{URL}/{top['id']}/feedback", json={"action": "never"}, headers=_h(token)).json()["feedback"]
    assert top["key"] not in {i["key"] for i in _recommend(api, token)["items"]}
    assert api.delete(f"/v1/me/recommendation-feedback/{fb['id']}", headers=_h(token)).status_code == 204

    # Allergies: no allergen data is reviewed yet, so nothing can be recommended safely.
    assert api.patch("/v1/me/preferences", headers=_h(token), json={"allergies": ["milk"]}).status_code == 200
    allergic = _recommend(api, token)
    assert (allergic["status"], allergic["items"]) == ("insufficient_data", [])


def test_log_proposal_and_confirmation(live: dict[str, str], api: TestClient) -> None:
    if not live["writer"]:
        pytest.skip("set ASSISTANT_DATABASE_URL (local) to test proposals")
    token, _ = _user(live)
    data = _recommend(api, token, count=1)
    if not data["items"]:
        pytest.skip("catalogue is empty: load INDB first")
    item = data["items"][0]
    r = api.post(f"{URL}/{item['id']}/log-proposal", json={"meal_type": "lunch", "date": TODAY}, headers=_h(token))
    assert r.status_code == 201, r.text
    proposal = r.json()
    assert proposal["status"] == "pending"
    assert _rest(live, token, "GET", "food_logs?select=id").json() == []
    done = api.post(f"/v1/assistant/proposals/{proposal['id']}/confirm", json={}, headers=_h(token))
    assert done.status_code == 200, done.text
    [log] = _rest(live, token, "GET", "food_logs?select=food_id,source,calories,meal_type").json()
    assert log["food_id"] == item["portions"][0]["id"] and log["source"] == "catalogue"
    assert round(log["calories"]) == item["nutrition"]["kcal"]
    events = [e["event"] for e in _rest(live, token, "GET", "recommendation_events?select=event&order=created_at").json()]
    assert events == ["selected", "logged"]


@pytest.fixture
def published_recipe(live: dict[str, str]) -> Iterator[str]:
    """One published test recipe (local only), removed afterwards."""
    dsn = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    slug = f"p3-live-{uuid.uuid4().hex[:8]}"
    with psycopg.connect(dsn, autocommit=True) as conn:
        food = conn.execute("select id from public.foods where source = 'usda_fdc' and name ilike 'Toor dal%' "
                            "limit 1").fetchone()
        if food is None:
            pytest.skip("USDA staples are not loaded")
        rid = conn.execute(
            "insert into public.recipes (slug, name, servings, serving_label, source, source_name, prep_minutes, "
            "cook_minutes, equipment) values (%s, 'P3 live dal', 4, '1 katori', 'curated', 'test', 10, 30, "
            "array['stove','pressure_cooker']) returning id", (slug,)).fetchone()[0]
        for c in ("dal", "dinner", "north_indian"):
            conn.execute("insert into public.recipe_category_assignments values (%s, %s)", (rid, c))
        conn.execute("insert into public.recipe_ingredients (recipe_id, position, food_id, quantity, unit) "
                     "values (%s, 1, %s, 300, 'g')", (rid, food[0]))
        conn.execute("update public.recipes set instructions = array['Cook the dal.'] where id = %s", (rid,))
        conn.execute("select public.publish_recipe(%s, 'live test')", (rid,))
    try:
        yield str(rid)
    finally:
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute("delete from public.recommendation_items where recipe_id = %s", (rid,))
            conn.execute("delete from public.recipes where id = %s", (rid,))


def test_recipe_recommendations_from_the_database(live: dict[str, str], published_recipe: str) -> None:
    token, _ = _user(live)
    with _app(live) as api:                                   # fresh candidate cache
        r = api.get(URL, headers=_h(token), params={"meal_type": "dinner", "mode": "meals", "count": 5,
                                                    "date": TODAY, "target_kcal": 450})
        assert r.status_code == 200, r.text
        items = [i for i in r.json()["items"] if published_recipe in {p["id"] for p in i["portions"]}]
        assert items, r.json()
        item = items[0]
        servings = item["portions"][0]["servings"]
        priced = _rest(live, token, "POST", "rpc/recipe_portion",
                       json={"p_recipe_id": published_recipe, "p_portions": servings}).json()
        assert item["nutrition"]["kcal"] == round(priced["calories"])
        assert item["total_minutes"] == 40 and item["equipment"] == ["pressure_cooker", "stove"]
        detail = api.get(f"{URL}/{item['id']}", headers=_h(token)).json()
        assert detail["instructions"] == [["Cook the dal."]]
        # Equipment the user lacks removes it.
        api.put("/v1/me/preferences", headers=_h(token), json={"equipment": ["stove", "tawa"]})
        again = api.get(URL, headers=_h(token), params={"meal_type": "dinner", "mode": "meals", "date": TODAY,
                                                        "target_kcal": 450}).json()
        assert published_recipe not in {p["id"] for i in again["items"] for p in i["portions"]}


def test_light_options_when_over_target(live: dict[str, str], api: TestClient) -> None:
    token, user_id = _user(live)
    assert _rest(live, token, "POST", "food_logs", json={
        "user_id": user_id, "logged_date": TODAY, "meal_type": "lunch", "food_name": "Feast", "calories": 4000,
        "carbs_g": 400, "fat_g": 150, "protein_g": 150}).status_code == 201
    data = _recommend(api, token, meal_type="snack")
    if data["status"] == "empty_catalogue":
        pytest.skip("catalogue is empty: load INDB first")
    assert data["budget"]["mode"] == "light" and data["budget"]["kcal"] == 150
    assert any("over today's target" in n for n in data["notes"])
    assert all(i["nutrition"]["kcal"] <= 195 for i in data["items"])


def test_latency(live: dict[str, str], api: TestClient) -> None:
    """Warm-cache request latency on the local stack (reported, loosely bounded)."""
    token, _ = _user(live)
    _recommend(api, token)                                    # warm the candidate cache
    times = []
    for _ in range(5):
        t = time.perf_counter()
        _recommend(api, token)
        times.append(time.perf_counter() - t)
    times.sort()
    print(f"\nrecommendation latency (warm, local): median {times[2] * 1000:.0f} ms, max {times[-1] * 1000:.0f} ms")
    assert times[2] < 2.0


@pytest.fixture
def approved_template(live: dict[str, str]) -> Iterator[dict[str, str]]:
    """One approved test template (local only) built from real INDB foods, removed afterwards."""
    dsn = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    slug = f"p3-live-{uuid.uuid4().hex[:8]}"
    with psycopg.connect(dsn, autocommit=True) as conn:
        foods = dict(conn.execute("select source_ref, id::text from public.foods where source = 'indb' "
                                  "and source_ref in ('BFP044', 'ASC001')").fetchall())
        if len(foods) != 2:
            pytest.skip("INDB foods BFP044/ASC001 not loaded")
        tid = conn.execute("insert into public.meal_templates (slug, name, meal_types, regions) "
                           "values (%s, 'P3 live poha with tea', array['breakfast'], array['west_indian']) returning id",
                           (slug,)).fetchone()[0]
        conn.execute("insert into public.meal_template_components (template_id, position, slot, food_id, "
                     "default_servings, min_servings, max_servings, servings_step, optional) values "
                     "(%s, 1, 'main', %s, 2, 1, 2, 0.5, false), (%s, 2, 'drink', %s, 1, 1, 1, 1, true)",
                     (tid, foods["BFP044"], tid, foods["ASC001"]))
        conn.execute("update public.meal_templates set status = 'approved', approved_by = 'live test', "
                     "approved_at = now(), approval_level = 'provisional', "
                     "approval_note = 'live test: not individually verified' where id = %s", (tid,))
    try:
        yield {"template_id": str(tid), "poha": foods["BFP044"], "tea": foods["ASC001"]}
    finally:
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute("delete from public.recommendation_items where template_id = %s", (tid,))
            conn.execute("update public.meal_templates set status = 'retired' where id = %s", (tid,))
            conn.execute("delete from public.meal_template_components where template_id = %s", (tid,))
            conn.execute("delete from public.meal_templates where id = %s", (tid,))


def test_optional_template_components_from_the_database(live: dict[str, str], approved_template: dict[str, str]) -> None:
    token, _ = _user(live)
    with _app(live) as api:                                   # fresh candidate cache
        r = api.get(URL, headers=_h(token), params={"meal_type": "breakfast", "mode": "meals", "count": 5,
                                                    "date": TODAY, "target_kcal": 300, "tolerance": "flexible"})
        assert r.status_code == 200, r.text
        [item] = [i for i in r.json()["items"] if i["key"] == f"meal:{approved_template['template_id']}"]
        assert [p["id"] for p in item["portions"]] == [approved_template["poha"]]        # base meal only
        assert item["data"]["approval_level"] == "provisional"
        [tea] = item["optional_components"]
        assert tea["id"] == approved_template["tea"] and "density_assumed" in tea["quality_flags"]
        [priced] = _rest(live, token, "POST", "rpc/food_portion",
                         json={"p_food_id": tea["id"], "p_grams": tea["grams"]}).json()
        assert tea["nutrition"]["kcal"] == round(priced["calories"])
        detail = api.get(f"{URL}/{item['id']}", headers=_h(token), params={"optional": tea["id"]}).json()
        assert abs(detail["total_nutrition"]["kcal"] - (item["nutrition"]["kcal"] + tea["nutrition"]["kcal"])) <= 1
        # Excluding tea withholds the add-on; the base meal is still offered.
        api.put("/v1/me/preferences", headers=_h(token), json={"excluded_ingredients": ["tea"]})
        again = api.get(URL, headers=_h(token), params={"meal_type": "breakfast", "mode": "meals", "date": TODAY,
                                                        "target_kcal": 300, "tolerance": "flexible"}).json()
        [item2] = [i for i in again["items"] if i["key"] == item["key"]]
        assert item2["optional_components"] == []
        assert item2["optional_withheld"][0]["reason"] == "excluded_ingredient"
        assert api.get(f"{URL}/{item['id']}", headers=_h(token), params={"optional": tea["id"]}).status_code == 422
