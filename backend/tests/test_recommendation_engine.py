"""Phase 3, Task 3: the deterministic recommendation engine (pure functions).

Fixtures are hand-built candidates with round numbers, so every expected value
can be checked by hand. Default day: 2,000 kcal, P100 C250 F67, nothing eaten;
lunch is 35% -> 700 kcal, P35, C87.5, F23.45.
"""

from __future__ import annotations

import datetime as dt
import random
from dataclasses import replace

import pytest

from app.recommendations import engine
from app.recommendations.config import DEFAULT_CONFIG, GOAL_WEIGHTS, TOLERANCES, Weights, calorie_band
from app.recommendations.models import Candidate, Nutrition, Part, Request, UserContext

DAY = Nutrition(2000, 100, 250, 67)
DIVISIBLE = (0.5, 1, 1.5, 2)


def part(kcal: float, p: float, c: float, f: float, *, ref: str = "x", kind: str = "food",
         options: tuple[float, ...] = DIVISIBLE, label: str = "1 katori", default: float = 1.0,
         grams: float | None = 100.0) -> Part:
    return Part(kind, ref, ref, label, Nutrition(kcal, p, c, f), options, default=default,  # type: ignore[arg-type]
                serving_grams=grams if kind == "food" else None)


def cand(name: str, kcal: float, p: float, c: float, f: float, *, kind: str = "food", key: str | None = None,
         group: str | None = None, meal_types: tuple[str, ...] = ("lunch", "dinner"),
         diet: tuple[str, ...] = ("vegetarian",), diet_status: str = "reviewed", vegan: bool | None = None,
         jain: bool | None = None, allergens: tuple[str, ...] = (), allergen_status: str = "reviewed",
         regions: tuple[str, ...] = ("north_indian",), dish_type: str | None = "sabzi", main: str | None = None,
         prep: str | None = None, flags: tuple[str, ...] = (), complete: bool = True,
         options: tuple[float, ...] = DIVISIBLE, terms: tuple[str, ...] | None = None,
         verification: str = "curated", estimated: bool = False, parts: tuple[Part, ...] | None = None,
         **extra) -> Candidate:
    key = key or f"{kind}:{name}"
    ps = parts if parts is not None else ((part(kcal, p, c, f, ref=name, options=options,
                                                kind="recipe" if kind in ("recipe",) else "food"),) if complete else ())
    return Candidate(
        kind=kind, key=key, group=group or key, name=name, parts=ps, complete=complete,  # type: ignore[arg-type]
        meal_types=frozenset(meal_types), regions=frozenset(regions), dish_type=dish_type, main_ingredient=main,
        prep_style=prep, terms=terms or (name,), dish_names=frozenset({engine.normalize(name)}),
        diet_classes=frozenset(diet), diet_status=diet_status, vegan=vegan, jain=jain,
        allergens=frozenset(allergens), allergen_status=allergen_status, quality_flags=frozenset(flags),
        source="test", verification=verification, quantities_estimated=estimated,
        history_keys=(key,), feedback_keys=(key,), food_id=name if kind == "food" else None, **extra)


def ctx(**kw) -> UserContext:
    base = dict(local_date=dt.date(2026, 11, 21), goal="maintain", targets=DAY, remaining=DAY, has_preferences=True)
    base.update(kw)
    return UserContext(**base)  # type: ignore[arg-type]


def run(cands, context=None, **req) -> engine.EngineResult:
    r = Request(**{"meal_type": "lunch", "count": 5, "mode": "both", **req})
    return engine.recommend(cands, context or ctx(), r)


def names(result) -> list[str]:
    return [i.candidate.name for i in result.items]


# A well-fitting lunch (one 700 kcal serving) and a few alternatives.
DAL_RICE = dict(kcal=700, p=35, c=87, f=22)


# ================================================================== budget

def test_meal_budget_is_the_meals_share_of_the_day() -> None:
    b = engine.meal_budget(ctx(), Request(meal_type="lunch"))
    assert (b.kcal, b.mode, b.basis) == (700, "planned", "targets")
    assert (round(b.protein_g, 2), round(b.carbs_g, 2), round(b.fat_g, 2)) == (35.0, 87.5, 23.45)
    assert engine.meal_budget(ctx(), Request(meal_type="snack")).kcal == 200


def test_budget_is_capped_by_what_is_left() -> None:
    b = engine.meal_budget(ctx(remaining=Nutrition(400, 40, 30, 10)), Request(meal_type="lunch"))
    assert (b.kcal, b.mode) == (400, "capped")
    # Macros are the meal's share of what is left: all of it here.
    assert (b.protein_g, b.carbs_g, b.fat_g) == (40, 30, 10)
    assert "limited to the 400 kcal left" in b.notes[0]


def test_macro_targets_follow_what_is_left_not_the_plan() -> None:
    # Carbs already eaten: the lunch carb target drops; protein is still the full share.
    b = engine.meal_budget(ctx(remaining=Nutrition(1400, 100, 50, 67)), Request(meal_type="lunch"))
    assert b.kcal == 700
    assert (b.protein_g, b.carbs_g) == (50, 25)


@pytest.mark.parametrize("remaining,text", [(80, "Only 80 kcal are left"), (0, "Only 0 kcal"),
                                            (-250, "250 kcal over today's target")])
def test_very_low_or_negative_budget_switches_to_light_options(remaining: float, text: str) -> None:
    b = engine.meal_budget(ctx(remaining=Nutrition(remaining, 0, 0, 0)), Request(meal_type="dinner"))
    assert (b.kcal, b.mode) == (150, "light")
    assert text in b.notes[0]
    assert b.protein_g == pytest.approx(7.5)          # neutral split of 150 kcal, not "negative protein"


def test_no_targets_assumes_2000_kcal_and_says_so() -> None:
    b = engine.meal_budget(ctx(targets=None, remaining=None, consumed=Nutrition(500, 20, 60, 10)),
                           Request(meal_type="lunch"))
    assert (b.kcal, b.basis, b.remaining_kcal) == (700, "assumed", None)
    assert "assumes a 2,000 kcal day" in b.notes[0]


