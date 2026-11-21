"""Phase 2 Task 3: each tool, argument validation, limits and user scoping."""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import uuid
from collections.abc import Iterator
from typing import Any

import httpx
import jwt
import pytest

from app.assistant.tools.base import ToolContext, ToolRegistry
from app.assistant.tools.registry import default_registry
from app.assistant.preferences import PreferencesOut
from app.core.config import Settings
from app.core.security import AuthenticatedUser
from app.db.supabase import SupabaseRest
from app.llm.types import ToolCall
from tests.assistant_fakes import FakeNutritionDB, food, status_row

TODAY = dt.date(2026, 11, 20)
A = "aaaaaaaa-0000-0000-0000-00000000000a"
B = "bbbbbbbb-0000-0000-0000-00000000000b"


def user(uid: str) -> AuthenticatedUser:
    return AuthenticatedUser(user_id=uid, access_token=jwt.encode({"sub": uid}, "x" * 32, algorithm="HS256"))


@pytest.fixture
def db() -> FakeNutritionDB:
    d = FakeNutritionDB()
    d.user(A).status = status_row()
    d.user(A).profile = {"goal": "lose", "activity_level": "moderate"}
    d.user(A).logs = [
        {"logged_date": "2026-11-20", "meal_type": "lunch", "food_name": "Dal\x00 tadka", "calories": 250, "protein_g": 12,
         "carbs_g": 30, "fat_g": 8, "serving_g": 200, "source": "ai_assisted", "food_id": None},
        {"logged_date": "2026-11-19", "meal_type": "dinner", "food_name": "Roti", "calories": 240, "protein_g": 8,
         "carbs_g": 40, "fat_g": 6, "serving_g": 80, "source": "catalogue", "food_id": "f-roti"},
        {"logged_date": "2026-10-01", "meal_type": "lunch", "food_name": "Old", "calories": 100, "protein_g": 1,
         "carbs_g": 1, "fat_g": 1, "serving_g": None, "source": "manual", "food_id": None},
    ]
    d.user(B).status = status_row(consumed=9999)
    d.user(B).logs = [{"logged_date": "2026-11-20", "meal_type": "lunch", "food_name": "B's secret meal", "calories": 999,
                       "protein_g": 1, "carbs_g": 1, "fat_g": 1, "serving_g": None, "source": "manual", "food_id": None}]
    return d


@pytest.fixture
def run(settings: Settings, db: FakeNutritionDB) -> Iterator[Any]:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/rest/v1/rpc/"):
            return db.handle_rpc(request)
        return db.handle_rest(request)

    services: dict[str, Any] = {}

    def _run(name: str, args: dict[str, Any], uid: str = A, registry: ToolRegistry | None = None) -> Any:
        async def go() -> Any:
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
                ctx = ToolContext(user=user(uid), db=SupabaseRest(settings, http), settings=settings,
                                  local_date=TODAY, services=services)
                return await (registry or default_registry()).execute(ctx, ToolCall("c1", name, args), 0)
        return asyncio.run(go())

    yield _run


def test_registry_is_read_only_and_complete() -> None:
    names = default_registry().names
    assert set(names) == {"get_daily_status", "get_recent_food_logs", "search_foods", "get_user_targets",
                          "get_nutrition_history", "recommend_meals", "prepare_food_log"}
    reg = default_registry()
    assert reg.names_of_kind("proposal") == ("prepare_food_log",)
    assert set(reg.names_of_kind("read")) == set(names) - {"prepare_food_log"}
    assert not [n for n in names if any(w in n for w in ("sql", "update", "delete", "execute", "write", "confirm", "insert"))]
    def arg_names(schema: dict[str, Any]) -> set[str]:
        names = set(schema.get("properties", {}))
        for sub in schema.get("properties", {}).values():
            names |= arg_names(sub.get("items", {})) | arg_names(sub)
        return names

    for spec in default_registry().specs():
        assert spec.parameters["additionalProperties"] is False
        names_ = arg_names(spec.parameters)
        assert "user_id" not in names_
        assert not [n for n in names_ if any(w in n for w in ("sql", "table", "column", "function", "query_text", "filter"))]


# ---------------------------------------------------------------------------- get_daily_status

