"""Phase 3: the food attribute classifier only infers, never verifies."""

from __future__ import annotations

import pytest

from app.services.catalogue.attributes import FoodInput, classify


def c(name: str, category: str | None = None, serving: str | None = None, aliases: list[str] | None = None):
    return classify(FoodInput(food_id="x", source_ref="X", name=name, category=category, aliases=aliases or [],
                              serving_label=serving))


@pytest.mark.parametrize("name,category,diet", [
    ("Chicken curry", "non_veg", "meat"),
    ("Mutton biryani", "rice_dish", "meat"),
    ("Fish fry (Machli fry)", "non_veg", "fish"),
    ("Prawn masala", None, "fish"),
    ("Egg curry (Anda curry)", "egg_dish", "egg"),
    ("Masala omelette", None, "egg"),
    ("Chocolate cake", "sweet", "unknown"),             # cakes often contain egg: not assumed vegetarian
    ("Chocolate eggless cake", "sweet", "vegetarian"),
    ("Stuffed eggplant", "sabzi", "vegetarian"),        # eggplant is not egg
    ("Dal tadka", "dal", "vegetarian"),
    ("Mystery dish", "non_veg", "meat"),                # category alone
    ("Mystery dish", None, "unknown"),                  # uncategorised: never assumed vegetarian
    ("Tilapia fry", None, "fish"),
    ("Brown stock", "soup", "unknown"),                 # meat stock is likely
    ("Classic club sandwich", "snack", "unknown"),
    ("Bread and butter pudding", "sweet", "unknown"),   # egg is likely
    ("Cream of tomato soup", "soup", "unknown"),        # soups need review
])
def test_diet(name: str, category: str | None, diet: str) -> None:
    a = c(name, category)
    assert a.diet_class == diet
    assert a.diet_status == ("unknown" if diet == "unknown" else "inferred")    # never "reviewed"


def test_vegan_and_jain_are_never_set_true() -> None:
    plain = c("Moong dal", "dal")
    assert plain.vegan_compatible is None and plain.jain_compatible is None          # unknown, not True
    assert c("Paneer tikka", "paneer_dish").vegan_compatible is False                # dairy
    assert c("Aloo gobi", "sabzi").jain_compatible is False                          # potato
    assert c("Onion uttapam", "south_indian").jain_compatible is False
    assert c("Egg bhurji", "egg_dish").jain_compatible is False


def test_allergens_are_detected_presence_only() -> None:
    a = c("Peanut chikki", "sweet")
    assert "peanut" in a.allergens and a.allergen_status == "inferred"
    b = c("Dal tadka", "dal")
    assert b.allergens == [] and b.allergen_status == "unknown"       # nothing found != allergen-free
    assert "wheat_gluten" in c("Aloo paratha", "bread").allergens
    assert "milk" in c("Paneer butter masala", "paneer_dish").allergens
    assert {"egg"} <= set(c("Egg curry", "egg_dish").allergens)
    assert "sesame" in c("Til ladoo", "sweet").allergens
    assert "mustard" in c("Sarson ka saag", "sabzi").allergens


def test_words_match_whole_words_only() -> None:
    assert "sesame" not in c("Tilapia fry", None).allergens        # "til" is not "tilapia"
    assert "mustard" not in c("Raita", "side").allergens            # "rai" is not "raita"
    assert c("Tilapia fry", None).diet_class == "fish"


def test_regions_meals_and_countable() -> None:
    idli = c("Idli", "south_indian", "1 idli")
    assert idli.regions == ["south_indian"] and idli.countable is True
    assert "breakfast" in idli.meal_types
    dal = c("Rajma", "dal", "1 bowl")
    assert dal.regions == ["north_indian"] and dal.countable is False and dal.meal_types == ["lunch", "dinner"]
    assert c("Poha", "snack").meal_types[0] == "breakfast"
    assert c("Unknown thing", None).review_priority == "high"
    assert c("Unknown thing", None).diet_class == "unknown"


def test_every_decision_has_a_reason() -> None:
    a = c("Paneer tikka", "paneer_dish")
    assert any(r.startswith("diet:") for r in a.reasons) and any("milk" in r for r in a.reasons)


def test_staple_categories() -> None:
    curd = c("Curd (plain yogurt)", "dairy", "1 cup (245 g)", aliases=["dahi", "curd"])
    assert curd.diet_class == "vegetarian" and "milk" in curd.allergens and curd.vegan_compatible is False
    banana = c("Banana", "fruit", "1 medium banana (118 g)")
    assert banana.meal_types == ["breakfast", "snack"] and banana.vegan_compatible is None   # vegan needs review
    assert c("Ghee", "other", "1 tablespoon (12.8 g)").meal_types == []                      # never recommended alone
    assert "peanut" in c("Peanuts (dry roasted)", "nuts_seeds").allergens
    assert "tree_nut" in c("Almonds", "nuts_seeds", aliases=["badam"]).allergens
    assert c("Hard-boiled egg (whole)", "egg_dish").diet_class == "egg"