def test_requested_budget_overrides_the_plan() -> None:
    b = engine.meal_budget(ctx(), Request(meal_type="dinner", target_kcal=900))
    assert (b.kcal, b.mode) == (900, "requested")


def test_unreachable_protein_is_capped_and_explained() -> None:
    # 120 g protein left but only 500 kcal: at most 40% of energy -> 50 g.
    b = engine.meal_budget(ctx(remaining=Nutrition(500, 120, 40, 10)), Request(meal_type="lunch"))
    assert b.protein_g == 50
    assert any("more than one 500 kcal meal can realistically provide" in n for n in b.notes)


# ================================================================== calorie and macro scoring

def test_calorie_score_is_flat_inside_the_band_and_linear_outside() -> None:
    band = TOLERANCES["standard"]            # full 0.90-1.10, zero 0.70 / 1.30
    assert engine.calorie_score(700, 700, band) == 1.0
    assert engine.calorie_score(770, 700, band) == 1.0            # +10%
    assert engine.calorie_score(840, 700, band) == pytest.approx(0.5)   # +20%: halfway to zero
    assert engine.calorie_score(560, 700, band) == pytest.approx(0.5)   # -20%
    assert engine.calorie_score(950, 700, band) == 0.0
    assert engine.calorie_gate(950, 700, band) == "too_large"
    assert engine.calorie_gate(400, 700, band) == "too_small"
    assert engine.calorie_gate(700, 700, band) is None


def test_goal_makes_the_band_asymmetric() -> None:
    lose, gain, keep = calorie_band("standard", "lose"), calorie_band("standard", "gain"), calorie_band("standard", None)
    assert lose.full_high < keep.full_high and lose.zero_high < keep.zero_high
    assert lose.zero_low == keep.zero_low
    assert gain.zero_low > keep.zero_low and gain.zero_high == keep.zero_high
    # 20% over: still acceptable when maintaining, more penalised when losing.
    assert engine.calorie_score(840, 700, lose) < engine.calorie_score(840, 700, keep)
    # 20% under: more penalised when gaining.
    assert engine.calorie_score(560, 700, gain) < engine.calorie_score(560, 700, keep)


def test_protein_is_a_floor_carbs_and_fat_are_ceilings() -> None:
    assert engine.protein_score(31.5, 35) == 1.0                  # 90% of target is enough
    assert engine.protein_score(17.5, 35) == pytest.approx(0.5556, abs=1e-4)
    assert engine.protein_score(60, 35) == 1.0                    # more protein is never penalised
    assert engine.protein_score(0, 0) == 1.0
    assert engine.ceiling_score(50, 87.5) == 1.0                  # under the ceiling is fine
    assert engine.ceiling_score(100, 87.5) == 1.0                 # 87.5*1.15+3 = 103.6
    assert 0 < engine.ceiling_score(150, 87.5) < 1
    assert engine.ceiling_score(190, 87.5) == 0.0                 # 87.5*2+15 = 190
    assert engine.ceiling_score(10, 0) == pytest.approx(1 - (10 - 3) / 12)   # nothing left: small slack only


def test_score_is_the_weighted_mean_of_components() -> None:
    [item] = run([cand("Dal rice", **DAL_RICE)]).items
    w = DEFAULT_CONFIG.weights("maintain").as_dict()
    expected = sum(item.components[k] * w[k] for k in w) / sum(w.values())
    assert item.score == pytest.approx(expected)
    assert set(item.components) == set(w)
    assert all(0.0 <= v <= 1.0 for v in item.components.values())


def test_weights_sum_to_one_for_every_goal() -> None:
    for weights in GOAL_WEIGHTS.values():
        assert sum(weights.as_dict().values()) == pytest.approx(1.0)
    assert GOAL_WEIGHTS["lose"].protein > GOAL_WEIGHTS["maintain"].protein
    assert GOAL_WEIGHTS["gain"].calories > GOAL_WEIGHTS["maintain"].calories


def test_custom_weights_change_the_ranking_deterministically() -> None:
    high_protein = cand("Paneer bowl", 700, 45, 60, 40, main="paneer")       # fat well over the ceiling
    balanced = cand("Veg pulao", 700, 20, 87, 22, main="rice")               # protein short
    default = run([high_protein, balanced])
    assert names(default)[0] == "Paneer bowl"
    fat_heavy = replace(DEFAULT_CONFIG, weights_by_goal={"maintain": Weights(protein=0.05, fat=0.40)})
    alt = engine.recommend([high_protein, balanced], ctx(), Request(meal_type="lunch"), fat_heavy)
    assert [i.candidate.name for i in alt.items][0] == "Veg pulao"


# ================================================================== portions

def test_divisible_portions_choose_the_best_half_serving_step() -> None:
    [item] = run([cand("Rajma", 350, 15, 45, 10)]).items         # 2 x 350 = 700
    assert item.servings == (2,)
    assert item.nutrition == Nutrition(700, 30, 90, 20)


def test_countable_portions_are_whole_pieces() -> None:
    roti = cand("Roti", 120, 4, 20, 3, options=(1, 2, 3, 4), meal_types=("snack",))
    [item] = run([roti], meal_type="snack").items                  # snack 200 kcal -> 2 roti (240) beats 1 (120)
    assert item.servings == (2,)


def test_template_portions_search_each_component_range() -> None:
    meal = cand("Roti dal thali", 0, 0, 0, 0, kind="meal", parts=(
        part(100, 3, 18, 2, ref="roti", options=engine.range_options(1, 4, 1), default=2),
        part(200, 12, 25, 6, ref="dal", options=engine.range_options(0.5, 2, 0.5), default=1),
    ))
    [item] = run([meal]).items
    assert item.nutrition.kcal == pytest.approx(700)
    assert item.servings in ((3, 2.0), (1, 3.0)) and item.servings == (3, 2.0)   # (1, 3) is out of the dal range


def test_portion_search_is_bounded_for_large_templates() -> None:
    many = tuple(part(50, 2, 6, 2, ref=f"c{i}", options=engine.range_options(0.25, 10, 0.25)) for i in range(4))
    meal = cand("Big thali", 0, 0, 0, 0, kind="meal", parts=many)
    choices = engine.portion_choices(meal)
    assert 0 < len(choices) <= 6                                   # common scaling, not 40^4 combinations