def test_daily_status(run: Any) -> None:
    ex = run("get_daily_status", {})
    assert ex.status == "ok"
    r = ex.content["result"]
    assert r["calories_kcal"] == {"consumed": 1200.0, "target": 2000.0, "remaining": 800.0}
    assert r["protein_g"] == {"consumed": 60.0, "target": 100.0, "remaining": 40.0}
    assert r["has_targets"] is True and r["entries_logged"] == 4


@pytest.mark.parametrize("args", [{"date": "2026-11-25"}, {"date": "2024-01-01"}, {"date": "yesterday"}, {"day": "2026-11-20"}])
def test_daily_status_rejects_bad_dates(run: Any, args: dict[str, Any]) -> None:
    assert run("get_daily_status", args).status == "invalid_arguments"


# ---------------------------------------------------------------------------- get_recent_food_logs

def test_recent_logs_default_range_and_scoping(run: Any, db: FakeNutritionDB) -> None:
    ex = run("get_recent_food_logs", {})
    r = ex.content["result"]
    assert (r["start_date"], r["end_date"]) == ("2026-11-14", "2026-11-20")
    assert [e["food_name"] for e in r["entries"]] == ["Dal  tadka", "Roti"]     # control chars removed; old entry outside range
    _, _, params = next(q for q in db.requests if q[1] == "GET:food_logs")
    assert params["user_id"] == f"eq.{A}" and params["limit"] == "21"


def test_recent_logs_filters_and_limit(run: Any) -> None:
    r = run("get_recent_food_logs", {"meal_type": "dinner", "limit": 1}).content["result"]
    assert [e["food_name"] for e in r["entries"]] == ["Roti"] and r["returned"] == 1
    r = run("get_recent_food_logs", {"limit": 1}).content["result"]
    assert r["more_available"] is True


@pytest.mark.parametrize("args", [
    {"start_date": "2026-09-01", "end_date": "2026-11-20"},     # > 31 days
    {"start_date": "2026-11-20", "end_date": "2026-11-10"},     # reversed
    {"end_date": "2026-12-01"},                                 # future
    {"limit": 51}, {"limit": 0}, {"meal_type": "brunch"},
    {"user_id": B},                                             # identity can't be passed in
])
def test_recent_logs_invalid_arguments(run: Any, args: dict[str, Any]) -> None:
    ex = run("get_recent_food_logs", args)
    assert ex.status == "invalid_arguments"
    assert B not in json.dumps(ex.content)                       # input values aren't echoed back


def test_cross_user_isolation(run: Any, db: FakeNutritionDB) -> None:
    a = run("get_recent_food_logs", {}, uid=A).content["result"]
    assert "B's secret meal" not in json.dumps(a)
    b = run("get_daily_status", {}, uid=B).content["result"]
    assert b["calories_kcal"]["consumed"] == 9999.0
    # Every database call is made with the caller's own token.
    for sub, _, _ in db.requests:
        assert sub in (A, B)
    assert {sub for sub, what, _ in db.requests if what == "GET:food_logs"} == {A}


# ---------------------------------------------------------------------------- search_foods

def test_search_foods(run: Any, db: FakeNutritionDB) -> None:
    db.search_rows = [{
        "food_id": str(uuid.uuid4()), "name": "Paneer butter masala", "brand": None, "category": "paneer_dish",
        "food_kind": "generic_dish", "source": "indb", "source_ref": "ASC222", "verification": "curated",
        "completeness": 1.0, "quality_flags": [], "basis": "g", "density_g_per_ml": None, "kcal_per_100": 180.5,
        "protein_g_per_100": 7.1, "carbs_g_per_100": 8.2, "fat_g_per_100": 13.4, "fiber_g_per_100": 1.1,
        "sugars_g_per_100": 3.0, "saturated_fat_g_per_100": 6.0, "sodium_g_per_100": 0.4, "match_type": "exact",
        "matched_text": "paneer butter masala", "name_score": 1.0, "score": 0.97, "portion_grams": None,
        "portion_kcal": None, "portion_carbs_g": None, "portion_fat_g": None, "portion_protein_g": None,
        "default_serving_label": "1 katori", "default_serving_g": 150}]
    r = run("search_foods", {"query": "  paneer   butter masala "}).content["result"]
    assert r["query"] == "paneer butter masala" and r["decision"] == "confident"
    top = r["results"][0]
    assert top["per_100"]["kcal"] == 180.5 and top["source"] == "indb" and top["default_serving"]["grams"] == 150
    _, _, body = next(q for q in db.requests if q[1] == "rpc:search_food_catalogue")
    assert body["p_query"] == "paneer butter masala" and body["p_limit"] == 5


