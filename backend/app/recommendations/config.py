"""Recommendation engine settings. Pure data, no I/O.

Every number here is explained in docs/recommendation-scoring.md; change the
two together. EngineConfig is immutable: pass a modified copy (dataclasses.
replace) to experiment, e.g. in tests.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

ENGINE_VERSION = "rec-v2"

Goal = Literal["lose", "maintain", "gain"]
MealType = Literal["breakfast", "lunch", "dinner", "snack"]
Mode = Literal["meals", "foods", "both"]
Tolerance = Literal["strict", "standard", "flexible"]

MEAL_TYPES: tuple[MealType, ...] = ("breakfast", "lunch", "dinner", "snack")

# Share of the day's energy planned for each meal (sums to 1.0).
MEAL_SHARE: dict[str, float] = {"breakfast": 0.25, "lunch": 0.35, "dinner": 0.30, "snack": 0.10}

# Used only when the user has no targets yet; always stated in the notes.
# 2,000 kcal with a 50/30/20 carb/fat/protein split.
ASSUMED_DAILY = {"kcal": 2000.0, "protein_g": 100.0, "carbs_g": 250.0, "fat_g": 67.0}

LIGHT_THRESHOLD_KCAL = 100.0   # remaining at or below this -> light options
LIGHT_MEAL_KCAL = 150.0        # the budget used for light options


@dataclass(frozen=True)
class Weights:
    """Relative importance of each score component (normalised by their sum)."""

    calories: float = 0.30
    protein: float = 0.20
    carbs: float = 0.06
    fat: float = 0.07
    meal_type: float = 0.10
    preference: float = 0.10
    variety: float = 0.07
    history: float = 0.05
    quality: float = 0.05

    def as_dict(self) -> dict[str, float]:
        return asdict(self)

    def nutrition(self) -> dict[str, float]:
        return {"calories": self.calories, "protein": self.protein, "carbs": self.carbs, "fat": self.fat}


GOAL_WEIGHTS: dict[str, Weights] = {
    "maintain": Weights(),
    # Losing weight: protein matters more (satiety, preserving lean mass);
    # taken from carbs, fat, preference, variety and quality.
    "lose": Weights(calories=0.30, protein=0.25, carbs=0.05, fat=0.06, meal_type=0.10,
                    preference=0.09, variety=0.06, history=0.05, quality=0.04),
    # Gaining: reaching the energy target matters slightly more; fat less.
    "gain": Weights(calories=0.32, protein=0.20, carbs=0.06, fat=0.05, meal_type=0.10,
                    preference=0.10, variety=0.07, history=0.05, quality=0.05),
}


@dataclass(frozen=True)
class CalorieBand:
    """Calories as a ratio of the meal budget. Inside [full_low, full_high] the
    calorie score is 1; it falls linearly to 0 at zero_low / zero_high. Outside
    the zero points a candidate is excluded (too small / too large)."""

    full_low: float
    full_high: float
    zero_low: float
    zero_high: float


TOLERANCES: dict[str, CalorieBand] = {
    "strict": CalorieBand(0.95, 1.05, 0.80, 1.15),
    "standard": CalorieBand(0.90, 1.10, 0.70, 1.30),
    "flexible": CalorieBand(0.85, 1.15, 0.50, 1.50),
}


def calorie_band(tolerance: str, goal: str | None) -> CalorieBand:
    """The tolerance band, made asymmetric by goal: when losing, going over is
    penalised sooner; when gaining, falling short is."""
    b = TOLERANCES[tolerance]
    if goal == "lose":
        return CalorieBand(b.full_low, 1 + (b.full_high - 1) * 0.5, b.zero_low, 1 + (b.zero_high - 1) * 0.67)
    if goal == "gain":
        return CalorieBand(1 - (1 - b.full_low) * 0.5, b.full_high, 1 - (1 - b.zero_low) * 0.67, b.zero_high)
    return b


# Preferred meal styles (user-facing) -> dish types / catalogue categories.
MEAL_STYLES: dict[str, frozenset[str]] = {
    "dal_rice": frozenset({"dal", "rice", "rice_dish"}),
    "roti_sabzi": frozenset({"bread", "sabzi"}),
    "curry": frozenset({"curry", "non_veg", "paneer_dish"}),
    "one_pot": frozenset({"one_pot", "rice_dish"}),
    "tiffin": frozenset({"breakfast_dish", "south_indian"}),
    "egg": frozenset({"egg_dish"}),
    "salad": frozenset({"salad"}),
    "soup": frozenset({"soup"}),
    "snack": frozenset({"snack"}),
    "thali": frozenset(),          # matched by kind: meal templates and combinations
}


def protein_focus(w: Weights) -> Weights:
    """High-protein requests: +0.10 protein, taken from calories, carbs and fat."""
    return Weights(calories=w.calories - 0.05, protein=w.protein + 0.10, carbs=max(0.0, w.carbs - 0.025),
                   fat=max(0.0, w.fat - 0.025), meal_type=w.meal_type, preference=w.preference,
                   variety=w.variety, history=w.history, quality=w.quality)


# Verification of the nutrition source -> base quality score.
VERIFICATION_QUALITY = {"expert_reviewed": 1.0, "curated": 0.9, "auto_checked": 0.7, "unverified": 0.5}


@dataclass(frozen=True)
class EngineConfig:
    weights_by_goal: dict[str, Weights] = field(default_factory=lambda: dict(GOAL_WEIGHTS))

    # Portion options (multiples of one serving).
    countable_portions: tuple[float, ...] = (1, 2, 3, 4)            # roti, idli, eggs...
    divisible_portions: tuple[float, ...] = (0.5, 1, 1.5, 2)        # katori, bowl, plate...
    max_combinations: int = 4096                                     # template portion search bound

    # Ranking.
    min_score: float = 0.65          # below this a candidate is not a recommendation
    strong_fit: float = 0.85
    good_fit: float = 0.72

    # Diversity (greedy re-rank). Penalties are per already-selected item sharing the trait.
    max_same_main: int = 2
    penalty_same_main: float = 0.12
    penalty_same_dish_type: float = 0.06
    penalty_same_prep: float = 0.04
    penalty_same_region: float = 0.03

    # Macro scoring.
    protein_full_at: float = 0.9                 # protein score is 1 at 90% of the meal's target
    ceiling_full_ratio: float = 1.15             # carbs/fat: full score up to 115% of target...
    ceiling_full_slack_g: float = 3.0            # ...plus 3 g
    ceiling_zero_ratio: float = 2.0              # zero at 200% of target...
    ceiling_zero_slack_g: float = 15.0           # ...plus 15 g
    max_protein_kcal_share: float = 0.40         # protein above 40% of a meal's energy is not realistic

    # High-protein requests.
    high_protein_share: float = 0.30             # protein target: at least 30% of the meal's energy
    min_protein_share_high: float = 0.20         # below 20% of energy from protein: not "high protein"

    # Personal preferences (soft).
    dislike_penalty: float = 0.15                # subtracted from the score when a dislike matches
    style_miss_score: float = 0.4                # preferred meal styles set, this isn't one
    neutral_preference: float = 0.6              # nothing set: the same for every candidate

    # Interaction history.
    history_base: float = 0.7
    selected_bonus: float = 0.15                 # per selection/log in the window, at most 2
    less_often_penalty: float = 0.15             # "not interested": subtracted while the feedback lasts
    rejected_penalty: float = 0.10               # a rejection: subtracted, halving every...
    rejected_half_life_days: float = 7.0         # ...7 days, gone after the history window
    history_window_days: int = 30

    # Going over what is left today in carbs or fat (normal mode only): energy above
    # the remaining amount, beyond a small slack, costs this much per kcal.
    overshoot_penalty_per_kcal: float = 0.0005
    overshoot_slack_kcal: float = 45.0           # about 5 g fat or 11 g carbohydrate
    overshoot_max: float = 0.15
    # A dish whose known meal types don't include the requested one.
    meal_type_mismatch_penalty: float = 0.10

    # Novelty: recently shown or chosen items step back for a while, never for good.
    novelty_per_show: float = 0.04
    novelty_half_life_days: float = 2.0
    novelty_window_days: int = 7
    novelty_max: float = 0.15

    # Data quality.
    excluded_flags: frozenset[str] = frozenset({"energy_mismatch"})
    flag_quality_penalty: dict[str, float] = field(
        default_factory=lambda: {"cooking_oil_uncertain": 0.25, "density_assumed": 0.10})
    estimated_quantities_penalty: float = 0.15
    inferred_attributes_penalty: float = 0.05
    unknown_attributes_penalty: float = 0.10

    def weights(self, goal: str | None) -> Weights:
        return self.weights_by_goal.get(goal or "maintain", self.weights_by_goal["maintain"])


DEFAULT_CONFIG = EngineConfig()