def test_range_options_have_no_float_drift() -> None:
    assert engine.range_options(0.5, 2, 0.5) == (0.5, 1.0, 1.5, 2.0)
    assert engine.range_options(1, 1, 1) == (1.0,)


# ================================================================== hard constraints

def test_a_hard_exclusion_is_never_overridden_by_score() -> None:
    perfect_meat = cand("Chicken curry", **DAL_RICE, diet=("meat",), main="chicken")
    weak_veg = cand("Aloo sabzi", 600, 12, 87, 22, main="potato")
    result = run([perfect_meat, weak_veg], ctx(diet="vegetarian"))
    assert names(result) == ["Aloo sabzi"]
    assert result.excluded == {"diet_conflict": 1}
    # Without the diet, the meat dish is the better fit.
    assert names(run([perfect_meat, weak_veg]))[0] == "Chicken curry"


@pytest.mark.parametrize("diet,classes,ok", [
    ("vegetarian", ("vegetarian",), True), ("vegetarian", ("egg",), False),
    ("eggetarian", ("egg", "vegetarian"), True), ("eggetarian", ("fish",), False),
    ("pescatarian", ("fish", "egg"), True), ("pescatarian", ("meat",), False),
    ("omnivore", ("meat", "fish"), True),
])
def test_diet_classes(diet: str, classes: tuple[str, ...], ok: bool) -> None:
    c = cand("Dish", **DAL_RICE, diet=classes)
    assert (engine.hard_exclusion(c, ctx(diet=diet)) is None) is ok


def test_unknown_diet_is_excluded_only_when_a_diet_is_declared() -> None:
    c = cand("Mystery soup", **DAL_RICE, diet=("unknown",), diet_status="unknown")
    assert engine.hard_exclusion(c, ctx(diet="vegetarian")) == "diet_unknown"
    assert engine.hard_exclusion(c, ctx(diet="omnivore")) is None
    assert engine.hard_exclusion(c, ctx()) is None
    # A recipe where one ingredient is unknown is unknown, even if the rest are vegetarian.
    mixed = cand("Mixed", **DAL_RICE, diet=("vegetarian", "unknown"), diet_status="unknown")
    assert engine.hard_exclusion(mixed, ctx(diet="vegetarian")) == "diet_unknown"


def test_inferred_diet_is_allowed_but_labelled() -> None:
    c = cand("Dal", **DAL_RICE, diet_status="inferred")
    [item] = run([c], ctx(diet="vegetarian")).items
    assert any("inferred" in w and "not been reviewed" in w for w in item.warnings)


@pytest.mark.parametrize("diet,flag", [("vegan", "vegan"), ("jain", "jain")])
def test_vegan_and_jain_require_a_reviewed_true(diet: str, flag: str) -> None:
    unknown = cand("Dish", **DAL_RICE, diet=("vegan",))
    assert engine.hard_exclusion(unknown, ctx(diet=diet)) == "diet_unverified"
    reviewed = cand("Dish", **DAL_RICE, diet=("vegan",), **{flag: True})
    assert engine.hard_exclusion(reviewed, ctx(diet=diet)) is None
    vegetarian = cand("Dish", **DAL_RICE, diet=("vegetarian",), vegan=True, jain=True)
    assert engine.hard_exclusion(vegetarian, ctx(diet="vegan")) == "diet_conflict"


def test_allergies_exclude_detected_allergens_and_unreviewed_absence() -> None:
    paneer = cand("Paneer tikka", **DAL_RICE, allergens=("milk",))
    inferred = cand("Aloo gobi", **DAL_RICE, allergen_status="inferred")
    reviewed = cand("Bhindi", **DAL_RICE, allergen_status="reviewed")
    milk = ctx(allergies=frozenset({"milk"}))
    assert engine.hard_exclusion(paneer, milk) == "allergen_present"
    # Nothing detected is not the same as nothing present.
    assert engine.hard_exclusion(inferred, milk) == "allergen_unverified"
    assert engine.hard_exclusion(reviewed, milk) is None
    # Without allergies, detected allergens are only a warning ("may contain"), never "verified".
    [item] = run([replace(paneer, allergen_status="inferred")]).items
    assert any(w.startswith("May contain milk") and "not a reviewed allergen list" in w for w in item.warnings)
    assert not any("verified" in w and "not" not in w for w in item.warnings)


def test_excluded_ingredients_match_names_and_ingredients_including_plurals() -> None:
    c = cand("Aloo gobi", **DAL_RICE, terms=("Aloo gobi", "Potato (raw)", "Onions"))
    assert engine.hard_exclusion(c, ctx(excluded_ingredients=("onion",))) == "excluded_ingredient"
    assert engine.hard_exclusion(c, ctx(excluded_ingredients=("Potatoes",))) == "excluded_ingredient"   # singular too
    assert engine.hard_exclusion(c, ctx(excluded_ingredients=("potato",))) == "excluded_ingredient"
    assert engine.hard_exclusion(c, ctx(excluded_ingredients=("gob",))) is None        # whole words only


def test_a_disliked_food_ranks_lower_but_is_not_removed() -> None:
    karela = cand("Karela sabzi", **DAL_RICE, main="karela", dish_type="a")
    bhindi = cand("Bhindi sabzi", 690, 20, 87, 22, main="okra", dish_type="b")   # less protein: ranks second
    assert names(run([karela, bhindi])) == ["Karela sabzi", "Bhindi sabzi"]
    disliked = run([karela, bhindi], ctx(dislikes=("karela",)))
    assert names(disliked) == ["Bhindi sabzi", "Karela sabzi"]
    item = disliked.items[1]
    assert item.adjustments == {"dislike": 0.15}
    assert any("which you dislike" in r for r in item.reasons)
    # A dislike is soft: it is never a hard exclusion.
    assert engine.hard_exclusion(karela, ctx(dislikes=("karela",))) is None


