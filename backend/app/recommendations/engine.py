"""Deterministic recommendation engine: pure functions, no I/O, no LLM.

recommend() runs the pipeline:
  1. meal_budget()          the meal's energy and macro targets
  2. build_combinations()   main dish + rice/bread recipe pairings
  3. hard_exclusion()       safety and data constraints: excluded, never scored
  4. best_portion()         the portion that best fits the budget
  5. calorie gate           too small / too large for this meal: excluded
  6. score components       each in [0, 1], combined with configurable weights
  7. diversify()            greedy re-rank so results differ from each other
  8. explain()              reasons and data-quality warnings

Same inputs -> same output: every sort has a total, explicit key and nothing
depends on dict/set iteration order or the clock. The formula and the reasons
for each weight are in docs/recommendation-scoring.md.
"""

from __future__ import annotations

import itertools
import math
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import replace

from app.recommendations.config import (
    ASSUMED_DAILY,
    DEFAULT_CONFIG,
    LIGHT_MEAL_KCAL,
    LIGHT_THRESHOLD_KCAL,
    MEAL_SHARE,
    MEAL_STYLES,
    VERIFICATION_QUALITY,
    CalorieBand,
    EngineConfig,
    Weights,
    calorie_band,
    protein_focus,
)
from app.recommendations.models import (
    KIND_ORDER,
    AddOn,
    ZERO,
    Candidate,
    EngineResult,
    MealBudget,
    Nutrition,
    Recommendation,
    Request,
    UserContext,
    normalize,
)

# ------------------------------------------------------------------ constants

# Diet -> diet classes it allows. Vegan and Jain additionally require a
# reviewed vegan_compatible / jain_compatible = true on every ingredient.
DIET_ALLOWED: dict[str, frozenset[str] | None] = {
    "omnivore": None,
    "eggetarian": frozenset({"vegan", "vegetarian", "egg"}),
    "vegetarian": frozenset({"vegan", "vegetarian"}),
    "pescatarian": frozenset({"vegan", "vegetarian", "egg", "fish"}),
    "vegan": frozenset({"vegan"}),
    "jain": frozenset({"vegan", "vegetarian"}),
}
DIET_LABEL = {"eggetarian": "Eggetarian", "vegetarian": "Vegetarian", "pescatarian": "Pescatarian",
              "vegan": "Vegan", "jain": "Jain"}
ALLERGEN_LABEL = {"peanut": "peanut", "tree_nut": "tree nuts", "milk": "milk", "egg": "egg",
                  "wheat_gluten": "wheat/gluten", "soy": "soy", "fish": "fish", "shellfish": "shellfish",
                  "sesame": "sesame", "mustard": "mustard"}

# Exclusion reasons, grouped for the status decision.
CONSTRAINT_REASONS = ("diet_conflict", "allergen_present", "excluded_ingredient", "equipment_missing",
                      "never_feedback")
DATA_REASONS = ("diet_unknown", "diet_unverified", "allergen_unverified", "incomplete_nutrition",
                "unreliable_nutrition")
FIT_REASONS = ("too_small", "too_large", "over_max_kcal", "low_protein", "other_cuisine", "shown_already",
               "low_score")
REASON_LABEL = {
    "diet_conflict": "Not suitable for your diet",
    "allergen_present": "Contains one of your allergens",
    "excluded_ingredient": "Contains an ingredient you excluded",
    "equipment_missing": "Needs equipment you don't have",
    "never_feedback": "You chose never to see it",
    "diet_unknown": "Diet classification unknown",
    "diet_unverified": "Vegan/Jain suitability not reviewed",
    "allergen_unverified": "Allergen information not reviewed",
    "incomplete_nutrition": "Nutrition data incomplete",
    "unreliable_nutrition": "Nutrition values inconsistent",
    "too_small": "Too small for this meal",
    "too_large": "Too large for this meal",
    "over_max_kcal": "Above your calorie limit",
    "low_protein": "Not high in protein",
    "other_cuisine": "Not the cuisine you asked for",
    "shown_already": "Already shown",
    "low_score": "Poor overall fit",
}

STATUS_ORDER = {"unknown": 0, "inferred": 1, "reviewed": 2}

# Cuisine preference (free text) -> regions.
CUISINE_REGIONS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("south_indian", ("south", "tamil", "kerala", "karnataka", "andhra", "telugu", "chettinad", "udupi", "malayali")),
    ("north_indian", ("north", "punjabi", "mughlai", "kashmiri", "delhi", "awadhi", "lucknowi", "himachali")),
    ("east_indian", ("east", "bengali", "odia", "oriya", "assamese", "bihari")),
    ("west_indian", ("west", "gujarati", "maharashtrian", "marathi", "goan", "rajasthani", "parsi", "sindhi")),
    ("pan_indian", ("indian", "pan indian")),
)
REGION_LABEL = {"south_indian": "South Indian", "north_indian": "North Indian", "east_indian": "East Indian",
                "west_indian": "West Indian", "pan_indian": "Indian"}

# Preparation style from the dish name (diversity only).
PREP_STYLES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("fried", ("fried", "fry", "pakora", "pakoda", "bhajji", "bhaji", "vada", "samosa", "puri", "poori",
               "kachori", "tikki", "bonda", "chips", "bhatura")),
    ("steamed", ("idli", "dhokla", "steamed", "momo", "momos", "puttu", "idiyappam", "modak")),
    ("grilled", ("tandoori", "grilled", "tikka", "kebab", "kabab", "roasted", "roast")),
    ("gravy", ("curry", "gravy", "korma", "makhani", "kadhi", "sambar", "rasam", "masala")),
    ("raw", ("salad", "raita", "chaat", "sprouts")),
)

