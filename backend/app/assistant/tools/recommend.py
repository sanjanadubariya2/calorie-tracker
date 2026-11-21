"""recommend_meals: the assistant's read-only view of the recommendation engine.

It calls exactly the service the app's GET /v1/me/recommendations uses
(app.recommendations.service.recommend), with persist=False: nothing is
written. Candidates, hard exclusions (diet, allergies, excluded ingredients,
equipment, "never"), ranking and database-priced nutrition all come from the
engine; the model may explain and compare the results, never change them.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.assistant.tools.base import Tool, ToolContext, clean_text
from app.recommendations import service
from app.recommendations.repository import RecommendationRepository
from app.schemas.recommendations import RecommendationQuery

RecommendMealType = Literal["breakfast", "lunch", "dinner", "snack"]


class RecommendArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    meal_type: RecommendMealType = Field(description="Which meal to suggest for. Ask the user if unclear.")
    count: int = Field(default=3, ge=1, le=5)
    max_kcal: int | None = Field(default=None, ge=50, le=2500, description="Only if the user gave a calorie limit.")
    protein: Literal["normal", "high"] = Field(default="normal", description="high: the user asked for high protein.")
    cuisine: str | None = Field(default=None, min_length=2, max_length=40,
                                description="Only if the user asked for one cuisine, e.g. 'South Indian'.")
    mode: Literal["meals", "foods", "both"] = "both"


class MealTarget(BaseModel):
    calories_kcal: int
    protein_g: int
    carbs_g: int
    fat_g: int
    basis: Literal["targets", "assumed"]


class RecNutrition(BaseModel):
    calories_kcal: int
    protein_g: int
    carbs_g: int
    fat_g: int


class RecPortion(BaseModel):
    name: str
    servings: float
    serving_label: str
    grams: float | None


class Recommendation(BaseModel):
    key: str
    kind: Literal["recipe", "combo", "meal", "food"]
    name: str
    variant: str | None
    food_id: str | None = Field(description="Single dishes only: usable with prepare_food_log.")
    portions: list[RecPortion]
    nutrition: RecNutrition
    total_minutes: int | None
    score: float
    fit: Literal["strong", "good", "fair"]
    reasons: list[str]
    warnings: list[str]


class Exclusion(BaseModel):
    reason: str
    label: str
    count: int


class RecommendResult(BaseModel):
    meal_type: RecommendMealType
    status: str
    meal_target: MealTarget
    recommendations: list[Recommendation]
    excluded: list[Exclusion]
    notes: list[str]
    engine_version: str
    data_source: Literal["recommendation_engine"] = "recommendation_engine"


def _repo(ctx: ToolContext) -> RecommendationRepository:
    """The app's shared repository (same candidate cache as the API); a
    per-call one when none was provided (tests, scripts)."""
    return ctx.services.get("recommendations") or RecommendationRepository(ctx.db)


async def run_recommend(ctx: ToolContext, args: RecommendArgs) -> RecommendResult:
    q = RecommendationQuery(meal_type=args.meal_type, count=args.count, mode=args.mode, max_kcal=args.max_kcal,
                            protein=args.protein, cuisine=args.cuisine, date=ctx.local_date)
    r = await service.recommend(ctx.db, ctx.user, _repo(ctx), q, persist=False)
    recs = []
    for i in r.items:
        food_id = str(i.portions[0].id) if i.kind == "food" else None
        recs.append(Recommendation(
            key=i.key, kind=i.kind, name=clean_text(i.name, 200) or "", variant=clean_text(i.variant, 60),
            food_id=food_id,
            portions=[RecPortion(name=clean_text(p.name, 200) or "", servings=p.servings,
                                 serving_label=clean_text(p.serving_label, 60) or "", grams=p.grams) for p in i.portions],
            nutrition=RecNutrition(calories_kcal=i.nutrition.kcal, protein_g=i.nutrition.protein_g,
                                   carbs_g=i.nutrition.carbs_g, fat_g=i.nutrition.fat_g),
            total_minutes=i.total_minutes, score=i.score.total, fit=i.score.fit, reasons=i.reasons,
            warnings=i.warnings))
    # Single dishes the engine recommended may be passed to prepare_food_log.
    seen = ctx.turn_state.setdefault("seen_food_ids", set())
    seen.update(str(p.id) for i in r.items if i.kind in ("food", "meal") for p in i.portions)
    b = r.budget
    return RecommendResult(
        meal_type=args.meal_type, status=r.status,
        meal_target=MealTarget(calories_kcal=b.kcal, protein_g=b.protein_g, carbs_g=b.carbs_g, fat_g=b.fat_g,
                               basis=b.basis),
        recommendations=recs, excluded=[Exclusion(**e.model_dump()) for e in r.excluded], notes=r.notes,
        engine_version=r.engine_version)


RECOMMEND_MEALS = Tool(
    name="recommend_meals",
    description=("Recommend meals (published recipes, recipe pairings, meal templates and single dishes) for one "
                 "meal, ranked by the app's recommendation engine against the user's remaining calories and macros, "
                 "with their diet, allergies, excluded ingredients and equipment applied as hard filters. "
                 "Nutrition is priced by the database. Present only what this returns: never add other meals, "
                 "change numbers, or claim a meal is suitable for an allergy. If status isn't 'ok', explain the "
                 "notes."),
    args=RecommendArgs, result=RecommendResult, run=run_recommend, supports=("meal_recommendation",),
)
