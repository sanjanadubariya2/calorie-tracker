"""Matching AI/user food names to catalogue foods.

Scoring and portion maths happen in Postgres (search_food_catalogue,
portion_nutrition: one implementation, also used when logging). This module
turns the ranked rows into a decision:

  confident   best >= CONFIDENT_SCORE and ahead of #2 by >= CONFIDENT_GAP
  ambiguous   best >= AMBIGUOUS_SCORE (show the options)
  no_match    otherwise (offer search / quick add; never guess nutrition)

Every result still requires user confirmation before anything is logged.
Thresholds are tuned against tests/data/match_eval.csv.
"""

from __future__ import annotations

from typing import Any

from app.core.security import AuthenticatedUser
from app.db.supabase import SupabaseRest
from app.schemas.foods import (
    FoodCandidate,
    FoodMatch,
    MatchResult,
    NutritionPer100,
    Portion,
    Quality,
    QueryEcho,
    Serving,
)

CONFIDENT_SCORE = 0.85
CONFIDENT_GAP = 0.10
AMBIGUOUS_SCORE = 0.55
MIN_RETURNED_SCORE = 0.35
MAX_CANDIDATES = 5
PORTION_CHECK_FACTOR = 5   # quantity > 5 x the default serving looks implausible


def _f(value: Any) -> float | None:
    return None if value is None else float(value)


def row_to_match(row: dict[str, Any]) -> FoodMatch:
    portion = None
    if row.get("portion_kcal") is not None:
        portion = Portion(
            grams=float(row["portion_grams"]),
            kcal=float(row["portion_kcal"]),
            protein_g=float(row["portion_protein_g"]),
            carbs_g=float(row["portion_carbs_g"]),
            fat_g=float(row["portion_fat_g"]),
        )
    serving = None
    if row.get("default_serving_label") and row.get("default_serving_g") is not None:
        serving = Serving(label=row["default_serving_label"], grams=float(row["default_serving_g"]))
    return FoodMatch(
        food_id=row["food_id"],
        name=row["name"],
        brand=row.get("brand"),
        category=row.get("category"),
        source=row["source"],
        source_ref=row.get("source_ref"),
        match_type=row["match_type"],
        matched_text=row["matched_text"],
        confidence=min(1.0, max(0.0, float(row["score"]))),
        per_100=NutritionPer100(
            basis=row["basis"],
            kcal=float(row["kcal_per_100"]),
            protein_g=float(row["protein_g_per_100"]),
            carbs_g=float(row["carbs_g_per_100"]),
            fat_g=float(row["fat_g_per_100"]),
            fiber_g=_f(row.get("fiber_g_per_100")),
            sugars_g=_f(row.get("sugars_g_per_100")),
            saturated_fat_g=_f(row.get("saturated_fat_g_per_100")),
            sodium_g=_f(row.get("sodium_g_per_100")),
        ),
        portion=portion,
        default_serving=serving,
        quality=Quality(
            completeness=float(row["completeness"]),
            verification=row["verification"],
            flags=list(row.get("quality_flags") or []),
        ),
    )


def decide(matches: list[FoodMatch]) -> str:
    if not matches or matches[0].confidence < AMBIGUOUS_SCORE:
        return "no_match"
    best = matches[0].confidence
    runner_up = matches[1].confidence if len(matches) > 1 else 0.0
    if best >= CONFIDENT_SCORE and best - runner_up >= CONFIDENT_GAP:
        return "confident"
    return "ambiguous"


def portion_warnings(candidate: FoodCandidate, matches: list[FoodMatch]) -> list[str]:
    quantity, unit = candidate.quantity
    if quantity is None or not matches:
        return []
    warnings: list[str] = []
    top = matches[0]
    if top.portion is None:
        warnings.append("unit_conversion_unavailable")
    elif top.default_serving and top.portion.grams > PORTION_CHECK_FACTOR * top.default_serving.grams:
        warnings.append("portion_check")
    return warnings


async def search(
    db: SupabaseRest,
    user: AuthenticatedUser,
    query: str,
    brand: str | None,
    quantity: float | None,
    unit: str,
    limit: int,
) -> list[FoodMatch]:
    rows = await db.rpc(user, "search_food_catalogue", {
        "p_query": query, "p_brand": brand, "p_quantity": quantity, "p_unit": unit, "p_limit": limit,
    })
    return [row_to_match(r) for r in (rows or [])]


async def match_candidate(db: SupabaseRest, user: AuthenticatedUser, candidate: FoodCandidate) -> MatchResult:
    quantity, unit = candidate.quantity
    matches = await search(db, user, candidate.food_name, candidate.brand, quantity, unit, MAX_CANDIDATES + 1)
    matches = [m for m in matches if m.confidence >= MIN_RETURNED_SCORE]
    decision = decide(matches)
    return MatchResult(
        query=QueryEcho(food_name=candidate.food_name, brand=candidate.brand, quantity=quantity, unit=unit),
        decision=decision,  # type: ignore[arg-type]
        warnings=portion_warnings(candidate, matches),
        candidates=matches[:MAX_CANDIDATES],
    )