# Recipe serving labels measured in containers are divisible ("1 katori" -> 0.5..2);
# others ("1 phulka", "1 idli") are counted in whole pieces.
CONTAINER_WORDS = frozenset({"katori", "bowl", "plate", "cup", "glass", "serving", "tbsp", "tsp", "ladle",
                             "portion", "slice"})

# English <-> common Indian names, so a dislike or exclusion of "onion" also
# matches "pyaz" (single dishes have no ingredient list, only a name).
INGREDIENT_SYNONYMS: tuple[tuple[str, ...], ...] = (
    ("onion", "pyaz", "pyaaz", "kanda"), ("potato", "aloo", "batata"), ("garlic", "lahsun", "lehsun"),
    ("tomato", "tamatar"), ("cauliflower", "gobi"), ("spinach", "palak"), ("chickpea", "chana", "chole"),
    ("okra", "bhindi"), ("eggplant", "brinjal", "baingan"), ("bitter gourd", "karela"),
    ("paneer", "cottage cheese"), ("peas", "matar"), ("mushroom", "khumb"), ("coconut", "nariyal"),
    ("peanut", "groundnut", "moongphali"), ("cashew", "kaju"), ("ginger", "adrak"), ("curd", "dahi", "yogurt"),
    ("chicken", "murgh"), ("mutton", "gosht"), ("fish", "machli", "machhi"), ("egg", "anda"),
    ("kidney bean", "rajma"), ("fenugreek", "methi"), ("jackfruit", "kathal"), ("radish", "mooli"),
)

COMBO_MAIN_TYPES = ("dal", "curry", "sabzi", "egg_dish")
COMBO_BASE_TYPES = ("bread", "rice")


# ------------------------------------------------------------------ small helpers

def fmt_kcal(x: float) -> str:
    return f"{round(x):,}"


def about_kcal(x: float) -> str:
    """Estimates are shown to the nearest 10 kcal: more digits would be false precision."""
    return f"{int(round(x / 10.0) * 10):,}"


def _ramp(x: float, zero_at: float, full_at: float) -> float:
    if full_at == zero_at:
        return 1.0 if x >= full_at else 0.0
    return min(1.0, max(0.0, (x - zero_at) / (full_at - zero_at)))


def _contains_term(term: str, texts: Iterable[str]) -> bool:
    term = normalize(term)
    if not term:
        return False
    pattern = re.compile(rf"\b{re.escape(term)}(?:e?s)?\b")
    return any(pattern.search(t) for t in texts)


def is_countable_label(label: str) -> bool:
    words = normalize(label).split()
    return len(words) >= 2 and words[0] == "1" and words[1] not in CONTAINER_WORDS


def portion_options(countable: bool, cfg: EngineConfig = DEFAULT_CONFIG) -> tuple[float, ...]:
    return cfg.countable_portions if countable else cfg.divisible_portions


def range_options(lo: float, hi: float, step: float) -> tuple[float, ...]:
    """min..max in steps (template components), without float drift."""
    n = int(round((hi - lo) / step)) if step > 0 else 0
    return tuple(round(lo + i * step, 4) for i in range(n + 1))


def prep_style(*names: str | None) -> str | None:
    text = " ".join(normalize(n) for n in names if n)
    if re.search(r"\bdry\b", text):
        return "dry"
    for style, words in PREP_STYLES:
        if any(re.search(rf"\b{w}\b", text) for w in words):
            return style
    return None


def cuisine_regions(cuisines: Sequence[str]) -> frozenset[str]:
    found: set[str] = set()
    for c in cuisines:
        text = normalize(c)
        for region, words in CUISINE_REGIONS:
            if any(re.search(rf"\b{w}\b", text) for w in words):
                found.add(region)
                break
    return frozenset(found)


def worst_status(*statuses: str) -> str:
    return min(statuses, key=lambda s: STATUS_ORDER.get(s, 0))


def _and3(*values: bool | None) -> bool | None:
    """True only if all true; False if any false; otherwise unknown."""
    if any(v is False for v in values):
        return False
    if all(v is True for v in values):
        return True
    return None


# ------------------------------------------------------------------ 1. budget