def test_an_excluded_ingredient_beats_any_preference() -> None:
    perfect = cand("Paneer bowl", **DAL_RICE, regions=("south_indian",), dish_type="curry",
                   terms=("Paneer bowl", "Paneer"))
    context = ctx(excluded_ingredients=("paneer",), cuisines=("South Indian",), meal_styles=frozenset({"curry"}),
                  feedback={"food:Paneer bowl": "saved"})
    result = run([perfect], context)
    assert result.items == () and result.excluded == {"excluded_ingredient": 1}


def test_never_feedback_excludes_less_often_demotes() -> None:
    a, b = cand("Dal A", **DAL_RICE, main="lentil"), cand("Dal B", **DAL_RICE, main="moong")
    assert engine.hard_exclusion(a, ctx(feedback={"food:Dal A": "never"})) == "never_feedback"
    result = run([a, b], ctx(feedback={"food:Dal A": "less_often"}))
    assert names(result) == ["Dal B", "Dal A"]
    assert result.items[1].adjustments["rejected"] == 0.15


def test_incomplete_and_inconsistent_nutrition_is_excluded_flagged_oil_is_warned() -> None:
    incomplete = cand("No data", 0, 0, 0, 0, complete=False)
    mismatch = cand("Mismatch", **DAL_RICE, flags=("energy_mismatch",))
    oily = cand("Oily", **DAL_RICE, flags=("cooking_oil_uncertain",))
    result = run([incomplete, mismatch, oily])
    assert names(result) == ["Oily"]
    assert result.excluded == {"incomplete_nutrition": 1, "unreliable_nutrition": 1}
    assert any("cooking oil" in w for w in result.items[0].warnings)
    assert result.items[0].components["quality"] < 0.9


# ================================================================== ranking consistency

def _catalogue() -> list[Candidate]:
    return [
        cand("Dal rice", **DAL_RICE, main="lentil", dish_type="dal"),
        cand("Rajma chawal", 690, 30, 95, 18, main="rajma", dish_type="curry"),
        cand("Paneer roti", 720, 38, 70, 28, main="paneer", dish_type="paneer_dish"),
        cand("Chole", 350, 16, 45, 11, main="chickpea", dish_type="curry"),
        cand("Veg pulao", 650, 14, 100, 20, main="rice", dish_type="rice_dish"),
        cand("Egg curry", 680, 36, 40, 34, main="egg", dish_type="egg_dish", diet=("egg",)),
        cand("Idli", 60, 2, 12, 0.5, options=(1, 2, 3, 4), meal_types=("breakfast",), main="rice"),
    ]


def test_same_inputs_give_identical_results() -> None:
    first, second = run(_catalogue()), run(_catalogue())
    assert first == second


def test_input_order_does_not_matter() -> None:
    expected = run(_catalogue())
    for seed in range(5):
        shuffled = _catalogue()
        random.Random(seed).shuffle(shuffled)
        assert run(shuffled) == expected


def test_ties_break_by_kind_then_name() -> None:
    a = cand("B dish", **DAL_RICE, main="a", dish_type="x")
    b = cand("A dish", **DAL_RICE, main="b", dish_type="y")
    assert names(run([a, b])) == ["A dish", "B dish"]


# ================================================================== diversity

def test_at_most_two_results_share_a_main_ingredient() -> None:
    paneer = [cand(f"Paneer {i}", 700 + i, 35, 87, 22, main="paneer", dish_type=f"t{i}") for i in range(4)]
    other = cand("Dal", 640, 25, 87, 22, main="lentil", dish_type="dal")
    result = run(paneer + [other])
    mains = [i.candidate.main_ingredient for i in result.items]
    assert mains.count("paneer") == 2
    assert "Dal" in names(result)
    assert result.status == "partial"                     # 3 shown, 5 asked: not padded with a third paneer


def test_shared_traits_are_penalised_in_order() -> None:
    a = cand("Dal one", **DAL_RICE, main="lentil", dish_type="dal")
    b = cand("Dal two", 698, 35, 87, 22, main="lentil", dish_type="dal")       # nearly identical score
    c = cand("Bhindi", 690, 30, 87, 22, main="okra", dish_type="sabzi")        # slightly lower score
    result = run([a, b, c])
    assert names(result) == ["Dal one", "Bhindi", "Dal two"]
    # Same main (0.12) + same dish type (0.06) + region shared with both earlier picks (2 x 0.03).
    assert result.items[2].diversity_penalty == pytest.approx(0.12 + 0.06 + 0.06)
    assert result.items[1].diversity_penalty == pytest.approx(0.03)
    assert result.items[0].diversity_penalty == 0


def test_one_result_per_group() -> None:
    recipe = cand("Dal tadka", **DAL_RICE, kind="recipe", group="family:1", main="lentil")
    combo = cand("Dal tadka with rice", **DAL_RICE, kind="combo", group="family:1", main="lentil")
    assert len(run([recipe, combo]).items) == 1


def test_region_penalty_applies_only_without_a_cuisine_preference() -> None:
    a = cand("North A", **DAL_RICE, main="a", dish_type="a", regions=("north_indian",))
    b = cand("North B", **DAL_RICE, main="b", dish_type="b", regions=("north_indian",))
    assert run([a, b]).items[1].diversity_penalty == pytest.approx(0.03)
    assert run([a, b], ctx(cuisines=("Punjabi",))).items[1].diversity_penalty == 0


# ================================================================== preferences, variety, history

def test_cuisine_preference_maps_free_text_to_regions() -> None:
    assert engine.cuisine_regions(["South Indian", "Gujarati food"]) == {"south_indian", "west_indian"}
    south = cand("Dosa", **DAL_RICE, regions=("south_indian",), main="rice", dish_type="a")
    north = cand("Roti", **DAL_RICE, regions=("north_indian",), main="wheat", dish_type="b")
    result = run([north, south], ctx(cuisines=("Tamil",)))
    assert names(result) == ["Dosa", "Roti"]
    assert result.items[0].components["preference"] == 1.0
    assert any("South Indian preference" in r for r in result.items[0].reasons)
    # No preference: neutral, identical for everyone.
    assert {i.components["preference"] for i in run([north, south]).items} == {0.6}