@pytest.mark.parametrize("args", [{"query": "x"}, {"query": "a" * 81}, {"query": "dal", "limit": 11}, {}])
def test_search_foods_invalid(run: Any, args: dict[str, Any]) -> None:
    assert run("search_foods", args).status == "invalid_arguments"


# ---------------------------------------------------------------------------- get_user_targets

def test_user_targets_with_preferences(run: Any, db: FakeNutritionDB) -> None:
    db.user(A).prefs = {"diet": "vegetarian", "allergies": ["peanut"], "dislikes": ["karela"], "cuisines": [],
                        "meal_preferences": [], "notes": None, "updated_at": "2026-11-20T09:00:00+00:00"}
    r = run("get_user_targets", {}).content["result"]
    assert r["daily_targets"]["calories_kcal"] == 2000 and r["daily_targets"]["protein_pct"] == 20
    assert r["goal"] == "lose" and r["preferences"]["diet"] == "vegetarian"
    assert r["preferences"]["source"] == "user_entered"


def test_user_targets_without_targets(run: Any, db: FakeNutritionDB) -> None:
    db.user(A).status = status_row(target=None)
    r = run("get_user_targets", {}).content["result"]
    assert r["has_targets"] is False and "No profile targets are set yet." in r["notes"]


# ---------------------------------------------------------------------------- get_nutrition_history

def _totals(day: str, kcal: float, meal: str = "lunch") -> dict[str, Any]:
    return {"logged_date": day, "meal_type": meal, "calories": kcal, "carbs_g": 100, "fat_g": 30, "protein_g": 50,
            "entry_count": 2}


def test_history_aggregates_without_individual_records(run: Any, db: FakeNutritionDB) -> None:
    db.user(A).totals = [_totals("2026-11-18", 900), _totals("2026-11-18", 1000, "dinner"), _totals("2026-11-20", 2500)]
    r = run("get_nutrition_history", {"start_date": "2026-11-14", "end_date": "2026-11-20"}).content["result"]
    assert len(r["periods"]) == 7 and r["group_by"] == "day"
    o = r["overall"]
    assert o["days_logged"] == 2 and o["avg_kcal_per_logged_day"] == 2200.0
    assert o["logged_days_within_10pct_of_target"] == 1      # 1900 is within 10% of 2000; 2500 isn't
    assert o["highest_day"] == {"date": "2026-11-20", "kcal": 2500.0}
    assert "food_name" not in json.dumps(r)
    _, _, body = next(q for q in db.requests if q[1] == "rpc:get_daily_totals")
    assert body == {"p_start": "2026-11-14", "p_end": "2026-11-20"}


def test_history_long_ranges_are_weekly(run: Any) -> None:
    r = run("get_nutrition_history", {"start_date": "2026-09-01", "end_date": "2026-11-20"}).content["result"]
    assert r["group_by"] == "week" and len(r["periods"]) == 12


@pytest.mark.parametrize("args", [{"start_date": "2026-08-01", "end_date": "2026-11-20"}, {"group_by": "month"}])
def test_history_limits(run: Any, args: dict[str, Any]) -> None:
    assert run("get_nutrition_history", args).status == "invalid_arguments"


# ---------------------------------------------------------------------------- recommend_meals