def meal_budget(ctx: UserContext, req: Request, cfg: EngineConfig = DEFAULT_CONFIG) -> MealBudget:
    meal = req.meal_type
    notes: list[str] = []
    if ctx.targets is None:
        daily = Nutrition(ASSUMED_DAILY["kcal"], ASSUMED_DAILY["protein_g"], ASSUMED_DAILY["carbs_g"],
                          ASSUMED_DAILY["fat_g"])
        remaining = Nutrition(daily.kcal - ctx.consumed.kcal, daily.protein_g - ctx.consumed.protein_g,
                              daily.carbs_g - ctx.consumed.carbs_g, daily.fat_g - ctx.consumed.fat_g)
        basis = "assumed"
        notes.append("You have no daily targets yet, so this assumes a 2,000 kcal day. "
                     "Complete your profile for personal targets.")
    else:
        daily = ctx.targets
        remaining = ctx.remaining if ctx.remaining is not None else ctx.targets
        basis = "targets"

    planned = daily.kcal * MEAL_SHARE[meal]
    rem = remaining.kcal
    if req.target_kcal is not None:
        kcal, mode = float(req.target_kcal), "requested"
        notes.append(f"Using the {fmt_kcal(kcal)} kcal you asked for.")
    elif rem <= LIGHT_THRESHOLD_KCAL:
        kcal, mode = LIGHT_MEAL_KCAL, "light"
        if rem < 0:
            notes.append(f"You are {fmt_kcal(-rem)} kcal over today's target. "
                         "These are light options in case you are still hungry.")
        else:
            notes.append(f"Only {fmt_kcal(rem)} kcal are left today, so these are light options.")
    elif rem < planned:
        kcal, mode = rem, "capped"
        notes.append(f"{meal.capitalize()} is normally about {fmt_kcal(planned)} kcal; "
                     f"this is limited to the {fmt_kcal(rem)} kcal left today.")
    else:
        kcal, mode = planned, "planned"
        if meal == "dinner" and rem > planned * 1.75:
            notes.append(f"You still have {fmt_kcal(rem)} kcal left today; dinner is planned at "
                         f"{fmt_kcal(planned)} kcal. Ask for a larger meal if this is your last one.")

    if req.max_kcal is not None and kcal > req.max_kcal:
        notes.append(f"Limited to your maximum of {fmt_kcal(req.max_kcal)} kcal.")
        kcal = float(req.max_kcal)

    # Macro targets: the meal's share of what is left (never negative). In light
    # mode nothing meaningful is left, so a neutral split of the light budget is used.
    if rem > LIGHT_THRESHOLD_KCAL:
        frac = kcal / rem
        protein, carbs, fat = (max(0.0, remaining.protein_g) * frac, max(0.0, remaining.carbs_g) * frac,
                               max(0.0, remaining.fat_g) * frac)
    else:
        frac = kcal / daily.kcal if daily.kcal > 0 else 0.0
        protein, carbs, fat = daily.protein_g * frac, daily.carbs_g * frac, daily.fat_g * frac

    if req.protein == "high":
        protein = max(protein, kcal * cfg.high_protein_share / 4.0)
    cap = kcal * cfg.max_protein_kcal_share / 4.0
    if protein > cap:
        notes.append(f"The {round(protein)} g of protein still to reach is more than one {fmt_kcal(kcal)} kcal "
                     f"meal can realistically provide, so options are scored against {round(cap)} g.")
        protein = cap

    return MealBudget(meal_type=meal, kcal=kcal, protein_g=protein, carbs_g=carbs, fat_g=fat, basis=basis,
                      mode=mode, remaining_kcal=None if ctx.targets is None else rem,
                      notes=tuple(notes))


# ------------------------------------------------------------------ 2. combinations

def _is_dish(c: Candidate, types: Sequence[str]) -> bool:
    return c.dish_type in types


def build_combinations(recipes: Sequence[Candidate]) -> list[Candidate]:
    """Pairs a published main recipe (dal, curry, sabzi, egg dish) with a
    published rice or bread recipe when they share a meal type and a region
    (pan-Indian goes with anything). Nutrition is never estimated: each part
    keeps its own recipe's per-serving values."""
    mains = sorted((r for r in recipes if r.kind == "recipe" and r.complete and _is_dish(r, COMBO_MAIN_TYPES)),
                   key=lambda r: r.key)
    bases = sorted((r for r in recipes if r.kind == "recipe" and r.complete and _is_dish(r, COMBO_BASE_TYPES)),
                   key=lambda r: r.key)
    combos: list[Candidate] = []
    for m in mains:
        for b in bases:
            meals = m.meal_types & b.meal_types
            if not meals:
                continue
            mr, br = m.regions - {"pan_indian"}, b.regions - {"pan_indian"}
            if mr and br and not (mr & br):
                continue
            key = f"combo:{m.recipe_id}+{b.recipe_id}"
            combos.append(Candidate(
                kind="combo", key=key, group=m.group, name=f"{m.name} with {b.name}",
                variant=m.variant,
                parts=tuple(replace(p, slot="main") for p in m.parts) + tuple(replace(p, slot="base") for p in b.parts),
                complete=True, meal_types=meals, regions=m.regions | b.regions, dish_type=m.dish_type,
                main_ingredient=m.main_ingredient, prep_style=m.prep_style, terms=m.terms + b.terms,
                dish_names=m.dish_names | b.dish_names, dish_food_ids=m.dish_food_ids | b.dish_food_ids,
                diet_classes=m.diet_classes | b.diet_classes,
                diet_status=worst_status(m.diet_status, b.diet_status),
                vegan=_and3(m.vegan, b.vegan), jain=_and3(m.jain, b.jain),
                allergens=m.allergens | b.allergens,
                allergen_status=worst_status(m.allergen_status, b.allergen_status),
                quality_flags=m.quality_flags | b.quality_flags, source=m.source,
                verification=min(m.verification, b.verification, key=lambda v: VERIFICATION_QUALITY.get(v, 0)),
                quantities_estimated=m.quantities_estimated or b.quantities_estimated,
                history_keys=m.history_keys + b.history_keys + (key,),
                feedback_keys=m.feedback_keys + b.feedback_keys,
                recipe_id=m.recipe_id, family_id=m.family_id, extra_recipe_id=b.recipe_id,
                # Cooked side by side: the longer of the two. Equipment: both recipes' needs.
                total_minutes=(max(m.total_minutes, b.total_minutes)
                               if m.total_minutes is not None and b.total_minutes is not None else None),
                equipment=(m.equipment | b.equipment
                           if m.equipment is not None and b.equipment is not None else None)))
    return combos


# ------------------------------------------------------------------ 3. hard constraints

