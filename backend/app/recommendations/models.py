"""Plain data for the recommendation engine. No I/O, no scoring."""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from typing import Literal

Kind = Literal["recipe", "combo", "meal", "food"]
KIND_ORDER = {"meal": 0, "combo": 1, "recipe": 2, "food": 3}   # deterministic tie-break only


def normalize(text: str | None) -> str:
    """Lower-case words only, for name comparisons ("Dal Tadka (Toor)" -> "dal tadka toor")."""
    return " ".join(re.findall(r"[a-z0-9]+", (text or "").lower()))


@dataclass(frozen=True)
class Nutrition:
    kcal: float
    protein_g: float
    carbs_g: float
    fat_g: float

    def scaled(self, k: float) -> Nutrition:
        return Nutrition(self.kcal * k, self.protein_g * k, self.carbs_g * k, self.fat_g * k)

    def __add__(self, other: Nutrition) -> Nutrition:
        return Nutrition(self.kcal + other.kcal, self.protein_g + other.protein_g,
                         self.carbs_g + other.carbs_g, self.fat_g + other.fat_g)


ZERO = Nutrition(0, 0, 0, 0)


@dataclass(frozen=True)
class Part:
    """One priced component of a candidate: a catalogue food (by default
    serving) or a recipe (by recipe serving)."""

    ref_kind: Literal["food", "recipe"]
    ref_id: str
    name: str
    serving_label: str
    per_serving: Nutrition                 # from the database, never estimated
    options: tuple[float, ...]             # allowed numbers of servings
    default: float = 1.0
    serving_grams: float | None = None     # foods only (recipes report raw-ingredient grams)
    slot: str | None = None
    yields: float | None = None            # recipes: servings the ingredient list makes
    ingredients: tuple[dict, ...] = ()     # recipes: ingredients as stored (for `yields` servings)


@dataclass(frozen=True)
class AddOn:
    """An optional template component the user may add. Its own attributes,
    so it is filtered on its own (a milk add-on is withheld for a milk allergy
    while the base meal can still be recommended)."""

    part: Part
    diet_classes: frozenset[str] = frozenset({"unknown"})
    diet_status: str = "unknown"
    vegan: bool | None = None
    jain: bool | None = None
    allergens: frozenset[str] = frozenset()
    allergen_status: str = "unknown"
    quality_flags: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Candidate:
    kind: Kind
    key: str                               # unique: 'food:<id>', 'recipe:<id>', 'meal:<id>', 'combo:<id>+<id>'
    group: str                             # at most one result per group (recipe family, template, food)
    name: str
    parts: tuple[Part, ...]                # empty when nutrition is incomplete
    complete: bool
    variant: str | None = None
    meal_types: frozenset[str] = frozenset()
    regions: frozenset[str] = frozenset()
    dish_type: str | None = None
    main_ingredient: str | None = None     # normalized name
    prep_style: str | None = None
    terms: tuple[str, ...] = ()            # names checked against dislikes (dish, variant, ingredients)
    dish_names: frozenset[str] = frozenset()   # normalized dish names (variety)
    dish_food_ids: frozenset[str] = frozenset()  # catalogue dish ids (variety; not raw ingredients)
    diet_classes: frozenset[str] = frozenset({"unknown"})
    diet_status: str = "unknown"
    vegan: bool | None = None
    jain: bool | None = None
    allergens: frozenset[str] = frozenset()
    allergen_status: str = "unknown"
    quality_flags: frozenset[str] = frozenset()
    source: str = ""
    verification: str = "unverified"
    quantities_estimated: bool = False
    history_keys: tuple[str, ...] = ()     # keys matching past recommendation items
    feedback_keys: tuple[str, ...] = ()    # keys matching feedback rows
    # Persistence references.
    food_id: str | None = None
    recipe_id: str | None = None
    template_id: str | None = None
    family_id: str | None = None
    extra_recipe_id: str | None = None     # a combo's second recipe
    # Recipe details (display, preparation-time and equipment preferences).
    description: str | None = None
    total_minutes: int | None = None       # prep + cook; None when not recorded
    equipment: frozenset[str] | None = None   # None: not recorded
    addons: tuple[AddOn, ...] = ()         # optional components (templates); never part of the base meal
    approval_level: str | None = None      # templates: provisional | verified (migration 020)


@dataclass(frozen=True)
class UserContext:
    local_date: dt.date
    goal: str | None
    # Daily targets / remaining; None when the user has no targets.
    targets: Nutrition | None
    remaining: Nutrition | None
    consumed: Nutrition = ZERO
    has_preferences: bool = False
    diet: str | None = None
    allergies: frozenset[str] = frozenset()
    dislikes: tuple[str, ...] = ()
    cuisines: tuple[str, ...] = ()
    today_food_ids: frozenset[str] = frozenset()
    today_names: frozenset[str] = frozenset()
    yesterday_food_ids: frozenset[str] = frozenset()
    yesterday_names: frozenset[str] = frozenset()
    # Explicit preferences (018). None / empty: not provided.
    excluded_ingredients: tuple[str, ...] = ()
    meal_styles: frozenset[str] = frozenset()
    max_prep_minutes: int | None = None
    equipment: frozenset[str] | None = None
    budget: str | None = None
    # Interaction history. Ages are in days before the request (computed by the
    # repository, so the engine never reads the clock).
    feedback: dict[str, str] = field(default_factory=dict)       # key -> never | less_often | liked | saved
    shows: dict[str, tuple[float, ...]] = field(default_factory=dict)          # key -> ages of recent showings
    events: dict[str, tuple[tuple[str, float], ...]] = field(default_factory=dict)  # key -> (event, age)


@dataclass(frozen=True)
class Request:
    meal_type: str
    count: int = 5
    mode: str = "both"
    tolerance: str = "standard"
    target_kcal: float | None = None       # explicit request overrides the planned budget
    max_kcal: float | None = None          # hard ceiling per recommendation
    protein: str = "normal"                # "high": protein-focused targets, weights and a minimum share
    cuisine: str | None = None             # restrict to one cuisine (free text -> regions)
    exclude_keys: frozenset[str] = frozenset()   # candidates already shown ("show alternatives")


@dataclass(frozen=True)
class MealBudget:
    meal_type: str
    kcal: float
    protein_g: float
    carbs_g: float
    fat_g: float
    basis: Literal["targets", "assumed"]
    mode: Literal["planned", "capped", "light", "requested"]
    remaining_kcal: float | None
    notes: tuple[str, ...] = ()


@dataclass(frozen=True)
class Recommendation:
    candidate: Candidate
    servings: tuple[float, ...]            # one per part
    nutrition: Nutrition                   # estimate from per-serving values (re-priced by the service)
    score: float
    components: dict[str, float]
    fit: str
    diversity_penalty: float = 0.0
    adjustments: dict[str, float] = field(default_factory=dict)   # subtracted after weighting (novelty, dislike)
    addons: tuple[AddOn, ...] = ()                                 # optional components this user may add
    addons_withheld: tuple[tuple[str, str], ...] = ()              # (name, reason) not offered to this user
    reasons: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class EngineResult:
    status: str
    budget: MealBudget
    items: tuple[Recommendation, ...]
    excluded: dict[str, int]
    considered: int
    notes: tuple[str, ...] = ()