@pytest.fixture
def catalogue(db: FakeNutritionDB) -> FakeNutritionDB:
    db.foods = [
        food("Paneer tikka", "paneer_dish", 250, 18, serving_g=150),
        food("Chicken curry", "non_veg", 180, 20, serving_g=200),
        food("Egg bhurji", "egg_dish", 200, 13, serving_g=120),
        food("Moong dal", "dal", 110, 7, serving_g=180),
        food("Peanut chikki", "sweet", 520, 15, serving_g=40),
        food("Karela sabzi", "sabzi", 90, 2, serving_g=150),
        food("Veg pulao", "rice_dish", 160, 4, serving_g=200),
        food("Gulab jamun", "sweet", 380, 5, serving_g=60),
    ]
    db.user(A).logs.append({"logged_date": "2026-11-18", "meal_type": "lunch", "food_name": "Moong dal", "calories": 1,
                            "protein_g": 1, "carbs_g": 1, "fat_g": 1, "serving_g": 1, "source": "catalogue",
                            "food_id": db.foods[3]["id"]})
    return db


def test_recommendations_are_deterministic_and_priced_by_the_database(run: Any, catalogue: FakeNutritionDB) -> None:
    first = run("recommend_meals", {"meal_type": "lunch", "count": 3}).content["result"]
    second = run("recommend_meals", {"meal_type": "lunch", "count": 3}).content["result"]
    assert first == second
    assert first["engine_version"] == "rec-v2" and first["data_source"] == "recommendation_engine"
    assert first["meal_target"]["calories_kcal"] == 700          # 35% of 2000, under the 800 remaining
    assert 1 <= len(first["recommendations"]) <= 3
    # Every number shown was priced by the database for the chosen portion.
    priced = {(b["p_food_id"], b["p_grams"]) for _, what, b in catalogue.requests if what == "rpc:food_portion"}
    for r in first["recommendations"]:
        [portion] = r["portions"]
        assert (r["food_id"], portion["grams"]) in priced
        assert r["fit"] in ("strong", "good", "fair") and r["reasons"]


def test_recommendations_are_read_only(run: Any, catalogue: FakeNutritionDB) -> None:
    run("recommend_meals", {"meal_type": "lunch"})
    assert not [w for _, what, _ in catalogue.requests for w in [what]
                if w.startswith(("POST:", "PATCH:", "DELETE:", "PUT:"))]


def test_recommendations_apply_hard_exclusions(run: Any, catalogue: FakeNutritionDB) -> None:
    catalogue.user(A).prefs = {"diet": "vegetarian", "allergies": [], "dislikes": [], "excluded_ingredients": ["karela"],
                               "cuisines": [], "meal_preferences": [], "notes": None, "updated_at": None}
    r = run("recommend_meals", {"meal_type": "lunch", "count": 5}).content["result"]
    names = {x["name"] for x in r["recommendations"]}
    assert not names & {"Chicken curry", "Egg bhurji", "Karela sabzi"}
    reasons = {e["reason"] for e in r["excluded"]}
    assert {"diet_conflict", "excluded_ingredient"} <= reasons


def test_unverified_allergens_mean_no_recommendations(run: Any, catalogue: FakeNutritionDB) -> None:
    catalogue.user(A).prefs = {"diet": None, "allergies": ["peanut"], "dislikes": [], "cuisines": [],
                               "meal_preferences": [], "notes": None, "updated_at": None}
    r = run("recommend_meals", {"meal_type": "lunch"}).content["result"]
    assert (r["status"], r["recommendations"]) == ("insufficient_data", [])
    assert any("reviewed allergen information" in n for n in r["notes"])


def test_recommendations_when_target_is_used_up(run: Any, catalogue: FakeNutritionDB) -> None:
    catalogue.user(A).status = status_row(consumed=1950)
    r = run("recommend_meals", {"meal_type": "dinner"}).content["result"]
    assert r["meal_target"]["calories_kcal"] == 150
    assert all(x["nutrition"]["calories_kcal"] <= 195 for x in r["recommendations"])
    assert any("light options" in n for n in r["notes"])


def test_recommendations_without_targets_say_so(run: Any, catalogue: FakeNutritionDB) -> None:
    catalogue.user(A).status = status_row(target=None)
    r = run("recommend_meals", {"meal_type": "breakfast"}).content["result"]
    assert r["meal_target"]["basis"] == "assumed"
    assert any("assumes a 2,000 kcal day" in n for n in r["notes"])


@pytest.mark.parametrize("args", [{}, {"meal_type": "brunch"}, {"meal_type": "lunch", "count": 6},
                                  {"meal_type": "lunch", "user_id": "x"}, {"meal_type": "lunch", "max_kcal": 10}])
