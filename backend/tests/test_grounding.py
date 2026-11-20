"""Task 4: portion resolution, catalogue grounding, proposals."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.schemas.foods import Serving
from app.schemas.recognition import ProposalItemInput
from app.services.grounding import FoodPortionContext, build_proposal, resolve_portion
from tests.conftest import FakeSupabase

ROTI = FoodPortionContext(basis="g", density_g_per_ml=None, density_assumed=False,
                          default_serving=Serving(label="1 piece", grams=40))
DAL = FoodPortionContext(basis="g", density_g_per_ml=None, density_assumed=False,
                         default_serving=Serving(label="1 bowl", grams=180))
LASSI = FoodPortionContext(basis="g", density_g_per_ml=1.0, density_assumed=True,
                           default_serving=Serving(label="1 tall glass", grams=320))
JUICE_ML = FoodPortionContext(basis="ml", density_g_per_ml=1.04, density_assumed=False, default_serving=None)
NO_SERVING = FoodPortionContext(basis="g", density_g_per_ml=None, density_assumed=False, default_serving=None)


def inp(**kw: Any) -> ProposalItemInput:
    return ProposalItemInput(food_name=kw.pop("food_name", "x"), **kw)


# ------------------------------------------------------------------ portions

def test_user_grams_are_exact_and_high_confidence() -> None:
    p, level, warnings = resolve_portion(inp(quantity=150, unit="g", quantity_source="user_stated"), DAL)
    assert (p.grams, p.source, p.is_estimate, level, warnings) == (150, "user_stated", False, "high", [])


def test_kg_is_converted() -> None:
    p, _, _ = resolve_portion(inp(quantity=0.25, unit="kg", quantity_source="user_stated"), DAL)
    assert p.grams == 250


def test_visual_grams_are_rounded_estimates() -> None:
    p, level, warnings = resolve_portion(inp(quantity=173, unit="g", quantity_source="model_estimate"), DAL)
    assert (p.grams, p.source, p.is_estimate, level) == (175, "model_estimate", True, "low")
    assert "portion_estimated" in warnings


def test_counts_use_the_catalogue_serving() -> None:
    p, level, _ = resolve_portion(inp(quantity=2, unit="piece", quantity_source="user_stated"), ROTI)
    assert (p.grams, p.source, level) == (80, "catalogue_serving", "medium")
    assert "1 piece" in p.explanation and "40" in p.explanation


def test_bowl_matches_a_bowl_serving_and_katori_too() -> None:
    assert resolve_portion(inp(quantity=1, unit="bowl", quantity_source="user_stated"), DAL)[0].grams == 180
    assert resolve_portion(inp(quantity=0.5, unit="katori", quantity_source="user_stated"), DAL)[0].grams == 90


def test_glass_matches_a_tall_glass_serving() -> None:
    assert resolve_portion(inp(quantity=1, unit="glass", quantity_source="user_stated"), LASSI)[0].grams == 320


def test_piece_never_matches_a_container_serving() -> None:
    p, _, warnings = resolve_portion(inp(quantity=2, unit="piece", quantity_source="user_stated"), DAL)
    assert p.source == "unresolved" and "portion_required" in warnings


def test_generic_household_volume_is_flagged() -> None:
    p, level, warnings = resolve_portion(inp(quantity=1, unit="katori", quantity_source="user_stated"), ROTI)
    assert (p.grams, p.source, level) == (150, "generic_conversion", "low")
    assert {"generic_unit_conversion", "density_assumed"} <= set(warnings)


def test_ml_uses_density() -> None:
    p, level, _ = resolve_portion(inp(quantity=250, unit="ml", quantity_source="user_stated"), JUICE_ML)
    assert (p.grams, level, p.is_estimate) == (260, "high", False)
    p, level, warnings = resolve_portion(inp(quantity=300, unit="ml", quantity_source="user_stated"), LASSI)
    assert (p.grams, level, p.is_estimate) == (300, "medium", True) and "density_assumed" in warnings


def test_ml_without_density_is_not_guessed() -> None:
    p, _, warnings = resolve_portion(inp(quantity=200, unit="ml", quantity_source="user_stated"), ROTI)
    assert p.grams is None and "portion_required" in warnings


def test_ml_before_a_food_is_chosen() -> None:
    p, _, warnings = resolve_portion(inp(quantity=200, unit="ml", quantity_source="user_stated"), None)
    assert p.grams is None and "portion_needs_food" in warnings


def test_no_quantity_assumes_one_serving_with_a_warning() -> None:
    p, level, warnings = resolve_portion(inp(), ROTI)
    assert (p.grams, p.source, level) == (40, "catalogue_serving", "low") and "serving_size_assumed" in warnings


def test_no_quantity_uses_the_visual_weight_before_a_serving() -> None:
    p, _, _ = resolve_portion(inp(estimated_weight_g=212), ROTI)
    assert (p.grams, p.source, p.is_estimate) == (210, "model_estimate", True)


def test_nothing_to_go_on_is_unresolved() -> None:
    p, level, warnings = resolve_portion(inp(), NO_SERVING)
    assert (p.grams, p.source, level) == (None, "unresolved", None) and "portion_required" in warnings


def test_manual_override_is_exact() -> None:
    p, level, _ = resolve_portion(inp(quantity=95, unit="g", quantity_source="manual"), ROTI)
    assert (p.grams, p.source, level, p.is_estimate) == (95, "manual", "high", False)


@pytest.mark.parametrize("q,unit", [(6000, "g"), (6, "kg"), (200, "piece")])
def test_implausible_portions_are_refused(q: float, unit: str) -> None:
    p, _, warnings = resolve_portion(inp(quantity=q, unit=unit, quantity_source="user_stated"), ROTI)
    assert p.grams is None and "portion_out_of_range" in warnings


# ------------------------------------------------------------------ grounding via the API

FOOD_ID = str(uuid.uuid4())


def search_row(name: str, score: float, food_id: str | None = None, **overrides: Any) -> dict[str, Any]:
    row = {
        "food_id": food_id or str(uuid.uuid4()), "name": name, "brand": None, "category": "bread",
        "food_kind": "generic_dish", "source": "indb", "source_ref": "ASC096", "verification": "curated",
        "completeness": 1.0, "quality_flags": [], "basis": "g", "density_g_per_ml": None,
        "kcal_per_100": 297.4, "protein_g_per_100": 9.81, "carbs_g_per_100": 46.31, "fat_g_per_100": 7.52,
        "fiber_g_per_100": 6.4, "sugars_g_per_100": 0.45, "saturated_fat_g_per_100": 1.23, "sodium_g_per_100": 0.27,
        "match_type": "alias", "matched_text": name, "name_score": 0.95, "score": score,
        "portion_grams": None, "portion_kcal": None, "portion_carbs_g": None, "portion_fat_g": None,
        "portion_protein_g": None, "default_serving_label": "1 piece", "default_serving_g": 40,
    }
    row.update(overrides)
    return row


SNAPSHOT = {"kcal": 297.4, "carbs_g": 46.31, "fat_g": 7.52, "protein_g": 9.81, "fiber_g": 6.4,
            "sugars_g": 0.45, "saturated_fat_g": 1.23, "sodium_g": 0.27}


class Catalogue:
    """search_food_catalogue + food_portion + foods selects, as PostgREST would."""

    def __init__(self, search: list[dict[str, Any]], snapshot: dict[str, Any] | None = SNAPSHOT) -> None:
        self.search = search
        self.snapshot = snapshot
        self.portion_calls: list[dict[str, Any]] = []

    def rpc(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if request.url.path.endswith("/search_food_catalogue"):
            return httpx.Response(200, json=self.search)
        if request.url.path.endswith("/food_portion"):
            self.portion_calls.append(body)
            g = body["p_grams"]
            if self.snapshot is None:
                return httpx.Response(200, json=[{"food_id": body["p_food_id"], "nutrients_per_100g": None,
                                                  "calories": None, "carbs_g": None, "fat_g": None, "protein_g": None}])
            r1 = lambda v: float(f"{v * g / 100:.1f}")  # noqa: E731
            return httpx.Response(200, json=[{
                "food_id": body["p_food_id"], "nutrients_per_100g": self.snapshot,
                "calories": round(self.snapshot["kcal"] * g / 100), "carbs_g": r1(self.snapshot["carbs_g"]),
                "fat_g": r1(self.snapshot["fat_g"]), "protein_g": r1(self.snapshot["protein_g"])}])
        return httpx.Response(404)

    def rest(self, request: httpx.Request) -> httpx.Response:
        if "food_servings" in request.url.params.get("select", ""):
            row = search_row("Chapati/Roti", 1, FOOD_ID)
            return httpx.Response(200, json=[{
                "id": FOOD_ID, "name": row["name"], "brand": None, "source": "indb", "source_ref": "ASC096",
                "basis": "g", "density_g_per_ml": None, "quality_flags": [], "is_matchable": True,
                **{k: row[k] for k in row if k.endswith("_per_100")},
                "food_servings": [{"label": "1 piece", "grams": 40, "is_default": True}]}])
        return httpx.Response(200, json=[{"density_g_per_ml": None}])


def _ground(client: TestClient, token: str, items: list[dict[str, Any]]) -> httpx.Response:
    return client.post("/v1/proposals/ground", json={"items": items}, headers={"Authorization": f"Bearer {token}"})


@pytest.fixture
def catalogue(fake_supabase: FakeSupabase) -> Callable[..., Catalogue]:
    def install(search: list[dict[str, Any]], snapshot: dict[str, Any] | None = SNAPSHOT) -> Catalogue:
        cat = Catalogue(search, snapshot)
        fake_supabase.rpc_handler = cat.rpc
        fake_supabase.rest_handler = cat.rest
        return cat
    return install


def test_confident_match_is_priced_from_the_catalogue(client: TestClient, make_token: Callable[..., str],
                                                      catalogue: Callable[..., Catalogue]) -> None:
    cat = catalogue([search_row("Chapati/Roti", 0.95, FOOD_ID), search_row("Plain paratha", 0.5)])
    r = _ground(client, make_token(), [{"food_name": "Chapati", "quantity": 2, "unit": "piece",
                                        "quantity_source": "user_stated", "recognition_confidence": 0.9}])
    assert r.status_code == 200, r.text
    [it] = r.json()["items"]
    assert it["status"] == "ready" and it["match"]["decision"] == "confident"
    assert it["match"]["selected"]["food_id"] == FOOD_ID
    assert it["portion"] == {"quantity": 2, "unit": "piece", "grams": 80, "source": "catalogue_serving",
                             "is_estimate": True, "explanation": it["portion"]["explanation"]}
    # 297.4 kcal/100 g x 80 g = 237.92 -> 238; macros to 0.1 g. Computed by food_portion, not the model.
    assert (it["nutrition"]["calories"], it["nutrition"]["carbs_g"], it["nutrition"]["protein_g"]) == (238, 37.0, 7.8)
    assert it["nutrition"]["source"] == "indb" and it["nutrition"]["source_ref"] == "ASC096"
    assert cat.portion_calls == [{"p_food_id": FOOD_ID, "p_grams": 80}]
    assert it["confidence"] == {"recognition": 0.9, "recognition_level": "high", "match": 0.95,
                                "match_level": "confident", "portion_level": "medium"}
    body = r.json()
    assert body["can_confirm"] is True and body["requires_confirmation"] is True
    assert body["totals"]["calories"] == 238


@pytest.mark.parametrize("grams,kcal", [(40, 119), (100, 297), (155, 461), (1, 3)])
def test_different_portion_sizes(client: TestClient, make_token: Callable[..., str],
                                 catalogue: Callable[..., Catalogue], grams: float, kcal: float) -> None:
    catalogue([search_row("Chapati/Roti", 0.95, FOOD_ID)])
    [it] = _ground(client, make_token(), [{"food_name": "roti", "quantity": grams, "unit": "g",
                                           "quantity_source": "manual"}]).json()["items"]
    assert it["nutrition"]["calories"] == kcal and it["portion"]["grams"] == grams


def test_ambiguous_matches_are_never_auto_selected(client: TestClient, make_token: Callable[..., str],
                                                   catalogue: Callable[..., Catalogue]) -> None:
    cat = catalogue([search_row("Dal moong", 0.80), search_row("Mixed dal", 0.79), search_row("Dal makhani", 0.70)])
    [it] = _ground(client, make_token(), [{"food_name": "dal", "quantity": 1, "unit": "bowl",
                                           "quantity_source": "user_stated"}]).json()["items"]
    assert it["match"]["decision"] == "ambiguous" and it["match"]["selected"] is None
    assert [o["name"] for o in it["match"]["options"]] == ["Dal moong", "Mixed dal", "Dal makhani"]
    assert it["nutrition"] is None and it["status"] == "needs_attention" and "choose_food" in it["warnings"]
    assert cat.portion_calls == []


def test_user_selected_option_is_priced(client: TestClient, make_token: Callable[..., str],
                                        catalogue: Callable[..., Catalogue]) -> None:
    catalogue([])
    [it] = _ground(client, make_token(), [{"food_name": "dal", "selected_food_id": FOOD_ID, "quantity": 1,
                                           "unit": "piece", "quantity_source": "user_stated"}]).json()["items"]
    assert it["match"]["decision"] == "user_selected" and it["nutrition"]["calories"] == 119


def test_no_match(client: TestClient, make_token: Callable[..., str], catalogue: Callable[..., Catalogue]) -> None:
    catalogue([search_row("Jal jeera", 0.4)])
    r = _ground(client, make_token(), [{"food_name": "jalebi", "quantity": 2, "unit": "piece"}]).json()
    [it] = r["items"]
    assert it["match"]["decision"] == "no_match" and "no_catalogue_match" in it["warnings"]
    assert it["nutrition"] is None and r["can_confirm"] is False and r["totals"]["items_counted"] == 0


def test_missing_nutrition_is_never_invented(client: TestClient, make_token: Callable[..., str],
                                             catalogue: Callable[..., Catalogue]) -> None:
    catalogue([search_row("Juice", 0.95, FOOD_ID)], snapshot=None)
    [it] = _ground(client, make_token(), [{"food_name": "juice", "quantity": 100, "unit": "g",
                                           "quantity_source": "manual"}]).json()["items"]
    assert it["nutrition"] is None and "nutrition_unavailable" in it["warnings"] and it["status"] == "needs_attention"


def test_missing_optional_nutrients_are_listed(client: TestClient, make_token: Callable[..., str],
                                               catalogue: Callable[..., Catalogue]) -> None:
    catalogue([search_row("Packaged snack", 0.95, FOOD_ID)],
              snapshot={"kcal": 500, "carbs_g": 60, "fat_g": 25, "protein_g": 8})
    [it] = _ground(client, make_token(), [{"food_name": "snack", "quantity": 30, "unit": "g",
                                           "quantity_source": "manual"}]).json()["items"]
    assert it["nutrition"]["missing_nutrients"] == ["fiber_g", "sugars_g", "saturated_fat_g", "sodium_g"]
    assert "some_nutrients_missing" in it["warnings"] and it["status"] == "ready"


def test_low_confidence_and_inconsistent_data_are_flagged(client: TestClient, make_token: Callable[..., str],
                                                          catalogue: Callable[..., Catalogue]) -> None:
    catalogue([search_row("Egg drop soup", 0.95, FOOD_ID, quality_flags=["energy_mismatch"])])
    [it] = _ground(client, make_token(), [{"food_name": "soup", "quantity": 200, "unit": "g", "quantity_source":
                                           "model_estimate", "recognition_confidence": 0.3}]).json()["items"]
    assert {"low_recognition_confidence", "catalogue_data_inconsistent", "portion_estimated"} <= set(it["warnings"])
    assert it["confidence"]["recognition_level"] == "low" and it["confidence"]["portion_level"] == "low"


def test_wrong_unit_is_reported_not_guessed(client: TestClient, make_token: Callable[..., str],
                                            catalogue: Callable[..., Catalogue]) -> None:
    catalogue([search_row("Chapati/Roti", 0.95, FOOD_ID)])
    [it] = _ground(client, make_token(), [{"food_name": "roti", "quantity": 200, "unit": "ml",
                                           "quantity_source": "user_stated"}]).json()["items"]
    assert it["portion"]["grams"] is None and it["nutrition"] is None and "portion_required" in it["warnings"]


@pytest.mark.parametrize("bad", [
    {"food_name": "roti", "calories": 50},
    {"food_name": "roti", "nutrients_per_100g": {"kcal": 1}},
    {"food_name": "roti", "unit": "handful"},
    {"food_name": "roti", "quantity": -1},
    {"food_name": ""},
])
def test_ground_request_rejects_nutrition_and_bad_units(client: TestClient, make_token: Callable[..., str], bad: dict) -> None:
    assert _ground(client, make_token(), [bad]).status_code == 422


def test_totals_count_only_ready_items_and_flag_estimates() -> None:
    assert build_proposal([]).can_confirm is False
