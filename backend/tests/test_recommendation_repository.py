"""Phase 3, Task 3: database rows -> candidates, and history/feedback maps (no network)."""

from __future__ import annotations

import datetime as dt

from app.recommendations import repository as repo
from app.recommendations.models import Nutrition

RECIPE_ROW = {
    "recipe_id": "11111111-1111-1111-1111-111111111111", "family_id": "22222222-2222-2222-2222-222222222222",
    "version": 1, "slug": "dal-tadka", "name": "Dal tadka", "variant": "North Indian (toor)", "servings": 4,
    "serving_label": "1 katori", "meal_types": ["dinner", "lunch"], "regions": ["north_indian"],
    "dish_types": ["dal"], "source": "curated", "verification": "curated", "quantities_estimated": True,
    "complete": True, "missing": [], "missing_nutrients": ["sugars_g"],
    "per_serving": {"calories": 180, "protein_g": 9.8, "carbs_g": 24.1, "fat_g": 5.2, "grams": 95.0},
    "ingredients": [{"position": 2, "food_name": "Ghee"}, {"position": 1, "food_name": "Toor dal (raw)"}],
    "main_food_id": "33333333-3333-3333-3333-333333333333", "main_food_name": "Toor dal (raw)",
    "diet_classes": ["vegetarian"], "diet_status": "inferred", "vegan_compatible": None, "jain_compatible": None,
    "allergens": ["milk"], "allergen_status": "inferred", "quality_flags": [],
}


def test_recipe_row_becomes_a_recipe_candidate() -> None:
    c = repo.recipe_candidate(RECIPE_ROW)
    assert (c.kind, c.key, c.group) == ("recipe", f"recipe:{RECIPE_ROW['recipe_id']}",
                                       f"family:{RECIPE_ROW['family_id']}")
    [part] = c.parts
    assert part.per_serving == Nutrition(180, 9.8, 24.1, 5.2)
    assert part.options == (0.5, 1, 1.5, 2)                      # "1 katori" is divisible
    assert part.ref_kind == "recipe" and part.serving_grams is None
    assert c.main_ingredient == "lentil" and c.dish_type == "dal"
    assert c.terms == ("Dal tadka", "North Indian (toor)", "Toor dal (raw)", "Ghee")   # by position
    assert c.quantities_estimated and c.diet_status == "inferred" and c.allergens == {"milk"}
    assert c.history_keys == (f"recipe:{RECIPE_ROW['recipe_id']}",)
    assert c.feedback_keys == (f"family:{RECIPE_ROW['family_id']}",)


def test_countable_recipe_servings_are_whole_pieces() -> None:
    c = repo.recipe_candidate({**RECIPE_ROW, "serving_label": "1 phulka", "dish_types": ["bread"]})
    assert c.parts[0].options == (1, 2, 3, 4)


def test_incomplete_recipe_has_no_parts() -> None:
    c = repo.recipe_candidate({**RECIPE_ROW, "complete": False, "per_serving": None})
    assert not c.complete and c.parts == ()