def test_variety_prefers_what_was_not_eaten_today() -> None:
    dal = cand("Dal", **DAL_RICE, main="lentil", dish_type="dal")
    rajma = cand("Rajma", 690, 33, 87, 22, main="rajma", dish_type="curry")
    plain = run([dal, rajma])
    assert names(plain)[0] == "Dal"
    today = run([dal, rajma], ctx(today_food_ids=frozenset({"Dal"})))
    assert names(today)[0] == "Rajma"
    assert today.items[1].components["variety"] == 0.0
    assert any("already had this today" in r for r in today.items[1].reasons)
    assert run([dal], ctx(yesterday_names=frozenset({"dal"}))).items[0].components["variety"] == 0.5


def test_history_uses_choices_not_views() -> None:
    c = cand("Dal", **DAL_RICE)

    def score(**kw):
        return engine.history_score(c, ctx(**kw))

    assert score() == 0.7
    assert score(events={"food:Dal": (("viewed", 0.1), ("viewed", 1.0))}) == 0.7     # viewing is not liking
    assert score(feedback={"food:Dal": "saved"}) == 1.0
    assert score(feedback={"food:Dal": "liked"}) == 1.0
    assert score(events={"food:Dal": (("selected", 2.0),)}) == pytest.approx(0.85)
    assert score(events={"food:Dal": (("logged", 1.0), ("selected", 3.0), ("planned", 4.0))}) == 1.0
    assert score(events={"food:Dal": (("rejected", 0.0),)}) == 0.7          # negatives are adjustments


def test_a_rejection_fades_with_time_not_interested_lasts() -> None:
    c = cand("Dal", **DAL_RICE)

    def at(days):
        return engine.rejection_penalty(c, ctx(events={"food:Dal": (("rejected", days),)}))

    assert at(0) == pytest.approx(0.10)
    assert at(7) == pytest.approx(0.05)                # one half-life later
    assert at(14) == pytest.approx(0.025)
    assert at(31) == 0                                 # outside the 30-day window: fully forgiven
    assert engine.rejection_penalty(c, ctx(feedback={"food:Dal": "less_often"})) == 0.15


def test_not_interested_moves_an_item_down() -> None:
    a = cand("Dal A", **DAL_RICE, main="a", dish_type="a")
    b = cand("Dal B", 690, 30, 87, 22, main="b", dish_type="b")
    assert names(run([a, b]))[0] == "Dal A"
    result = run([a, b], ctx(feedback={"food:Dal A": "less_often"}))
    assert names(result) == ["Dal B", "Dal A"]
    assert result.items[1].adjustments == {"rejected": 0.15}


def test_novelty_penalty_decays_and_is_never_permanent() -> None:
    c = cand("Dal", **DAL_RICE)

    def pen(**kw):
        return engine.novelty_penalty(c, ctx(**kw))

    assert pen() == 0
    assert pen(shows={"food:Dal": (0.0,)}) == pytest.approx(0.04)
    assert pen(shows={"food:Dal": (2.0,)}) == pytest.approx(0.02)          # half-life 2 days
    assert pen(shows={"food:Dal": (0.0,) * 10}) == pytest.approx(0.15)     # capped
    assert pen(shows={"food:Dal": (8.0,)}) == 0                             # beyond the 7-day window
    assert pen(events={"food:Dal": (("logged", 0.0),)}) == pytest.approx(0.04)   # chosen recently also steps back
    assert pen(events={"food:Dal": (("viewed", 0.0),)}) == 0


def test_repeated_recommendations_rotate() -> None:
    a = cand("Dal A", **DAL_RICE, main="a", dish_type="a")
    b = cand("Dal B", 695, 35, 87, 22, main="b", dish_type="b")
    assert names(run([a, b]))[0] == "Dal A"
    shown = ctx(shows={"food:Dal A": (0.0, 0.0, 0.0)})                      # shown three times today
    result = run([a, b], shown)
    assert names(result)[0] == "Dal B"
    assert result.items[1].adjustments["novelty"] == pytest.approx(0.12)
    assert any("Suggested recently" in r for r in result.items[1].reasons)
    # A week later it is back on top.
    assert names(run([a, b], ctx(shows={"food:Dal A": (7.5, 7.5, 7.5)})))[0] == "Dal A"


def test_meal_type_fit() -> None:
    c = cand("Poha", **DAL_RICE, meal_types=("breakfast",))
    assert engine.meal_type_score(c, "breakfast") == 1.0
    assert engine.meal_type_score(c, "dinner") == 0.0
    assert engine.meal_type_score(replace(c, meal_types=frozenset()), "dinner") == 0.5


def test_data_quality_lowers_the_score_and_is_explained() -> None:
    measured = cand("Measured", **DAL_RICE, verification="expert_reviewed")
    estimated = cand("Estimated", **DAL_RICE, verification="curated", estimated=True, diet_status="inferred")
    assert engine.quality_score(measured) == 1.0
    assert engine.quality_score(estimated) == pytest.approx(0.9 - 0.15 - 0.05)
    [item] = run([estimated]).items
    assert any("typical home amounts" in w for w in item.warnings)


# ================================================================== goals

def test_goals_rank_the_same_options_differently() -> None:
    lean = cand("Grilled fish", 560, 45, 40, 18, main="fish", dish_type="a", diet=("fish",))    # 80%, high protein
    hearty = cand("Biryani", 820, 26, 110, 26, main="rice", dish_type="b", diet=("meat",))      # 117%
    lose = run([lean, hearty], ctx(goal="lose"))
    gain = run([lean, hearty], ctx(goal="gain"))
    assert names(lose)[0] == "Grilled fish"
    assert names(gain)[0] == "Biryani"


# ================================================================== combinations

def _recipe(name: str, dish: str, kcal: float, p: float, c: float, f: float, *, regions=("north_indian",),
            meal_types=("lunch", "dinner"), options=DIVISIBLE, **kw) -> Candidate:
    rid = name.lower().replace(" ", "-")
    return cand(name, kcal, p, c, f, kind="recipe", key=f"recipe:{rid}", group=f"family:{rid}", dish_type=dish,
                regions=regions, meal_types=meal_types, options=options, recipe_id=rid, family_id=rid, **kw)