def hard_exclusion(c: Candidate, ctx: UserContext, cfg: EngineConfig = DEFAULT_CONFIG) -> str | None:
    """The first constraint the candidate breaks, or None. Applied before any
    scoring: no score can bring an excluded candidate back."""
    # The user's own constraints first (most informative reason).
    if any(ctx.feedback.get(k) == "never" for k in c.feedback_keys):
        return "never_feedback"
    allowed = DIET_ALLOWED.get(ctx.diet or "omnivore")
    if allowed is not None and (c.diet_classes - {"unknown"}) - allowed:
        return "diet_conflict"
    if ctx.allergies & c.allergens:
        return "allergen_present"
    if ctx.excluded_ingredients and matched_term(ctx.excluded_ingredients, c) is not None:
        return "excluded_ingredient"
    if ctx.equipment is not None and c.equipment is not None and not c.equipment <= ctx.equipment:
        return "equipment_missing"
    # Then what we cannot confirm.
    if allowed is not None:
        if "unknown" in c.diet_classes or c.diet_status == "unknown":
            return "diet_unknown"
        if ctx.diet == "vegan" and c.vegan is not True:
            return "diet_unverified"
        if ctx.diet == "jain" and c.jain is not True:
            return "diet_unverified"
    # Detected-allergen lists are presence-only; absence is trusted only after review.
    if ctx.allergies and c.allergen_status != "reviewed":
        return "allergen_unverified"
    if not c.complete or not c.parts:
        return "incomplete_nutrition"
    if c.quality_flags & cfg.excluded_flags:
        return "unreliable_nutrition"
    return None


def term_variants(term: str) -> tuple[str, ...]:
    """The term, its singular ("potatoes" -> "potato") and its synonyms."""
    t = normalize(term)
    forms = [t]
    for suffix in ("es", "s"):
        if t.endswith(suffix) and len(t) > len(suffix) + 2:
            forms.append(t[: -len(suffix)])
    for group in INGREDIENT_SYNONYMS:
        if any(f in group for f in forms):
            return tuple(dict.fromkeys([*forms, *group]))
    return tuple(dict.fromkeys(forms))


def matched_term(terms: Sequence[str], c: Candidate) -> str | None:
    """The first of `terms` found (whole word, plural-aware, with common Indian
    names) in the candidate's name, variant or ingredient/component names."""
    texts = [normalize(t) for t in c.terms]
    return next((t for t in terms if any(_contains_term(v, texts) for v in term_variants(t))), None)


def addon_exclusion(a: AddOn, c: Candidate, ctx: UserContext, cfg: EngineConfig = DEFAULT_CONFIG) -> str | None:
    """The same hard rules as a whole dish, applied to one optional component
    with its own attributes (unknown or unreviewed data is just as conservative)."""
    probe = replace(c, kind="food", name=a.part.name, variant=None, parts=(a.part,), complete=True,
                    terms=(a.part.name,), diet_classes=a.diet_classes, diet_status=a.diet_status, vegan=a.vegan,
                    jain=a.jain, allergens=a.allergens, allergen_status=a.allergen_status,
                    quality_flags=a.quality_flags, feedback_keys=(), equipment=None, addons=())
    return hard_exclusion(probe, ctx, cfg)


def split_addons(c: Candidate, ctx: UserContext, cfg: EngineConfig = DEFAULT_CONFIG
                 ) -> tuple[tuple[AddOn, ...], tuple[tuple[str, str], ...]]:
    offered: list[AddOn] = []
    withheld: list[tuple[str, str]] = []
    for a in c.addons:
        reason = addon_exclusion(a, c, ctx, cfg)
        if reason is None:
            offered.append(a)
        else:
            withheld.append((a.part.name, reason))
    return tuple(offered), tuple(withheld)


def request_exclusion(c: Candidate, req: Request) -> str | None:
    """Filters the request asked for (not safety): alternatives and cuisine."""
    if c.key in req.exclude_keys:
        return "shown_already"
    if req.cuisine:
        wanted = cuisine_regions([req.cuisine])
        if wanted and not (c.regions & wanted):
            return "other_cuisine"
    return None


# ------------------------------------------------------------------ 4-6. portions and scores

def calorie_score(kcal: float, target: float, band: CalorieBand) -> float:
    if target <= 0:
        return 0.0
    r = kcal / target
    if r < band.zero_low or r > band.zero_high:
        return 0.0
    if r < band.full_low:
        return _ramp(r, band.zero_low, band.full_low)
    if r > band.full_high:
        return 1.0 - _ramp(r, band.full_high, band.zero_high)
    return 1.0


def calorie_gate(kcal: float, target: float, band: CalorieBand) -> str | None:
    r = kcal / target if target > 0 else math.inf
    if r < band.zero_low:
        return "too_small"
    if r > band.zero_high:
        return "too_large"
    return None


def protein_score(protein: float, target: float, cfg: EngineConfig = DEFAULT_CONFIG) -> float:
    if target <= 0:
        return 1.0
    return min(1.0, protein / (target * cfg.protein_full_at))


def ceiling_score(value: float, target: float, cfg: EngineConfig = DEFAULT_CONFIG) -> float:
    """Carbs and fat: anything up to the target (+ tolerance) is fine; more is penalised."""
    full = max(0.0, target) * cfg.ceiling_full_ratio + cfg.ceiling_full_slack_g
    zero = max(0.0, target) * cfg.ceiling_zero_ratio + cfg.ceiling_zero_slack_g
    if value <= full:
        return 1.0
    return 1.0 - _ramp(value, full, zero)


def nutrition_components(n: Nutrition, budget: MealBudget, band: CalorieBand,
                         cfg: EngineConfig = DEFAULT_CONFIG) -> dict[str, float]:
    return {
        "calories": calorie_score(n.kcal, budget.kcal, band),
        "protein": protein_score(n.protein_g, budget.protein_g, cfg),
        "carbs": ceiling_score(n.carbs_g, budget.carbs_g, cfg),
        "fat": ceiling_score(n.fat_g, budget.fat_g, cfg),
    }


def _weighted(components: dict[str, float], weights: dict[str, float]) -> float:
    total = sum(weights[k] for k in components)
    return sum(components[k] * weights[k] for k in components) / total if total else 0.0


