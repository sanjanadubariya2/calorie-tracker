"""Meal recommendations API (Phase 3, Tasks 3-5)."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

MealTypeIn = Literal["breakfast", "lunch", "dinner", "snack"]
AppMealType = Literal["breakfast", "lunch", "dinner", "morning_snack", "afternoon_snack", "evening_snack"]
KEY_PATTERN = r"^(food|recipe|meal):[0-9a-f-]{36}$|^combo:[0-9a-f-]{36}\+[0-9a-f-]{36}$"


class RecommendationQuery(BaseModel):
    """GET /v1/me/recommendations. Identity comes only from the access token."""

    model_config = ConfigDict(extra="forbid")

    meal_type: MealTypeIn
    count: int = Field(default=5, ge=1, le=10, description="At most this many; fewer when fewer fit well.")
    mode: Literal["meals", "foods", "both"] = Field(
        default="both", description="meals: recipes, recipe pairings and meal templates; foods: single dishes.")
    tolerance: Literal["strict", "standard", "flexible"] = "standard"
    max_kcal: int | None = Field(default=None, ge=50, le=2500, description="No recommendation above this.")
    target_kcal: int | None = Field(default=None, ge=50, le=2500,
                                    description="Use this budget instead of the planned share of the day.")
    protein: Literal["normal", "high"] = Field(default="normal", description="high: protein-focused ranking.")
    cuisine: str | None = Field(default=None, min_length=2, max_length=40,
                                description="Only this cuisine, e.g. 'South Indian'.")
    exclude: list[str] = Field(default_factory=list, max_length=40,
                               description="Candidate keys to leave out (show alternatives).")
    date: dt.date | None = Field(default=None, description="Local date; defaults to today in the profile's time zone.")

    @field_validator("exclude")
    @classmethod
    def _keys(cls, v: list[str]) -> list[str]:
        import re
        bad = [k for k in v if not re.match(KEY_PATTERN, k)]
        if bad:
            raise ValueError("exclude must contain recommendation keys like 'food:<uuid>'")
        return list(dict.fromkeys(v))

    @field_validator("cuisine")
    @classmethod
    def _cuisine(cls, v: str | None) -> str | None:
        return " ".join(v.split()) if v else None


class BudgetOut(BaseModel):
    meal_type: MealTypeIn
    kcal: int
    protein_g: int
    carbs_g: int
    fat_g: int
    basis: Literal["targets", "assumed"] = Field(description="assumed: no targets yet, a 2,000 kcal day is used.")
    mode: Literal["planned", "capped", "light", "requested"]
    remaining_kcal: int | None
    tolerance: Literal["strict", "standard", "flexible"]


class PortionOut(BaseModel):
    kind: Literal["food", "recipe"]
    id: uuid.UUID
    name: str
    servings: float
    serving_label: str
    grams: float | None = Field(default=None, description="Foods only: servings x serving weight.")
    slot: str | None = None
    min_servings: float
    max_servings: float


class IngredientOut(BaseModel):
    """A recipe ingredient scaled to the chosen servings (arithmetic on the
    stored quantities; nutrition is never derived from this list here)."""

    part: int = Field(description="Index into portions.")
    name: str
    quantity: float | None
    unit: str | None
    grams: float | None
    preparation: str | None = None
    optional: bool = False


class NutritionOut(BaseModel):
    """Priced by the database for exactly these portions (the same functions
    used when logging). Whole numbers: more digits would be false precision."""

    kcal: int
    protein_g: int
    carbs_g: int
    fat_g: int


class OptionalComponentOut(BaseModel):
    """An optional template component this user may add (it passed their
    diet, allergy and exclusion filters on its own). Not in `nutrition`."""

    id: uuid.UUID = Field(description="Catalogue food id; pass it as `optional` to include it.")
    name: str
    slot: str | None
    servings: float
    serving_label: str
    grams: float | None
    nutrition: NutritionOut = Field(description="Priced by the database at these servings.")
    diet_classes: list[str]
    diet_status: Literal["reviewed", "inferred", "unknown"]
    allergens_detected: list[str]
    allergen_status: Literal["reviewed", "inferred", "unknown"]
    quality_flags: list[str]


class WithheldOut(BaseModel):
    """An optional component NOT offered to this user, and why."""

    name: str
    reason: str
    label: str


class ScoreOut(BaseModel):
    total: float = Field(description="0-1, two decimals: weighted components minus adjustments.")
    fit: Literal["strong", "good", "fair"]
    components: dict[str, float] = Field(description="Each 0-1, one decimal.")
    weights: dict[str, float]
    adjustments: dict[str, float] = Field(default_factory=dict, description="Subtracted: novelty, dislike.")
    diversity_penalty: float


class DataQualityOut(BaseModel):
    source: str
    verification: str
    approximate: bool = Field(description="True when recipe quantities are typical, not measured.")
    diet_classes: list[str]
    diet_status: Literal["reviewed", "inferred", "unknown"]
    allergens_detected: list[str]
    allergen_status: Literal["reviewed", "inferred", "unknown"]
    quality_flags: list[str]
    approval_level: Literal["provisional", "verified"] | None = Field(
        default=None, description="Meal templates only: provisional = not individually verified by a person.")


class RecommendationOut(BaseModel):
    id: uuid.UUID | None = Field(description="Recommendation id (null when the request was not recorded).")
    key: str = Field(description="Stable candidate key, e.g. 'food:<uuid>'.")
    rank: int
    kind: Literal["recipe", "combo", "meal", "food"]
    name: str
    variant: str | None
    description: str | None = None
    total_minutes: int | None = Field(default=None, description="Preparation + cooking, when recorded.")
    equipment: list[str] | None = None
    image_url: None = Field(default=None, description="No verified meal images exist yet; always null.")
    portions: list[PortionOut]
    ingredients: list[IngredientOut] = Field(default_factory=list)
    nutrition: NutritionOut = Field(description="The base meal: required components only.")
    optional_components: list[OptionalComponentOut] = Field(default_factory=list)
    optional_withheld: list[WithheldOut] = Field(default_factory=list)
    nutrition_with_optional: NutritionOut | None = Field(
        default=None, description="Base meal plus every offered optional component at its default servings.")
    score: ScoreOut
    reasons: list[str]
    warnings: list[str]
    data: DataQualityOut


class ExclusionOut(BaseModel):
    reason: str
    label: str
    count: int


Status = Literal["ok", "partial", "empty_catalogue", "insufficient_data", "excluded_by_constraints", "no_fit"]


class RecommendationResponse(BaseModel):
    set_id: uuid.UUID | None = Field(description="History record (null if it was not recorded).")
    engine_version: str
    status: Status
    local_date: dt.date
    budget: BudgetOut
    items: list[RecommendationOut]
    considered: int
    excluded: list[ExclusionOut]
    notes: list[str]


class RecommendationDetail(BaseModel):
    """One recorded recommendation, re-priced for the requested servings."""

    id: uuid.UUID
    set_id: uuid.UUID
    meal_type: MealTypeIn
    local_date: dt.date
    created_at: dt.datetime
    available: Literal[True] = True
    recommended_servings: list[float]
    item: RecommendationOut
    instructions: list[list[str]] = Field(default_factory=list, description="Per recipe part, in order.")
    saved: bool = False
    selected_optional: list[uuid.UUID] = Field(default_factory=list)
    total_nutrition: NutritionOut = Field(description="Base meal plus the selected optional components, priced now.")


FeedbackAction = Literal["viewed", "selected", "rejected", "planned", "saved", "unsaved", "not_interested", "never"]


class FeedbackIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: FeedbackAction


class FeedbackOut(BaseModel):
    id: uuid.UUID
    feedback: Literal["never", "less_often", "liked", "saved"]
    kind: Literal["food", "meal", "recipe"]
    target_id: uuid.UUID
    name: str | None
    item_id: uuid.UUID | None
    created_at: dt.datetime
    expires_at: dt.datetime | None


class FeedbackResult(BaseModel):
    recommendation_id: uuid.UUID
    action: FeedbackAction
    event_recorded: bool
    feedback: FeedbackOut | None = None


class LogProposalIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    servings: list[float] | None = Field(default=None, max_length=8,
                                         description="Per portion; defaults to the recommended servings.")
    optional: list[uuid.UUID] = Field(default_factory=list, max_length=8,
                                      description="Optional components to include (ids from optional_components).")
    meal_type: AppMealType | None = None
    date: dt.date | None = None