def test_template_row_becomes_a_meal_candidate() -> None:
    row = {
        "template_id": "44444444-4444-4444-4444-444444444444", "slug": "roti-dal", "name": "Roti with dal",
        "version": 1, "meal_types": ["lunch"], "regions": ["north_indian"], "complete": True,
        "main_food_id": "f2", "main_food_name": "Arhar dal",
        "components": [
            {"position": 1, "slot": "bread", "food_id": "f1", "food_name": "Chapati", "category": "bread",
             "verification": "curated", "default_servings": 2, "min_servings": 1, "max_servings": 4,
             "servings_step": 1, "optional": False, "serving_label": "1 chapati", "serving_grams": 36,
             "per_serving": {"calories": 73, "protein_g": 2.1, "carbs_g": 12.8, "fat_g": 1.3}},
            {"position": 2, "slot": "main", "food_id": "f2", "food_name": "Arhar dal", "category": "dal",
             "verification": "auto_checked", "default_servings": 1, "min_servings": 0.5, "max_servings": 2,
             "servings_step": 0.5, "optional": False, "serving_label": "1 katori", "serving_grams": 150,
             "per_serving": {"calories": 160, "protein_g": 8, "carbs_g": 20, "fat_g": 5}},
            {"position": 3, "slot": "accompaniment", "food_id": "f3", "food_name": "Pickle", "optional": True,
             "default_servings": 1, "min_servings": 1, "max_servings": 1, "servings_step": 1,
             "serving_label": "1 tsp", "serving_grams": 5, "per_serving": None},
        ],
        "diet_classes": ["vegetarian"], "diet_status": "inferred", "allergens": ["wheat_gluten"],
        "allergen_status": "inferred", "quality_flags": [],
    }
    c = repo.template_candidate(row)
    assert c.kind == "meal" and c.complete
    assert [p.ref_id for p in c.parts] == ["f1", "f2"]          # optional components are not recommended
    assert c.parts[0].options == (1, 2, 3, 4) and c.parts[0].default == 2
    assert c.parts[1].options == (0.5, 1, 1.5, 2) and c.parts[1].serving_grams == 150
    assert c.main_ingredient == "lentil" and c.dish_type == "dal"
    assert c.verification == "auto_checked"                       # the weakest component
    assert c.dish_food_ids == {"f1", "f2"}
    # An unpriceable required component makes the whole template incomplete.
    broken = {**row, "components": [{**row["components"][0], "per_serving": None}, row["components"][1]]}
    assert repo.template_candidate(broken).parts == ()


def test_food_row_becomes_a_food_candidate() -> None:
    row = {"food_id": "f9", "name": "Paneer tikka", "category": "paneer_dish", "food_kind": "generic_dish",
           "source": "indb", "verification": "curated", "completeness": 1, "serving_label": "1 plate",
           "serving_grams": 150, "calories": 410, "protein_g": 25.2, "carbs_g": 9.1, "fat_g": 30.3,
           "regions": ["north_indian"], "meal_types": ["dinner", "snack"], "countable": False,
           "diet_classes": ["vegetarian"], "diet_status": "inferred", "vegan_compatible": None,
           "jain_compatible": None, "allergens": ["milk"], "allergen_status": "inferred",
           "quality_flags": ["cooking_oil_uncertain"]}
    c = repo.food_candidate(row)
    assert (c.kind, c.key, c.food_id, c.main_ingredient, c.prep_style) == (
        "food", "food:f9", "f9", "paneer", "grilled")
    assert c.parts[0].serving_grams == 150 and c.parts[0].options == (0.5, 1, 1.5, 2)
    assert c.quality_flags == {"cooking_oil_uncertain"}
    assert repo.food_candidate({**row, "calories": None}).parts == ()


def test_key_ingredients() -> None:
    assert repo.key_ingredient("Egg curry") == "egg"
    assert repo.key_ingredient("Aloo paratha") == "potato"
    assert repo.key_ingredient("Chicken biryani") == "chicken"
    assert repo.key_ingredient("Moong dal khichdi") == "lentil"
    assert repo.key_ingredient("Mango") is None
    assert repo._main_name("Chicken thigh (raw skinless)") == "chicken"
    assert repo._main_name("Cucumber (raw)") == "cucumber"


def test_shows_and_events_become_ages_in_days() -> None:
    now = dt.datetime(2026, 11, 21, 12, tzinfo=dt.UTC)
    items = [{"kind": "food", "food_id": "a", "created_at": "2026-11-21T12:00:00+00:00"},
             {"kind": "food", "food_id": "a", "created_at": "2026-11-19T12:00:00Z"},
             {"kind": "combo", "recipe_id": "r", "created_at": "2026-11-20T00:00:00+00:00"},
             {"kind": "meal", "template_id": None, "created_at": "2026-11-21T00:00:00+00:00"}]   # deleted: ignored
    assert repo.show_ages(items, now) == {"food:a": (0.0, 2.0), "recipe:r": (1.5,)}
    events = [{"event": "viewed", "created_at": "2026-11-21T06:00:00+00:00",
               "recommendation_items": {"kind": "meal", "template_id": "t"}},
              {"event": "rejected", "created_at": "2026-11-14T12:00:00+00:00",
               "recommendation_items": {"kind": "meal", "template_id": "t"}},
              {"event": "selected", "created_at": "2026-11-21T12:00:00+00:00", "recommendation_items": None}]
    assert repo.event_ages(events, now) == {"meal:t": (("viewed", 0.25), ("rejected", 7.0))}