def portion_choices(c: Candidate, cfg: EngineConfig = DEFAULT_CONFIG) -> list[tuple[float, ...]]:
    options = [p.options for p in c.parts]
    if math.prod(len(o) for o in options) <= cfg.max_combinations:
        return list(itertools.product(*options))
    # Too many combinations: scale every part together from its default.
    out: list[tuple[float, ...]] = []
    for f in (0.5, 0.75, 1.0, 1.25, 1.5, 2.0):
        choice = tuple(min(p.options, key=lambda o, p=p: (abs(o - p.default * f), o)) for p in c.parts)
        if choice not in out:
            out.append(choice)
    return out


def total_nutrition(c: Candidate, servings: Sequence[float]) -> Nutrition:
    n = ZERO
    for p, s in zip(c.parts, servings, strict=True):
        n = n + p.per_serving.scaled(s)
    return n


def best_portion(c: Candidate, budget: MealBudget, band: CalorieBand, weights: Weights,
                 cfg: EngineConfig = DEFAULT_CONFIG, max_kcal: float | None = None
                 ) -> tuple[tuple[float, ...], Nutrition, dict[str, float]]:
    """The servings that best fit the budget. Preference order: inside the
    calorie band, best nutrition fit, closest to the default servings, smaller."""
    w = weights.nutrition()
    best: tuple[tuple, tuple[float, ...], Nutrition, dict[str, float]] | None = None
    for servings in portion_choices(c, cfg):
        n = total_nutrition(c, servings)
        comps = nutrition_components(n, budget, band, cfg)
        fits = calorie_gate(n.kcal, budget.kcal, band) is None and (max_kcal is None or n.kcal <= max_kcal)
        deviation = sum(abs(s - p.default) / p.default for p, s in zip(c.parts, servings, strict=True))
        key = (fits, round(_weighted(comps, w), 9), -round(deviation, 9), -sum(servings), tuple(-s for s in servings))
        if best is None or key > best[0]:
            best = (key, tuple(servings), n, comps)
    assert best is not None
    return best[1], best[2], best[3]


def meal_type_score(c: Candidate, meal: str) -> float:
    if meal in c.meal_types:
        return 1.0
    return 0.5 if not c.meal_types else 0.0


def preference_score(c: Candidate, ctx: UserContext, wanted: frozenset[str],
                     cfg: EngineConfig = DEFAULT_CONFIG) -> float:
    """Mean of the preference signals the user has set (cuisine, meal style,
    preparation time); neutral when none applies, so it cannot reorder anything."""
    signals: list[float] = []
    if wanted:
        if c.regions & wanted:
            signals.append(1.0)
        elif "pan_indian" in c.regions:
            signals.append(0.7)
        else:
            signals.append(0.5 if not c.regions else 0.3)
    if ctx.meal_styles:
        signals.append(1.0 if style_matches(c, ctx.meal_styles) else cfg.style_miss_score)
    if ctx.max_prep_minutes and c.total_minutes is not None:
        limit = ctx.max_prep_minutes
        signals.append(1.0 if c.total_minutes <= limit else 1.0 - _ramp(c.total_minutes, limit, 2 * limit))
    return sum(signals) / len(signals) if signals else cfg.neutral_preference


def style_matches(c: Candidate, styles: frozenset[str]) -> bool:
    if "thali" in styles and c.kind in ("meal", "combo"):
        return True
    return any(c.dish_type in MEAL_STYLES.get(s, frozenset()) for s in styles)


def variety_score(c: Candidate, ctx: UserContext) -> float:
    name = normalize(c.name)
    if (c.food_id and c.food_id in ctx.today_food_ids) or name in ctx.today_names:
        return 0.0
    if (c.food_id and c.food_id in ctx.yesterday_food_ids) or name in ctx.yesterday_names:
        return 0.5
    if (c.dish_food_ids & ctx.today_food_ids) or (c.dish_names & ctx.today_names):
        return 0.6
    return 1.0


def _events(c: Candidate, ctx: UserContext, window: float) -> list[tuple[str, float]]:
    return sorted((e for k in c.history_keys for e in ctx.events.get(k, ()) if e[1] <= window),
                  key=lambda e: (e[1], e[0]))


def history_score(c: Candidate, ctx: UserContext, cfg: EngineConfig = DEFAULT_CONFIG) -> float:
    """Positive affinity from what the user did before. Viewing is not liking:
    'viewed' is ignored. Saving or liking, and choosing it (selected, planned,
    logged) count for it. Negative signals are adjustments (see
    rejection_penalty), so they cannot be diluted by the weight."""
    feedback = {ctx.feedback.get(k) for k in c.feedback_keys}
    events = _events(c, ctx, cfg.history_window_days)
    s = cfg.history_base
    if feedback & {"liked", "saved"}:
        s = 1.0
    chosen = sum(1 for e, _ in events if e in ("selected", "planned", "logged"))
    return min(1.0, s + cfg.selected_bonus * min(chosen, 2))


def rejection_penalty(c: Candidate, ctx: UserContext, cfg: EngineConfig = DEFAULT_CONFIG) -> float:
    """'Not interested' / 'less often' lasts while that feedback does (180 days);
    a plain rejection fades: halves every week, gone after the window."""
    if any(ctx.feedback.get(k) == "less_often" for k in c.feedback_keys):
        return cfg.less_often_penalty
    rejections = [age for e, age in _events(c, ctx, cfg.history_window_days) if e == "rejected"]
    if not rejections:
        return 0.0
    return cfg.rejected_penalty * 0.5 ** (min(rejections) / cfg.rejected_half_life_days)


