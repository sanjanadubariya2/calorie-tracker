"""/v1/foods: matching decisions, schema guarantees, delegation to the RPC."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.schemas.foods import FoodCandidate
from app.services.catalogue import matching
from tests.conftest import FakeSupabase


def _row(name: str, score: float, **overrides: Any) -> dict[str, Any]:
    row = {
        "food_id": str(uuid.uuid4()), "name": name, "brand": None, "category": "paneer_dish",
        "food_kind": "generic_dish", "source": "indb", "source_ref": "ASC222", "verification": "curated",
        "completeness": 1.0, "quality_flags": [], "basis": "g", "density_g_per_ml": None,
        "kcal_per_100": 210, "protein_g_per_100": 8.1, "carbs_g_per_100": 7.2, "fat_g_per_100": 16.3,
        "fiber_g_per_100": 1.0, "sugars_g_per_100": 2.1, "saturated_fat_g_per_100": 9.5, "sodium_g_per_100": 0.4,
        "match_type": "alias", "matched_text": "paneer butter masala", "name_score": 0.95, "score": score,
        "portion_grams": 200, "portion_kcal": 420, "portion_carbs_g": 14.4, "portion_fat_g": 32.6,
        "portion_protein_g": 16.2, "default_serving_label": "1 bowl", "default_serving_g": 180,
    }
    row.update(overrides)
    return row


def _auth(make_token: Callable[..., str]) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token()}"}


# ------------------------------------------------------------------ decisions

def test_decide_bands() -> None:
    m = matching.row_to_match
    assert matching.decide([m(_row("A", 0.92)), m(_row("B", 0.70))]) == "confident"
    assert matching.decide([m(_row("A", 0.92)), m(_row("B", 0.88))]) == "ambiguous"   # too close
    assert matching.decide([m(_row("A", 0.70))]) == "ambiguous"
    assert matching.decide([m(_row("A", 0.40))]) == "no_match"
    assert matching.decide([]) == "no_match"


def test_portion_warnings() -> None:
    big = FoodCandidate(food_name="paneer", estimated_quantity_g=1500)
    assert matching.portion_warnings(big, [matching.row_to_match(_row("A", 0.9, portion_grams=1500))]) == ["portion_check"]
    ml = FoodCandidate(food_name="roti", estimated_quantity_ml=100)
    no_portion = matching.row_to_match(_row("A", 0.9, portion_kcal=None, portion_grams=None))
    assert matching.portion_warnings(ml, [no_portion]) == ["unit_conversion_unavailable"]


# ------------------------------------------------------------------ the AI-candidate schema

@pytest.mark.parametrize("extra", [
    {"calories": 500}, {"kcal": 500}, {"nutrients_per_100g": {"kcal": 1}}, {"protein_g": 10}, {"user_id": "x"},
])
def test_candidate_rejects_nutrition_and_unknown_fields(client: TestClient, make_token: Callable[..., str],
                                                       fake_supabase: FakeSupabase, extra: dict[str, Any]) -> None:
    body = {"candidates": [{"food_name": "Paneer Butter Masala", "estimated_quantity_g": 200, **extra}]}
    response = client.post("/v1/foods/match", json=body, headers=_auth(make_token))
    assert response.status_code == 422
    assert fake_supabase.rpc_requests == []


@pytest.mark.parametrize("candidate", [
    {"food_name": ""}, {"food_name": "x" * 121}, {"food_name": "roti", "estimated_quantity_g": 0},
    {"food_name": "roti", "estimated_quantity_g": 6000},
    {"food_name": "roti", "estimated_quantity_g": 50, "estimated_quantity_ml": 50},
])
def test_candidate_bounds(client: TestClient, make_token: Callable[..., str], candidate: dict[str, Any]) -> None:
    assert client.post("/v1/foods/match", json={"candidates": [candidate]}, headers=_auth(make_token)).status_code == 422


def test_batch_limit(client: TestClient, make_token: Callable[..., str]) -> None:
    body = {"candidates": [{"food_name": "roti"}] * 11}
    assert client.post("/v1/foods/match", json=body, headers=_auth(make_token)).status_code == 422


# ------------------------------------------------------------------ endpoint

def test_match_example_from_the_brief(client: TestClient, make_token: Callable[..., str], fake_supabase: FakeSupabase) -> None:
    fake_supabase.rpc_handler = lambda _r: httpx.Response(200, json=[
        _row("Paneer in butter sauce", 0.92), _row("Paneer makhana korma", 0.6, source_ref="ASC225"),
    ])
    token = make_token()
    response = client.post("/v1/foods/match", headers={"Authorization": f"Bearer {token}"}, json={
        "candidates": [{"food_name": "Paneer Butter Masala", "brand": None, "estimated_quantity_g": 200}]})
    assert response.status_code == 200
    [result] = response.json()["results"]
    assert result["decision"] == "confident"
    assert result["needs_user_confirmation"] is True
    top = result["candidates"][0]
    assert (top["source"], top["source_ref"], top["confidence"]) == ("indb", "ASC222", 0.92)
    assert top["per_100"]["kcal"] == 210 and top["portion"] == {
        "grams": 200, "kcal": 420, "protein_g": 16.2, "carbs_g": 14.4, "fat_g": 32.6}

    [rpc] = fake_supabase.rpc_requests
    assert rpc.url.path == "/rest/v1/rpc/search_food_catalogue"
    assert rpc.headers["authorization"] == f"Bearer {token}"          # runs as the user
    assert json.loads(rpc.content) == {"p_query": "Paneer Butter Masala", "p_brand": None, "p_quantity": 200.0,
                                       "p_unit": "g", "p_limit": 6}


def test_low_scores_are_no_match_with_weak_candidates_dropped(client: TestClient, make_token: Callable[..., str],
                                                              fake_supabase: FakeSupabase) -> None:
    fake_supabase.rpc_handler = lambda _r: httpx.Response(200, json=[_row("Jal jeera", 0.40), _row("Junk", 0.2)])
    [result] = client.post("/v1/foods/match", json={"candidates": [{"food_name": "jalebi"}]},
                           headers=_auth(make_token)).json()["results"]
    assert result["decision"] == "no_match"
    assert [c["name"] for c in result["candidates"]] == ["Jal jeera"]   # below 0.35 dropped


def test_ml_quantity_is_forwarded_as_ml(client: TestClient, make_token: Callable[..., str], fake_supabase: FakeSupabase) -> None:
    fake_supabase.rpc_handler = lambda _r: httpx.Response(200, json=[])
    client.post("/v1/foods/match", json={"candidates": [{"food_name": "lassi", "estimated_quantity_ml": 250}]},
                headers=_auth(make_token))
    body = json.loads(fake_supabase.rpc_requests[0].content)
    assert (body["p_quantity"], body["p_unit"]) == (250.0, "ml")


def test_match_requires_auth(client: TestClient) -> None:
    assert client.post("/v1/foods/match", json={"candidates": [{"food_name": "roti"}]}).status_code == 401


def test_search(client: TestClient, make_token: Callable[..., str], fake_supabase: FakeSupabase) -> None:
    fake_supabase.rpc_handler = lambda _r: httpx.Response(200, json=[_row("Chapati/Roti", 0.97)])
    response = client.get("/v1/foods/search?q=roti&limit=5", headers=_auth(make_token))
    assert response.status_code == 200 and response.json()[0]["name"] == "Chapati/Roti"
    assert json.loads(fake_supabase.rpc_requests[0].content)["p_limit"] == 5


def test_food_detail_and_404(client: TestClient, make_token: Callable[..., str], fake_supabase: FakeSupabase) -> None:
    food_id = str(uuid.uuid4())
    detail = {k: v for k, v in _row("Idli", 1).items() if k.endswith("_per_100") or k in ("basis", "density_g_per_ml")}
    detail.update({"id": food_id, "name": "Idli", "brand": None, "category": "south_indian", "food_kind": "generic_dish",
                   "source": "indb", "source_ref": "ASC144", "source_version": "2024.11", "salt_g_per_100": 1.0,
                   "micronutrients": {"iron_mg": 0.6}, "completeness": 1, "quality_flags": [], "verification": "curated",
                   "is_matchable": True, "food_aliases": [{"alias": "idly", "kind": "misspelling"}],
                   "food_servings": [{"label": "1 piece", "grams": 40, "is_default": True}]})
    fake_supabase.rest_handler = lambda r: httpx.Response(200, json=[detail] if food_id in str(r.url) else [])
    body = client.get(f"/v1/foods/{food_id}", headers=_auth(make_token)).json()
    assert body["aliases"] == [{"alias": "idly", "kind": "misspelling"}]
    assert body["servings"] == [{"label": "1 piece", "grams": 40.0}]
    assert client.get(f"/v1/foods/{uuid.uuid4()}", headers=_auth(make_token)).status_code == 404


# ------------------------------------------------------------------ OFF import

def test_import_disabled_without_catalogue_credentials(client: TestClient, make_token: Callable[..., str]) -> None:
    response = client.post("/v1/foods/import/off/8904004400262", headers=_auth(make_token))
    assert response.status_code == 503


@pytest.mark.parametrize("barcode", ["abc", "123", "1" * 15])
def test_import_validates_barcode(client: TestClient, make_token: Callable[..., str], barcode: str) -> None:
    assert client.post(f"/v1/foods/import/off/{barcode}", headers=_auth(make_token)).status_code == 422


def test_import_fetches_server_side_and_rate_limits(settings, fake_supabase: FakeSupabase,
                                                    make_token: Callable[..., str], monkeypatch: pytest.MonkeyPatch) -> None:
    from app.main import create_app
    from app.services.catalogue import importer

    settings = settings.model_copy(update={"catalogue_database_url": SecretStr("postgresql://unused"), "off_imports_per_user_per_hour": 2})
    written: list[Any] = []
    monkeypatch.setattr(importer, "_write_one", lambda url, rec: (written.append(rec) or (str(uuid.uuid4()), True)))
    fake_supabase.off_handler = lambda r: httpx.Response(200, json={"status": 1, "product": {
        "product_name": "Aloo Bhujia", "brands": "Haldiram's",
        "nutriments": {"energy-kcal_100g": 589, "proteins_100g": 11, "carbohydrates_100g": 41, "fat_100g": 41}}})

    with TestClient(create_app(settings, transport=httpx.MockTransport(fake_supabase.handle))) as c:
        headers = {"Authorization": f"Bearer {make_token('11111111-1111-1111-1111-111111111111')}"}
        first = c.post("/v1/foods/import/off/8904004400262", headers=headers)
        assert first.status_code == 200 and first.json()["name"] == "Aloo Bhujia"
        off_calls = [r for r in fake_supabase.requests if r.url.host == "world.openfoodfacts.org"]
        assert off_calls and "Authorization" not in off_calls[0].headers   # no user token sent to OFF
        assert written[0].kcal_per_100 == 589                                # values from OFF, not the client
        c.post("/v1/foods/import/off/8904004400262", headers=headers)
        assert c.post("/v1/foods/import/off/8904004400262", headers=headers).status_code == 429


def test_import_unknown_product_and_incomplete_product(settings, fake_supabase: FakeSupabase,
                                                       make_token: Callable[..., str]) -> None:
    from app.main import create_app

    settings = settings.model_copy(update={"catalogue_database_url": SecretStr("postgresql://unused")})
    with TestClient(create_app(settings, transport=httpx.MockTransport(fake_supabase.handle))) as c:
        h = {"Authorization": f"Bearer {make_token()}"}
        fake_supabase.off_handler = lambda r: httpx.Response(200, json={"status": 0})
        assert c.post("/v1/foods/import/off/1234567", headers=h).status_code == 404
        fake_supabase.off_handler = lambda r: httpx.Response(200, json={"status": 1, "product": {
            "product_name": "Mystery", "nutriments": {"energy-kcal_100g": 100}}})
        assert c.post("/v1/foods/import/off/1234567", headers=h).status_code == 422
        fake_supabase.off_handler = lambda r: httpx.Response(503, text="down")
        assert c.post("/v1/foods/import/off/1234567", headers=h).status_code == 502