def test_recommend_invalid(run: Any, args: dict[str, Any]) -> None:
    assert run("recommend_meals", args).status == "invalid_arguments"


# ---------------------------------------------------------------------------- registry protections

def test_unknown_tool(run: Any) -> None:
    ex = run("execute_sql", {"query": "select * from food_logs"})
    assert ex.status == "unknown_tool" and "get_daily_status" in ex.content["error"]["message"]


def test_tool_timeout(run: Any, settings: Settings) -> None:
    from pydantic import BaseModel, ConfigDict

    from app.assistant.tools.base import Tool

    class NoArgs(BaseModel):
        model_config = ConfigDict(extra="forbid")

    async def slow(ctx: ToolContext, _: Any) -> Any:
        await asyncio.sleep(5)

    s = settings.model_copy(update={"assistant_tool_timeout_seconds": 0.05})
    reg = ToolRegistry([Tool("slow", "d", NoArgs, NoArgs, slow)])

    async def go() -> Any:
        async with httpx.AsyncClient() as http:
            ctx = ToolContext(user=user(A), db=SupabaseRest(s, http), settings=s)
            return await reg.execute(ctx, ToolCall("c", "slow", {}), 0)
    assert asyncio.run(go()).status == "timeout"


def test_oversized_results_are_refused(run: Any, settings: Settings, db: FakeNutritionDB) -> None:
    db.user(A).logs = [{"logged_date": "2026-11-20", "meal_type": "lunch", "food_name": "x" * 120, "calories": 1,
                        "protein_g": 1, "carbs_g": 1, "fat_g": 1, "serving_g": 1, "source": "manual", "food_id": None}] * 50
    ex = run("get_recent_food_logs", {"limit": 50})
    assert ex.status == "limit_exceeded" and ex.content["error"]["code"] == "result_too_large"


def test_tool_crash_is_contained(settings: Settings) -> None:
    from pydantic import BaseModel, ConfigDict

    from app.assistant.tools.base import Tool

    class NoArgs(BaseModel):
        model_config = ConfigDict(extra="forbid")

    async def boom(ctx: ToolContext, _: Any) -> Any:
        raise RuntimeError("secret internal detail")

    reg = ToolRegistry([Tool("boom", "d", NoArgs, NoArgs, boom)])

    async def go() -> Any:
        async with httpx.AsyncClient() as http:
            ctx = ToolContext(user=user(A), db=SupabaseRest(settings, http), settings=settings)
            return await reg.execute(ctx, ToolCall("c", "boom", {}), 0)
    ex = asyncio.run(go())
    assert ex.status == "error" and "secret internal detail" not in json.dumps(ex.content)


def test_tool_reference_is_up_to_date() -> None:
    from pathlib import Path

    from app.assistant.tools.registry import tools_markdown

    doc = Path(__file__).resolve().parents[1] / "docs" / "assistant-tools.md"
    assert doc.read_text(encoding="utf-8") == tools_markdown(), "run: python -m app.cli assistant-tools-doc"


def test_recommendations_skip_foods_with_unreliable_values(run: Any, catalogue: FakeNutritionDB) -> None:
    catalogue.foods.append({**food("Medu vada", "dal", 745, 4, 79), "quality_flags": ["cooking_oil_uncertain"]})
    catalogue.foods.append({**food("Odd soup", "dal", 100, 30, 150), "quality_flags": ["energy_mismatch"]})
    r = run("recommend_meals", {"meal_type": "lunch", "count": 5}).content["result"]
    names = {x["name"] for x in r["recommendations"]}
    assert "Medu vada" not in names and "Odd soup" not in names


def test_recent_logs_include_per_day_totals(run: Any) -> None:
    r = run("get_recent_food_logs", {}).content["result"]
    assert r["totals_by_date"] == [
        {"date": "2026-11-20", "calories_kcal": 250.0, "protein_g": 12.0, "carbs_g": 30.0, "fat_g": 8.0, "entries": 1},
        {"date": "2026-11-19", "calories_kcal": 240.0, "protein_g": 8.0, "carbs_g": 40.0, "fat_g": 6.0, "entries": 1},
    ]