def overshoot_penalty(n: Nutrition, ctx: UserContext, cfg: EngineConfig = DEFAULT_CONFIG) -> float:
    """Carbs or fat beyond what is left TODAY (not just this meal's share).
    Only with real targets and in normal mode: when the day is already over,
    every option would be penalised alike and light options would vanish."""
    r = ctx.remaining
    if ctx.targets is None or r is None or r.kcal <= LIGHT_THRESHOLD_KCAL:
        return 0.0
    over_kcal = 9 * max(0.0, n.fat_g - max(0.0, r.fat_g)) + 4 * max(0.0, n.carbs_g - max(0.0, r.carbs_g))
    return min(cfg.overshoot_max, cfg.overshoot_penalty_per_kcal * max(0.0, over_kcal - cfg.overshoot_slack_kcal))


def novelty_penalty(c: Candidate, ctx: UserContext, cfg: EngineConfig = DEFAULT_CONFIG) -> float:
    """Recently shown or chosen: steps back for a few days, then recovers fully
    (nothing older than the window counts)."""
    ages = [a for k in c.history_keys for a in ctx.shows.get(k, ()) if a <= cfg.novelty_window_days]
    ages += [a for e, a in _events(c, ctx, cfg.novelty_window_days) if e in ("selected", "logged")]
    raw = sum(cfg.novelty_per_show * 0.5 ** (a / cfg.novelty_half_life_days) for a in ages)
    return min(cfg.novelty_max, raw)


def quality_score(c: Candidate, cfg: EngineConfig = DEFAULT_CONFIG) -> float:
    s = VERIFICATION_QUALITY.get(c.verification, 0.5)
    if c.quantities_estimated:
        s -= cfg.estimated_quantities_penalty
    for flag in sorted(c.quality_flags):
        s -= cfg.flag_quality_penalty.get(flag, 0.0)
    worst = worst_status(c.diet_status, c.allergen_status)
    if worst == "inferred":
        s -= cfg.inferred_attributes_penalty
    elif worst == "unknown":
        s -= cfg.unknown_attributes_penalty
    return max(0.0, min(1.0, s))


def fit_label(score: float, cfg: EngineConfig = DEFAULT_CONFIG) -> str:
    if score >= cfg.strong_fit:
        return "strong"
    return "good" if score >= cfg.good_fit else "fair"


def score_candidate(c: Candidate, ctx: UserContext, budget: MealBudget, band: CalorieBand, weights: Weights,
                    wanted_regions: frozenset[str], cfg: EngineConfig = DEFAULT_CONFIG, req: Request | None = None
                    ) -> Recommendation | str:
    """A scored recommendation, or the fit reason it was excluded for."""
    max_kcal = req.max_kcal if req else None
    servings, n, comps = best_portion(c, budget, band, weights, cfg, max_kcal)
    if max_kcal is not None and n.kcal > max_kcal:
        return "over_max_kcal"
    gate = calorie_gate(n.kcal, budget.kcal, band)
    if gate:
        return gate
    if req and req.protein == "high" and n.kcal > 0 and n.protein_g * 4 / n.kcal < cfg.min_protein_share_high:
        return "low_protein"
    comps = {
        **comps,
        "meal_type": meal_type_score(c, budget.meal_type),
        "preference": preference_score(c, ctx, wanted_regions, cfg),
        "variety": variety_score(c, ctx),
        "history": history_score(c, ctx, cfg),
        "quality": quality_score(c, cfg),
    }
    adjustments: dict[str, float] = {}
    novelty = novelty_penalty(c, ctx, cfg)
    if novelty > 0:
        adjustments["novelty"] = novelty
    if ctx.dislikes and matched_term(ctx.dislikes, c) is not None:
        adjustments["dislike"] = cfg.dislike_penalty
    rejected = rejection_penalty(c, ctx, cfg)
    if rejected > 0:
        adjustments["rejected"] = rejected
    overshoot = overshoot_penalty(n, ctx, cfg)
    if overshoot > 0:
        adjustments["overshoot"] = overshoot
    if c.meal_types and budget.meal_type not in c.meal_types:
        adjustments["meal_type"] = cfg.meal_type_mismatch_penalty
    total = _weighted(comps, weights.as_dict()) - sum(adjustments.values())
    if total < cfg.min_score:
        return "low_score"
    offered, withheld = split_addons(c, ctx, cfg)    # ranking uses the base meal only
    return Recommendation(candidate=c, servings=servings, nutrition=n, score=total, components=comps,
                          fit=fit_label(total, cfg), adjustments=adjustments, addons=offered,
                          addons_withheld=withheld)


# ------------------------------------------------------------------ 7. diversity

def _rank_key(r: Recommendation) -> tuple:
    return (-round(r.score, 9), KIND_ORDER[r.candidate.kind], normalize(r.candidate.name), r.candidate.key)


