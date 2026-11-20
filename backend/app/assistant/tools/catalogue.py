"""search_foods: the existing catalogue matcher (search_food_catalogue, as the user)."""

from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.assistant.tools.base import Tool, ToolContext, clean_text
from app.services.catalogue import matching


class SearchFoodsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=2, max_length=80, description="A food name, e.g. 'paneer butter masala'.")
    brand: str | None = Field(default=None, max_length=80)
    limit: int = Field(default=5, ge=1, le=10)

    @field_validator("query")
    @classmethod
    def _q(cls, v: str) -> str:
        v = " ".join(v.split())
        if len(v) < 2:
            raise ValueError("query must have at least 2 characters")
        return v


class Per100(BaseModel):
    basis: str
    kcal: float
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float | None
    sugars_g: float | None


class ServingOut(BaseModel):
    label: str
    grams: float


class MatchInfo(BaseModel):
    confidence: float
    match_type: str


class FoodResult(BaseModel):
    food_id: uuid.UUID
    name: str
    brand: str | None
    category: str | None
    source: str
    source_ref: str | None
    per_100: Per100
    default_serving: ServingOut | None
    match: MatchInfo
    quality_flags: list[str]


class SearchFoodsResult(BaseModel):
    query: str
    decision: str          # confident | ambiguous | no_match (the catalogue matcher's own rule)
    results: list[FoodResult]


async def run_search_foods(ctx: ToolContext, args: SearchFoodsArgs) -> SearchFoodsResult:
    matches = await matching.search(ctx.db, ctx.user, args.query, args.brand, None, "g", args.limit)
    results = [
        FoodResult(
            food_id=m.food_id, name=clean_text(m.name) or "", brand=clean_text(m.brand), category=m.category,
            source=m.source, source_ref=m.source_ref,
            per_100=Per100(basis=m.per_100.basis, kcal=m.per_100.kcal, protein_g=m.per_100.protein_g,
                           carbs_g=m.per_100.carbs_g, fat_g=m.per_100.fat_g, fiber_g=m.per_100.fiber_g,
                           sugars_g=m.per_100.sugars_g),
            default_serving=ServingOut(label=clean_text(m.default_serving.label, 60) or "", grams=m.default_serving.grams)
            if m.default_serving else None,
            match=MatchInfo(confidence=round(m.confidence, 2), match_type=m.match_type),
            quality_flags=m.quality.flags,
        )
        for m in matches
    ]
    # Food ids the model may then pass to prepare_food_log in this turn.
    ctx.turn_state.setdefault("seen_food_ids", set()).update(str(r.food_id) for r in results)
    return SearchFoodsResult(query=args.query, decision=matching.decide(matches), results=results)


SEARCH_FOODS = Tool(
    name="search_foods",
    description=("Search the food catalogue (Indian Nutrient Databank and verified products) by name. Returns "
                 "nutrition per 100 g, the default serving, the source and how well each result matches."),
    args=SearchFoodsArgs, result=SearchFoodsResult, run=run_search_foods, supports=("food_search_results",),
)
