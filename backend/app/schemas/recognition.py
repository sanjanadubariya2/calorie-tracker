"""Recognition (Task 3) and grounded proposal (Task 4) schemas.

A recognition result lists *candidates*: what the model thinks was eaten,
with no nutrition. A proposal grounds each candidate in the catalogue:
matched food, resolved portion, and nutrition computed by the database. The
three kinds of confidence (recognition, catalogue match, portion) are kept
separate and never combined into one score. Nothing here is ever saved
automatically; the user confirms and the app logs through its normal path.
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.foods import NutritionPer100, Serving
from app.services.recognition.model_output import UNITS

Unit = Literal[UNITS]  # type: ignore[valid-type]
QuantitySource = Literal["user_stated", "model_estimate", "unspecified", "manual"]
ConfidenceLevel = Literal["high", "medium", "low"]


# ------------------------------------------------------------------ Task 3

class ModelInfo(BaseModel):
    provider: str
    model: str


class FoodCandidateOut(BaseModel):
    candidate_id: str
    food_name: str
    original_description: str
    brand: str | None
    estimated_quantity: float | None
    quantity_unit: Unit | None
    quantity_source: Literal["user_stated", "model_estimate", "unspecified"]
    estimated_weight_g: float | None
    weight_is_estimate: bool
    visible_ingredients: list[str]
    preparation: str | None
    meal_group: str | None
    recognition_confidence: float = Field(ge=0, le=1)
    confidence_level: ConfidenceLevel
    notes: list[str]
    requires_confirmation: Literal[True] = True


class RecognitionResult(BaseModel):
    recognition_id: str
    input_type: Literal["image", "text"]
    status: Literal["recognized", "no_food_detected", "unclear_input"]
    input_quality: str
    candidates: list[FoodCandidateOut]
    warnings: list[str]
    overall_notes: str | None
    model: ModelInfo


class TextRecognitionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=5000)

    @field_validator("text")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Describe what you ate.")
        return v


class ImageRecognitionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    image_id: uuid.UUID


# ------------------------------------------------------------------ Task 4

class ProposalItemInput(BaseModel):
    """One item to ground: a recognised candidate, or the user's edit of one.
    Carries no nutrition: it is always computed from the catalogue."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    candidate_id: str | None = Field(default=None, max_length=64)
    food_name: str = Field(min_length=1, max_length=120)
    brand: str | None = Field(default=None, max_length=120)
    quantity: float | None = Field(default=None, gt=0, le=10000)
    unit: Unit | None = None
    quantity_source: QuantitySource = "unspecified"
    estimated_weight_g: float | None = Field(default=None, gt=0, le=5000)
    recognition_confidence: float | None = Field(default=None, ge=0, le=1)
    selected_food_id: uuid.UUID | None = None


class GroundRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[ProposalItemInput] = Field(min_length=1, max_length=20)


class FoodOption(BaseModel):
    food_id: uuid.UUID
    name: str
    brand: str | None
    source: str
    source_ref: str | None
    match_confidence: float | None = Field(default=None, ge=0, le=1)
    per_100: NutritionPer100
    default_serving: Serving | None
    quality_flags: list[str]


class MatchInfo(BaseModel):
    decision: Literal["confident", "ambiguous", "no_match", "user_selected"]
    selected: FoodOption | None
    options: list[FoodOption]


class PortionInfo(BaseModel):
    quantity: float | None
    unit: Unit | None
    grams: float | None
    source: Literal["user_stated", "model_estimate", "catalogue_serving", "generic_conversion", "manual", "unresolved"]
    is_estimate: bool
    explanation: str


class NutritionInfo(BaseModel):
    per_100g: dict[str, float]
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    missing_nutrients: list[str]
    source: str
    source_ref: str | None


class ConfidenceInfo(BaseModel):
    recognition: float | None = Field(default=None, ge=0, le=1)
    recognition_level: ConfidenceLevel | None
    match: float | None = Field(default=None, ge=0, le=1)
    match_level: Literal["confident", "ambiguous", "no_match", "user_selected"]
    portion_level: ConfidenceLevel | None


class ProposalItem(BaseModel):
    candidate_id: str | None
    food_name: str
    brand: str | None
    match: MatchInfo
    portion: PortionInfo
    nutrition: NutritionInfo | None
    confidence: ConfidenceInfo
    warnings: list[str]
    status: Literal["ready", "needs_attention"]


class ProposalTotals(BaseModel):
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    items_counted: int
    is_estimate: bool


class MealProposal(BaseModel):
    items: list[ProposalItem]
    totals: ProposalTotals
    can_confirm: bool
    requires_confirmation: Literal[True] = True


class RecognitionResponse(BaseModel):
    recognition: RecognitionResult
    proposal: MealProposal