def diversify(ranked: Sequence[Recommendation], limit: int, use_region: bool,
              cfg: EngineConfig = DEFAULT_CONFIG) -> list[Recommendation]:
    """Greedy re-rank: repeatedly take the candidate with the best score after
    penalties for sharing a main ingredient, dish type, preparation style or
    region with those already chosen. One result per group (recipe family,
    template, food) and at most `max_same_main` per main ingredient."""
    pool = sorted(ranked, key=_rank_key)
    chosen: list[Recommendation] = []
    groups: set[str] = set()
    mains: Counter[str] = Counter()
    dish_types: Counter[str] = Counter()
    preps: Counter[str] = Counter()
    regions: Counter[str] = Counter()
    while pool and len(chosen) < limit:
        best: tuple[float, int, float] | None = None
        for i, r in enumerate(pool):
            c = r.candidate
            if c.group in groups:
                continue
            if c.main_ingredient and mains[c.main_ingredient] >= cfg.max_same_main:
                continue
            penalty = 0.0
            if c.main_ingredient:
                penalty += mains[c.main_ingredient] * cfg.penalty_same_main
            if c.dish_type:
                penalty += dish_types[c.dish_type] * cfg.penalty_same_dish_type
            if c.prep_style:
                penalty += preps[c.prep_style] * cfg.penalty_same_prep
            if use_region:
                own = sorted(c.regions - {"pan_indian"})
                penalty += max((regions[x] for x in own), default=0) * cfg.penalty_same_region
            adjusted = r.score - penalty
            if best is None or adjusted > best[0] + 1e-12:     # ties keep the higher base rank
                best = (adjusted, i, penalty)
        if best is None:
            break
        r = pool.pop(best[1])
        c = r.candidate
        chosen.append(replace(r, diversity_penalty=round(best[2], 4)))
        groups.add(c.group)
        if c.main_ingredient:
            mains[c.main_ingredient] += 1
        if c.dish_type:
            dish_types[c.dish_type] += 1
        if c.prep_style:
            preps[c.prep_style] += 1
        for x in c.regions - {"pan_indian"}:
            regions[x] += 1
    return chosen


# ------------------------------------------------------------------ 8. explanations

def explain(r: Recommendation, budget: MealBudget, ctx: UserContext, wanted: frozenset[str]
            ) -> tuple[tuple[str, ...], tuple[str, ...]]:
    c, n, comps = r.candidate, r.nutrition, r.components
    meal = budget.meal_type
    reasons = [f"About {about_kcal(n.kcal)} kcal for a {fmt_kcal(budget.kcal)} kcal {meal} budget."]
    if budget.protein_g >= 5:
        if n.protein_g >= budget.protein_g * 1.25:
            reasons.append(f"About {round(n.protein_g)} g protein, more than the {round(budget.protein_g)} g "
                           f"planned for this meal.")
        elif comps["protein"] >= 0.9:
            reasons.append(f"About {round(n.protein_g)} g protein, close to the {round(budget.protein_g)} g "
                           f"planned for this meal.")
        elif comps["protein"] <= 0.5:
            reasons.append(f"Lower in protein ({round(n.protein_g)} g) than the {round(budget.protein_g)} g "
                           f"planned for this meal.")
    if comps["carbs"] < 0.5:
        reasons.append(f"Higher in carbohydrate ({round(n.carbs_g)} g) than what is left suggests "
                       f"({round(budget.carbs_g)} g).")
    if comps["fat"] < 0.5:
        reasons.append(f"Higher in fat ({round(n.fat_g)} g) than what is left suggests ({round(budget.fat_g)} g).")
    if r.adjustments.get("overshoot", 0) > 0:
        reasons.append("More carbohydrate or fat than you have left today, so it ranks lower.")
    if comps["meal_type"] == 1.0:
        reasons.append(f"Usually eaten at {meal}.")
    elif comps["meal_type"] < 0.5:
        reasons.append(f"Not usually a {meal} dish.")
    matched = sorted(c.regions & wanted)
    if matched:
        reasons.append(f"Matches your {REGION_LABEL[matched[0]]} preference.")
    if ctx.meal_styles and style_matches(c, ctx.meal_styles):
        reasons.append("One of your preferred meal styles.")
    if c.total_minutes is not None:
        if ctx.max_prep_minutes and c.total_minutes > ctx.max_prep_minutes:
            reasons.append(f"Takes about {c.total_minutes} minutes, longer than your "
                           f"{ctx.max_prep_minutes}-minute preference.")
        else:
            reasons.append(f"Takes about {c.total_minutes} minutes to make.")
    disliked = matched_term(ctx.dislikes, c) if ctx.dislikes else None
    if disliked:
        reasons.append(f"Contains {disliked}, which you dislike, so it ranks lower.")
    if comps["variety"] == 0.0:
        reasons.append("You already had this today.")
    elif comps["variety"] == 0.5:
        reasons.append("You had this yesterday.")
    elif comps["variety"] == 0.6:
        reasons.append("Shares a dish with something you ate today.")
    feedback = {ctx.feedback.get(k) for k in c.feedback_keys}
    events = {e for e, _ in _events(c, ctx, 30)}
    if "saved" in feedback:
        reasons.append("You saved this.")
    elif "liked" in feedback:
        reasons.append("You marked this as liked.")
    if events & {"selected", "planned", "logged"}:
        reasons.append("You chose this recently.")
    if "less_often" in feedback:
        reasons.append("You asked to see this less often.")
    elif "rejected" in events:
        reasons.append("You passed on this recently, so it ranks lower.")
    if r.adjustments.get("novelty", 0) >= 0.06:
        reasons.append("Suggested recently, so it steps back a little.")

    warnings: list[str] = []
    if c.kind == "meal" and c.approval_level != "verified":
        warnings.append("This meal combination is provisionally approved: its foods and portions have not been "
                        "individually checked by a person.")
    if c.verification == "unverified":
        warnings.append("Nutrition values are unverified.")
    if c.quantities_estimated:
        warnings.append("Ingredient quantities are typical home amounts, so nutrition is approximate.")
    if "cooking_oil_uncertain" in c.quality_flags:
        warnings.append("Fat and calories may be off: the source recipe's cooking oil amount is uncertain.")
    if "density_assumed" in c.quality_flags:
        warnings.append("Some amounts were converted from volume with an assumed density.")
    if ctx.diet in DIET_LABEL and c.diet_status != "reviewed":
        warnings.append(f"{DIET_LABEL[ctx.diet]} suitability is inferred from names and ingredients "
                        "and has not been reviewed.")
    for a in r.addons:
        if a.allergens:
            listed = ", ".join(ALLERGEN_LABEL.get(x, x) for x in sorted(a.allergens))
            warnings.append(f"Optional {a.part.name} may contain {listed}"
                            + ("." if a.allergen_status == "reviewed" else " (not a reviewed allergen list)."))
        if "density_assumed" in a.quality_flags:
            warnings.append(f"Optional {a.part.name}: amount converted from volume with an assumed density.")
    for name, reason in r.addons_withheld:
        warnings.append(f"Optional {name} isn't offered: {REASON_LABEL.get(reason, reason).lower()}.")
    if not c.allergens and c.allergen_status != "reviewed":
        warnings.append("No allergens were detected from names and ingredients; this is not an allergen-free check.")
    if ctx.excluded_ingredients and c.kind in ("food", "meal"):
        warnings.append("No ingredient list for this dish: your excluded ingredients were checked against "
                        "its name only.")
    if c.allergens:
        listed = ", ".join(ALLERGEN_LABEL.get(a, a) for a in sorted(c.allergens))
        if c.allergen_status == "reviewed":
            warnings.append(f"Contains {listed}.")
        else:
            warnings.append(f"May contain {listed} (detected from names and ingredients; "
                            "not a reviewed allergen list).")
    return tuple(reasons), tuple(warnings)