def test_main_dishes_pair_with_rice_or_bread_recipes() -> None:
    dal = _recipe("Dal tadka", "dal", 180, 10, 25, 5, main="lentil", estimated=True)
    rice = _recipe("Steamed rice", "rice", 240, 5, 52, 0.5, regions=("pan_indian",), main="rice")
    dosa = _recipe("Dosa", "breakfast_dish", 120, 3, 20, 3, regions=("south_indian",), meal_types=("breakfast",))
    sambar_south = _recipe("Sambar", "dal", 150, 7, 20, 4, regions=("south_indian",), main="lentil")
    roti = _recipe("Phulka", "bread", 80, 3, 16, 0.5, options=(1, 2, 3, 4), main="wheat")
    combos = engine.build_combinations([dal, rice, dosa, sambar_south, roti])
    assert [c.name for c in combos] == ["Dal tadka with Phulka", "Dal tadka with Steamed rice",
                                        "Sambar with Steamed rice"]          # Sambar + Phulka: regions differ
    combo = combos[1]
    assert combo.kind == "combo" and combo.group == dal.group and combo.extra_recipe_id == "steamed-rice"
    assert combo.quantities_estimated and combo.main_ingredient == "lentil"
    result = run([dal, rice, roti], mode="meals")
    top = result.items[0]
    assert top.candidate.kind == "combo"
    assert top.nutrition == engine.total_nutrition(top.candidate, top.servings)    # sum of the parts, nothing invented


def test_combinations_inherit_the_strictest_attributes() -> None:
    dal = _recipe("Dal tadka", "dal", 180, 10, 25, 5, allergens=("milk",), diet_status="inferred", vegan=False)
    rice = _recipe("Rice", "rice", 240, 5, 52, 0.5, diet=("vegan",), vegan=True, allergen_status="inferred")
    [combo] = engine.build_combinations([dal, rice])
    assert combo.diet_classes == {"vegetarian", "vegan"} and combo.vegan is False
    assert combo.allergens == {"milk"}
    assert (combo.diet_status, combo.allergen_status) == ("inferred", "inferred")


# ================================================================== fallbacks and statuses

def test_empty_catalogue() -> None:
    result = run([])
    assert (result.status, result.items, result.considered) == ("empty_catalogue", (), 0)


def test_mode_selects_candidate_kinds() -> None:
    food = cand("Dal", **DAL_RICE)
    assert run([food], mode="meals").status == "empty_catalogue"
    assert names(run([food], mode="foods")) == ["Dal"]


def test_everything_excluded_by_constraints() -> None:
    result = run([cand("Chicken", **DAL_RICE, diet=("meat",)), cand("Fish", **DAL_RICE, diet=("fish",))],
                 ctx(diet="vegetarian"))
    assert (result.status, result.items) == ("excluded_by_constraints", ())
    assert "exclude every option" in result.notes[-1]


def test_insufficient_data_when_nothing_can_be_confirmed() -> None:
    result = run([cand("Dal", **DAL_RICE, allergen_status="inferred"), cand("Rice", **DAL_RICE, complete=False)],
                 ctx(allergies=frozenset({"peanut"})))
    assert result.status == "insufficient_data"
    assert "reviewed allergen information" in result.notes[-1]


def test_no_fit_when_nothing_suits_the_budget() -> None:
    huge = cand("Feast", 3000, 100, 300, 120)
    tiny = cand("Pickle", 20, 0, 2, 1)
    result = run([huge, tiny])
    assert result.status == "no_fit"
    assert result.excluded == {"too_large": 1, "too_small": 1}
    assert "Nothing fits a 700 kcal lunch" in result.notes[-1]


def test_partial_results_are_not_padded() -> None:
    fits = cand("Dal", **DAL_RICE)
    poor = cand("Sweet", 700, 2, 160, 10, meal_types=("snack",), verification="unverified",
                dish_type="sweet", diet_status="unknown", allergen_status="unknown")
    result = run([fits, poor], count=3)
    assert names(result) == ["Dal"]
    assert result.status == "partial"
    assert result.excluded == {"low_score": 1}
    assert "no weaker ones were added" in result.notes[-1]


def test_light_mode_recommends_only_light_options() -> None:
    fruit = cand("Fruit", 75, 1, 18, 0.3, meal_types=("snack",), main="fruit")
    meal = cand("Thali", **DAL_RICE)
    result = run([fruit, meal], ctx(remaining=Nutrition(50, 2, 5, 1)), meal_type="snack")
    assert names(result) == ["Fruit"] and result.items[0].servings == (2,)
    assert result.budget.mode == "light"


def test_missing_preferences_are_stated() -> None:
    result = run([cand("Dal", **DAL_RICE)], ctx(has_preferences=False))
    assert any("No food preferences are saved" in n for n in result.notes)


def test_limit_keeps_spares_but_status_uses_the_requested_count() -> None:
    cands = [cand(f"Dish {i}", 700 - i, 35, 87, 22, main=f"m{i}", dish_type=f"d{i}") for i in range(6)]
    result = engine.recommend(cands, ctx(), Request(meal_type="lunch", count=2), limit=5)
    assert len(result.items) == 5 and result.status == "ok"


def test_explanations_state_the_fit_without_false_precision() -> None:
    [item] = run([cand("Dal", 347, 18, 43, 11)]).items        # 2 servings: 694 kcal
    assert item.reasons[0] == "About 690 kcal for a 700 kcal lunch budget."
    assert item.fit == "strong"


def test_prep_style_and_countable_labels() -> None:
    assert engine.prep_style("Onion pakora") == "fried"
    assert engine.prep_style("Bhindi masala", "Dry") == "dry"
    assert engine.prep_style("Idli") == "steamed"
    assert engine.prep_style("Plain rice") is None
    assert engine.is_countable_label("1 phulka") and engine.is_countable_label("1 idli")
    assert not engine.is_countable_label("1 katori") and not engine.is_countable_label("2 eggs with gravy")


def test_a_calorie_only_fit_is_not_a_recommendation() -> None:
    # Right energy, carbs and fat under their ceilings, but no protein and the wrong meal type.
    sugar_drink = cand("Sherbet", 700, 0, 80, 20, meal_types=("snack",), diet_status="inferred",
                       allergen_status="inferred")
    result = run([sugar_drink])
    assert result.items == () and result.excluded == {"low_score": 1}
    assert result.status == "no_fit"