def test_feedback_map_ignores_expired_rows() -> None:
    now = dt.datetime(2026, 11, 21, 12, tzinfo=dt.UTC)
    rows = [{"food_id": "a", "feedback": "never", "expires_at": None},
            {"template_id": "t", "feedback": "less_often", "expires_at": "2026-11-20T00:00:00+00:00"},
            {"recipe_family_id": "f", "feedback": "liked", "expires_at": "2027-05-01T00:00:00Z"}]
    assert repo.feedback_map(rows, now) == {"family:f": "liked", "food:a": "never"}


def test_optional_template_components_become_add_ons_with_their_own_attributes() -> None:
    row = {
        "template_id": "44444444-4444-4444-4444-444444444444", "slug": "poha", "name": "Poha with tea", "version": 1,
        "meal_types": ["breakfast"], "regions": ["west_indian"], "complete": True, "main_food_name": "Poha",
        "components": [
            {"position": 1, "slot": "main", "food_id": "f1", "food_name": "Poha", "category": "snack",
             "verification": "curated", "default_servings": 2, "min_servings": 1, "max_servings": 2,
             "servings_step": 0.5, "optional": False, "serving_label": "1 bowl", "serving_grams": 55,
             "per_serving": {"calories": 161, "protein_g": 3.3, "carbs_g": 19.1, "fat_g": 7.7},
             "diet_class": "vegetarian", "diet_status": "inferred", "allergens": [], "allergen_status": "unknown",
             "quality_flags": []},
            {"position": 2, "slot": "drink", "food_id": "f2", "food_name": "Hot tea", "category": "beverage",
             "verification": "curated", "default_servings": 1, "min_servings": 1, "max_servings": 1,
             "servings_step": 1, "optional": True, "serving_label": "1 tea cup", "serving_grams": 210,
             "per_serving": {"calories": 34, "protein_g": 0.8, "carbs_g": 5.4, "fat_g": 1.1},
             "diet_class": "vegetarian", "diet_status": "inferred", "vegan_compatible": False, "allergens": ["milk"],
             "allergen_status": "inferred", "quality_flags": ["density_assumed"]},
            {"position": 3, "slot": "accompaniment", "food_id": "f3", "food_name": "Unpriced pickle",
             "optional": True, "default_servings": 1, "min_servings": 1, "max_servings": 1, "servings_step": 1,
             "serving_label": "1 tsp", "serving_grams": 5, "per_serving": None},
        ],
        "diet_classes": ["vegetarian"], "diet_status": "inferred", "allergens": [], "allergen_status": "unknown",
        "quality_flags": [],
    }
    c = repo.template_candidate(row)
    assert [p.ref_id for p in c.parts] == ["f1"]                       # the base meal: required only
    assert c.allergens == frozenset() and c.quality_flags == frozenset()
    [tea] = c.addons                                                    # the unpriceable one is not offered
    assert (tea.part.name, tea.part.default, tea.part.serving_grams) == ("Hot tea", 1.0, 210.0)
    assert tea.allergens == {"milk"} and tea.allergen_status == "inferred"
    assert tea.quality_flags == {"density_assumed"} and tea.vegan is False
    assert c.terms == ("Poha",)            # the title "Poha with tea" names an optional component: not matched
    assert c.approval_level == "provisional"                               # no level in the row: never "verified"
    assert repo.template_candidate({**row, "approval_level": "verified"}).approval_level == "verified"