# ------------------------------------------------------------------ pipeline

def _status(considered: int, items: int, count: int, excluded: Counter[str]) -> str:
    if considered == 0:
        return "empty_catalogue"
    if items == 0:
        constraint = sum(excluded[r] for r in CONSTRAINT_REASONS)
        data = sum(excluded[r] for r in DATA_REASONS)
        if considered - constraint - data > 0:
            return "no_fit"
        return "insufficient_data" if data > 0 and data >= constraint else "excluded_by_constraints"
    return "partial" if items < count else "ok"


def _status_notes(status: str, budget: MealBudget, excluded: Counter[str], ctx: UserContext,
                  found: int) -> list[str]:
    meal = budget.meal_type
    if status == "empty_catalogue":
        return ["No recipes, meals or dishes are available for this request yet."]
    if status == "insufficient_data":
        top = max(DATA_REASONS, key=lambda r: (excluded[r], -DATA_REASONS.index(r)))
        if top == "allergen_unverified":
            return ["No option has reviewed allergen information yet, so nothing can be recommended safely "
                    "for your allergies."]
        if top == "diet_unverified":
            return [f"{DIET_LABEL.get(ctx.diet or '', 'Diet')} suitability must be reviewed before a dish is "
                    "recommended, and no option has been reviewed yet."]
        if top == "diet_unknown":
            return ["The options left have no known diet classification, so none can be confirmed as "
                    "suitable for your diet."]
        return ["The options left lack complete or reliable nutrition data."]
    if status == "excluded_by_constraints":
        return ["Your diet, allergies, excluded ingredients, equipment or \"never\" choices exclude every "
                "option for this meal."]
    if status == "no_fit":
        size = "light" if budget.mode == "light" else f"{fmt_kcal(budget.kcal)} kcal"
        return [f"Nothing fits a {size} {meal} closely enough. Try the flexible tolerance or another meal type."]
    if status == "partial":
        return [f"Only {found} option{'s' if found != 1 else ''} fit well; no weaker ones were added to fill "
                "the list."]
    return []


def recommend(candidates: Sequence[Candidate], ctx: UserContext, req: Request,
              cfg: EngineConfig = DEFAULT_CONFIG, limit: int | None = None) -> EngineResult:
    """Ranks candidates for one meal. `limit` (>= req.count) lets the caller
    keep a few spares in case a pick cannot be priced; status is judged
    against req.count."""
    budget = meal_budget(ctx, req, cfg)
    weights = cfg.weights(ctx.goal)
    if req.protein == "high":
        weights = protein_focus(weights)
    band = calorie_band(req.tolerance, ctx.goal)
    wanted = cuisine_regions(list(ctx.cuisines) + ([req.cuisine] if req.cuisine else []))

    kinds = {"meals": ("recipe", "combo", "meal"), "foods": ("food",), "both": ("recipe", "combo", "meal", "food")}
    pool = [c for c in candidates if c.kind in kinds[req.mode]]
    if "combo" in kinds[req.mode]:
        pool += build_combinations([c for c in candidates if c.kind == "recipe"])
    pool.sort(key=lambda c: c.key)

    excluded: Counter[str] = Counter()
    scored: list[Recommendation] = []
    for c in pool:
        reason = hard_exclusion(c, ctx, cfg) or request_exclusion(c, req)
        if reason is None:
            result = score_candidate(c, ctx, budget, band, weights, wanted, cfg, req)
            if isinstance(result, str):
                reason = result
            else:
                scored.append(result)
                continue
        excluded[reason] += 1

    chosen = diversify(scored, max(limit or req.count, req.count), use_region=not wanted, cfg=cfg)
    items = []
    for r in chosen:
        reasons, warnings = explain(r, budget, ctx, wanted)
        items.append(replace(r, reasons=reasons, warnings=warnings))

    found = min(len(items), req.count)
    status = _status(len(pool), found, req.count, excluded)
    notes = list(budget.notes)
    if not ctx.has_preferences:
        notes.append("No food preferences are saved, so diet and allergies are not being filtered.")
    if ctx.budget:
        notes.append("Your budget preference is saved but not used: the catalogue has no cost information.")
    notes += _status_notes(status, budget, excluded, ctx, found)
    return EngineResult(status=status, budget=budget, items=tuple(items),
                        excluded=dict(sorted(excluded.items())), considered=len(pool), notes=tuple(notes))