# ================================================================== personalization (Task 4)

def test_preferred_meal_styles_and_prep_time_are_soft_signals() -> None:
    curry = cand("Paneer curry", **DAL_RICE, dish_type="curry", main="paneer")
    khichdi = cand("Khichdi", **DAL_RICE, dish_type="one_pot", main="rice")
    styled = run([curry, khichdi], ctx(meal_styles=frozenset({"one_pot"})))
    assert names(styled)[0] == "Khichdi"
    assert styled.items[0].components["preference"] == 1.0
    assert styled.items[1].components["preference"] == pytest.approx(0.4)
    assert any("preferred meal styles" in r for r in styled.items[0].reasons)

    quick = replace(curry, total_minutes=20)
    slow = replace(khichdi, total_minutes=90)
    timed = run([quick, slow], ctx(max_prep_minutes=30))
    assert names(timed)[0] == "Paneer curry"
    assert timed.items[1].components["preference"] == 0.0                   # 90 min >= 2 x 30
    assert any("longer than your 30-minute preference" in r for r in timed.items[1].reasons)
    # Unknown preparation time is not penalised.
    assert engine.preference_score(curry, ctx(max_prep_minutes=30), frozenset()) == 0.6


def test_thali_style_matches_meal_templates_and_combinations() -> None:
    meal = cand("Thali", **DAL_RICE, kind="meal", dish_type="dal")
    assert engine.style_matches(meal, frozenset({"thali"}))
    assert not engine.style_matches(cand("Dal", **DAL_RICE, dish_type="dal"), frozenset({"thali"}))


def test_missing_equipment_is_a_hard_exclusion_unknown_needs_are_not() -> None:
    oven = cand("Baked dish", **DAL_RICE, kind="recipe", equipment=frozenset({"oven", "stove"}))
    unknown = cand("Some dish", **DAL_RICE, kind="recipe")
    have = ctx(equipment=frozenset({"stove", "tawa"}))
    assert engine.hard_exclusion(oven, have) == "equipment_missing"
    assert engine.hard_exclusion(unknown, have) is None
    assert engine.hard_exclusion(oven, ctx()) is None                       # equipment not provided: no filter


def test_combination_needs_both_recipes_equipment_and_the_longer_time() -> None:
    dal = _recipe("Dal tadka", "dal", 180, 10, 25, 5, total_minutes=40,
                  equipment=frozenset({"stove", "pressure_cooker"}))
    rice = _recipe("Rice", "rice", 240, 5, 52, 0.5, regions=("pan_indian",), total_minutes=25,
                   equipment=frozenset({"stove"}))
    [combo] = engine.build_combinations([dal, rice])
    assert combo.total_minutes == 40 and combo.equipment == {"stove", "pressure_cooker"}
    assert engine.build_combinations([dal, replace(rice, equipment=None)])[0].equipment is None


def test_max_kcal_is_a_hard_ceiling() -> None:
    big = cand("Big thali", 900, 40, 110, 30, options=(1,))
    small = cand("Dal", 450, 25, 55, 12, options=(1,))
    result = run([big, small], max_kcal=500)
    assert names(result) == ["Dal"]
    assert result.budget.kcal == 500 and result.excluded == {"over_max_kcal": 1}
    assert all(i.nutrition.kcal <= 500 for i in result.items)


def test_high_protein_requests() -> None:
    lean = cand("Chicken tikka", 650, 55, 40, 25, diet=("meat",), main="chicken", dish_type="a")
    carby = cand("Veg pulao", 700, 15, 110, 20, main="rice", dish_type="b")
    assert set(names(run([lean, carby]))) == {"Chicken tikka", "Veg pulao"}
    high = run([lean, carby], protein="high")
    assert names(high) == ["Chicken tikka"]
    assert high.excluded == {"low_protein": 1}                              # 15 g x 4 / 700 kcal < 20%
    assert high.budget.protein_g == pytest.approx(700 * 0.30 / 4)


def test_cuisine_request_filters_and_alternatives_exclude_shown() -> None:
    dosa = cand("Dosa", **DAL_RICE, regions=("south_indian",), main="rice", dish_type="a")
    roti = cand("Roti", **DAL_RICE, regions=("north_indian",), main="wheat", dish_type="b")
    south = run([dosa, roti], cuisine="South Indian")
    assert names(south) == ["Dosa"] and south.excluded == {"other_cuisine": 1}
    alt = run([dosa, roti], exclude_keys=frozenset({"food:Dosa"}))
    assert names(alt) == ["Roti"] and alt.excluded == {"shown_already": 1}


def test_budget_preference_is_stored_but_never_used() -> None:
    a = run(_catalogue())
    b = run(_catalogue(), ctx(budget="low"))
    assert [i.candidate.key for i in a.items] == [i.candidate.key for i in b.items]
    assert any("no cost information" in n for n in b.notes)


def test_one_users_preferences_do_not_affect_another_request() -> None:
    cands = _catalogue()
    before = run(cands)
    veg = run(cands, ctx(diet="vegetarian"))
    assert "Egg curry" not in names(veg)
    assert run(cands) == before


def test_exclusions_match_common_indian_names_and_say_when_only_names_were_checked() -> None:
    aloo = cand("Aloo pyaz sabzi", **DAL_RICE)
    assert engine.hard_exclusion(aloo, ctx(excluded_ingredients=("onion",))) == "excluded_ingredient"
    assert engine.hard_exclusion(aloo, ctx(excluded_ingredients=("Potatoes",))) == "excluded_ingredient"
    assert engine.matched_term(("aloo",), cand("Potato curry", **DAL_RICE)) == "aloo"
    [item] = run([cand("Moong dal", **DAL_RICE)], ctx(excluded_ingredients=("onion",))).items
    assert any("checked against its name only" in w for w in item.warnings)
    recipe = cand("Dal", **DAL_RICE, kind="recipe", terms=("Dal", "Toor dal", "Ghee"))
    [r] = run([recipe], ctx(excluded_ingredients=("onion",))).items
    assert not any("name only" in w for w in r.warnings)


