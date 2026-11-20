"""Food catalogue request/response schemas.

FoodCandidate is what an AI recogniser (or any caller) may send: a name,
optional brand and an estimated quantity. It accepts NO nutrition fields
(extra="forbid"), so nutrition always comes from the catalogue.
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class FoodCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    food_name: str = Field(min_length=1, max_length=120)
    brand: str | None = Field(default=None, max_length=120)
    estimated_quantity_g: float | None = Field(default=None, gt=0, le=5000)
    estimated_quantity_ml: float | None = Field(default=None, gt=0, le=5000)

    @field_validator("brand")
    @classmethod
    def _blank_brand(cls, v: str | None) -> str | None:
        return v or None

    @model_validator(mode="after")
    def _one_quantity(self) -> "FoodCandidate":
        if self.estimated_quantity_g is not None and self.estimated_quantity_ml is not None:
            raise ValueError("give estimated_quantity_g or estimated_quantity_ml, not both")
        return self

    @property
    def quantity(self) -> tuple[float | None, Literal["g", "ml"]]:
        if self.estimated_quantity_ml is not None:
            return self.estimated_quantity_ml, "ml"
        return self.estimated_quantity_g, "g"


class MatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    candidates: list[FoodCandidate] = Field(min_length=1, max_length=10)


class NutritionPer100(BaseModel):
    basis: Literal["g", "ml"]
    kcal: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float | None = None
    sugars_g: float | None = None
    saturated_fat_g: float | None = None
    sodium_g: float | None = None


class Portion(BaseModel):
    grams: float
    kcal: float
    protein_g: float
    carbs_g: float
    fat_g: float


class Serving(BaseModel):
    label: str
    grams: float


class Quality(BaseModel):
    completeness: float
    verification: str
    flags: list[str]


class FoodMatch(BaseModel):
    food_id: uuid.UUID
    name: str
    brand: str | None
    category: str | None
    source: str
    source_ref: str | None
    match_type: str
    matched_text: str
    confidence: float = Field(ge=0, le=1)
    per_100: NutritionPer100
    portion: Portion | None
    default_serving: Serving | None
    quality: Quality


Decision = Literal["confident", "ambiguous", "no_match"]


class QueryEcho(BaseModel):
    food_name: str
    brand: str | None
    quantity: float | None
    unit: Literal["g", "ml"]


class MatchResult(BaseModel):
    query: QueryEcho
    decision: Decision
    # Always true: a match is a suggestion; the user confirms before logging.
    needs_user_confirmation: Literal[True] = True
    warnings: list[str] = Field(default_factory=list)
    candidates: list[FoodMatch]


class MatchResponse(BaseModel):
    results: list[MatchResult]


class FoodAliasOut(BaseModel):
    alias: str
    kind: str


class FoodDetail(BaseModel):
    food_id: uuid.UUID
    name: str
    brand: str | None
    category: str | None
    food_kind: str
    source: str
    source_ref: str | None
    source_version: str | None
    per_100: NutritionPer100
    salt_g: float | None
    micronutrients: dict[str, float]
    density_g_per_ml: float | None
    quality: Quality
    aliases: list[FoodAliasOut]
    servings: list[Serving]


class ImportResult(BaseModel):
    food_id: uuid.UUID
    name: str
    brand: str | None
    created: bool