def test_going_over_what_is_left_today_ranks_lower() -> None:
    fatty = cand("Paneer butter masala", 700, 35, 50, 40, main="paneer", dish_type="a")
    lean = cand("Rajma chawal", 690, 30, 95, 12, main="rajma", dish_type="b")
    plenty = run([fatty, lean])
    assert "overshoot" not in plenty.items[0].adjustments
    no_fat_left = run([fatty, lean], ctx(remaining=Nutrition(900, 60, 150, 0)))
    assert names(no_fat_left)[0] == "Rajma chawal"
    over = next(i for i in no_fat_left.items if i.candidate.name == "Paneer butter masala") \
        if "Paneer butter masala" in names(no_fat_left) else None
    if over:
        assert over.adjustments["overshoot"] == pytest.approx(0.15)          # 360 kcal over, capped
    # Light mode (day already over): no overshoot penalty, or every option would vanish.
    assert engine.overshoot_penalty(Nutrition(150, 5, 20, 5), ctx(remaining=Nutrition(50, 0, 0, 0))) == 0
    assert engine.overshoot_penalty(Nutrition(150, 5, 20, 5), ctx(targets=None, remaining=None)) == 0


def test_known_meal_type_mismatch_is_an_adjustment() -> None:
    curry = cand("Fish curry", **DAL_RICE, meal_types=("lunch", "dinner"), diet=("fish",))
    [item] = run([curry], meal_type="lunch").items
    assert "meal_type" not in item.adjustments
    dinner_only = run([replace(curry, meal_types=frozenset({"dinner"}))], meal_type="lunch")
    assert all(i.adjustments.get("meal_type") == 0.10 for i in dinner_only.items)
    unknown = run([replace(curry, meal_types=frozenset())], meal_type="lunch")
    assert all("meal_type" not in i.adjustments for i in unknown.items)


# ================================================================== optional components (template review)

from app.recommendations.models import AddOn  # noqa: E402


def _thali_with(*addons: AddOn) -> Candidate:
    return cand("Roti dal thali", 0, 0, 0, 0, kind="meal", parts=(
        part(300, 9, 54, 6, ref="roti", options=engine.range_options(1, 4, 1), default=2),
        part(400, 26, 34, 16, ref="dal", options=engine.range_options(0.5, 2, 0.5), default=1),
    ), addons=addons)


def _addon(name: str, kcal: float, *, diet: str = "vegetarian", diet_status: str = "inferred",
           allergens: tuple[str, ...] = (), allergen_status: str = "inferred", flags: tuple[str, ...] = ()) -> AddOn:
    return AddOn(part=part(kcal, 1, 5, 1, ref=name, options=(1.0,)), diet_classes=frozenset({diet}),
                 diet_status=diet_status, allergens=frozenset(allergens), allergen_status=allergen_status,
                 quality_flags=frozenset(flags))


def test_optional_components_do_not_change_the_base_meal_or_its_score() -> None:
    tea = _addon("Hot tea", 34, allergens=("milk",), flags=("density_assumed",))
    plain, with_tea = run([_thali_with()]).items[0], run([_thali_with(tea)]).items[0]
    assert (plain.nutrition, plain.score, plain.servings) == (with_tea.nutrition, with_tea.score, with_tea.servings)
    assert with_tea.addons == (tea,) and with_tea.addons_withheld == ()
    assert any("Optional Hot tea may contain milk (not a reviewed allergen list)" in w for w in with_tea.warnings)
    assert any("Optional Hot tea: amount converted from volume with an assumed density" in w for w in with_tea.warnings)


def test_each_optional_component_passes_the_same_hard_filters() -> None:
    egg = _addon("Boiled egg", 78, diet="egg")
    raita = _addon("Onion raita", 90)
    mystery = _addon("Mystery pickle", 20, diet="unknown", diet_status="unknown")
    thali = _thali_with(egg, raita, mystery)
    veg = run([thali], ctx(diet="vegetarian", excluded_ingredients=("onion",))).items[0]
    assert veg.addons == ()
    assert dict(veg.addons_withheld) == {"Boiled egg": "diet_conflict", "Onion raita": "excluded_ingredient",
                                         "Mystery pickle": "diet_unknown"}
    assert any("Optional Boiled egg isn't offered: not suitable for your diet." in w for w in veg.warnings)
    anyone = run([thali]).items[0]
    assert [a.part.name for a in anyone.addons] == ["Boiled egg", "Onion raita", "Mystery pickle"]


def test_an_allergy_withholds_unreviewed_add_ons_but_keeps_reviewed_ones() -> None:
    reviewed = _addon("Lemon wedge", 2, diet="vegan", diet_status="reviewed", allergen_status="reviewed")
    unreviewed = _addon("Coconut chutney", 67)
    offered, withheld = engine.split_addons(_thali_with(reviewed, unreviewed), ctx(allergies=frozenset({"milk"})))
    assert [a.part.name for a in offered] == ["Lemon wedge"]
    assert withheld == (("Coconut chutney", "allergen_unverified"),)


def test_no_allergens_detected_is_never_presented_as_allergen_free() -> None:
    [item] = run([cand("Dal", **DAL_RICE, allergen_status="inferred")]).items
    assert "No allergens were detected from names and ingredients; this is not an allergen-free check." in item.warnings
    assert not any("allergen-free" in w and "not an allergen-free" not in w for w in item.warnings)
    [reviewed] = run([cand("Dal", **DAL_RICE, allergen_status="reviewed")]).items
    assert not any("allergen-free" in w for w in reviewed.warnings)


def test_provisionally_approved_meals_say_so_and_rank_the_same() -> None:
    thali = _thali_with()
    provisional = run([replace(thali, approval_level="provisional")]).items[0]
    verified = run([replace(thali, approval_level="verified")]).items[0]
    assert provisional.score == verified.score and provisional.nutrition == verified.nutrition
    assert any("provisionally approved" in w for w in provisional.warnings)
    assert not any("provisionally approved" in w for w in verified.warnings)
    unknown = run([replace(thali, approval_level=None)]).items[0]          # no level recorded: treated as provisional
    assert any("provisionally approved" in w for w in unknown.warnings)
