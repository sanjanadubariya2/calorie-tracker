"""Grounding: recognised candidates -> catalogue-backed, priced proposals.

For each item, three independent steps, each with its own confidence:

1. Match (app.services.catalogue.matching): a food is auto-selected only on a
   "confident" decision; otherwise the options are returned and the user picks.
   A user's explicit choice (selected_food_id) is honoured as "user_selected".
2. Portion (resolve_portion, pure and deterministic): grams from, in order of
   reliability, a stated weight/volume, a count of the food's catalogue
   serving ("2 pieces", "1 bowl"), a generic household volume (katori, cup,
   glass... through the food's density), or the model's visual weight
   estimate. Where the grams came from is always reported; estimates are
   rounded to 5 g and flagged as estimates, never shown as measurements.
3. Nutrition (public.food_portion, migration 010): the exact snapshot and
   totals logging would store. Never invented: no grams or no logged-able
   nutrition means no numbers and a warning.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Literal

from app.core.security import AuthenticatedUser
from app.db.supabase import SupabaseRest
from app.schemas.foods import FoodMatch, NutritionPer100, Serving
from app.schemas.recognition import (
    ConfidenceInfo,
    FoodOption,
    MatchInfo,
    MealProposal,
    NutritionInfo,
    PortionInfo,
    ProposalItem,
    ProposalItemInput,
    ProposalTotals,
)
from app.services.catalogue import matching

MAX_GRAMS = 5000.0
OPTIONAL_NUTRIENTS = ("fiber_g", "sugars_g", "saturated_fat_g", "sodium_g")

# Generic household volumes (ml). Used only when the food has no matching
# catalogue serving; always reported as a generic conversion.
HOUSEHOLD_ML: dict[str, float] = {
    "katori": 150, "bowl": 250, "cup": 240, "glass": 250, "tablespoon": 15, "teaspoon": 5,
}
# Serving labels that are a container/volume, not a countable piece.
_NON_COUNT_LABEL_WORDS = {"bowl", "katori", "cup", "glass", "plate", "tablespoon", "teaspoon", "jar", "dish",
                          "ladle", "serving", "bottle", "can", "packet", "pack"}
_UNIT_SYNONYMS: dict[str, set[str]] = {
    "bowl": {"bowl", "katori"}, "katori": {"katori", "bowl"}, "glass": {"glass"}, "cup": {"cup", "mug"},
    "plate": {"plate", "dish"}, "slice": {"slice", "triangle"}, "tablespoon": {"tablespoon", "tbsp"},
    "teaspoon": {"teaspoon", "tsp"}, "serving": {"serving"},
}


@dataclass(frozen=True)
class FoodPortionContext:
    """What portion resolution needs to know about a selected food."""
    basis: str
    density_g_per_ml: float | None
    density_assumed: bool
    default_serving: Serving | None


def _round_estimate(grams: float) -> float:
    return max(5.0, round(grams / 5) * 5)


def _serving_matches_unit(serving: Serving, unit: str) -> bool:
    words = set(serving.label.lower().replace("(", " ").replace(")", " ").split())
    if unit == "piece":
        # "1 piece", "1 parantha", "1 idli": a countable thing, not a container.
        return bool(words) and not (words & _NON_COUNT_LABEL_WORDS)
    return bool(words & _UNIT_SYNONYMS.get(unit, {unit}))


def resolve_portion(item: ProposalItemInput, food: FoodPortionContext | None) -> tuple[PortionInfo, Literal["high", "medium", "low"] | None, list[str]]:
    """Pure: the grams for an item, where they came from, and a confidence level."""
    q, unit, source = item.quantity, item.unit, item.quantity_source
    stated = source in ("user_stated", "manual")
    warnings: list[str] = []

    def done(grams: float | None, how: str, level: Literal["high", "medium", "low"] | None,
             explanation: str, estimate: bool) -> tuple[PortionInfo, Any, list[str]]:
        if grams is not None and not (0 < grams <= MAX_GRAMS):
            warnings.append("portion_out_of_range")
            return (PortionInfo(quantity=q, unit=unit, grams=None, source="unresolved", is_estimate=True,
                                explanation="That portion is outside 0-5000 g. Please enter the amount."),
                    None, warnings)
        if grams is not None and estimate:
            grams = _round_estimate(grams)
        elif grams is not None:
            grams = round(grams, 1)
        return (PortionInfo(quantity=q, unit=unit, grams=grams, source=how if grams is not None else "unresolved",  # type: ignore[arg-type]
                            is_estimate=estimate, explanation=explanation),
                level if grams is not None else None, warnings)

    def from_model_weight(reason: str) -> tuple[PortionInfo, Any, list[str]]:
        if item.estimated_weight_g:
            warnings.append("portion_estimated")
            return done(item.estimated_weight_g, "model_estimate", "low",
                        f"Estimated from the photo/description ({reason}). Please check the amount.", True)
        warnings.append("portion_required")
        return done(None, "unresolved", None, f"Couldn't work out the amount ({reason}). Please enter it.", True)

    # Weight units.
    if q is not None and unit in ("g", "kg"):
        grams = q * (1000 if unit == "kg" else 1)
        if stated:
            return done(grams, source, "high", f"{q:g} {unit} as you entered it.", False)
        warnings.append("portion_estimated")
        return done(grams, "model_estimate", "low", f"About {q:g} {unit}, estimated.", True)

    # Volume units: through the food's density.
    if q is not None and unit in ("ml", "l"):
        ml = q * (1000 if unit == "l" else 1)
        if food is None:
            warnings.append("portion_needs_food")
            return done(None, "unresolved", None, "Choose the food to convert this volume to grams.", True)
        if food.density_g_per_ml is None:
            return from_model_weight("no density for this food")
        if food.density_assumed:
            warnings.append("density_assumed")
        level = ("high" if stated and not food.density_assumed else "medium") if stated else "low"
        if not stated:
            warnings.append("portion_estimated")
        return done(ml * food.density_g_per_ml, source if stated else "model_estimate", level,
                    f"{q:g} {unit} at {food.density_g_per_ml:g} g/ml.", not stated or food.density_assumed)

    count = q if q is not None else (1.0 if unit is not None else None)

    # Household units and counts: the food's own serving first.
    if count is not None and food is not None and food.default_serving is not None and (
        unit is None or _serving_matches_unit(food.default_serving, unit)
    ):
        serving = food.default_serving
        if unit is None:
            warnings.append("serving_size_assumed")
        if not stated:
            warnings.append("portion_estimated")
        return done(count * serving.grams, "catalogue_serving", "medium" if stated and unit else "low",
                    f"{count:g} x {serving.label} ({serving.grams:g} g each, from the food database).", True)

    if count is not None and unit in HOUSEHOLD_ML:
        if food is None:
            warnings.append("portion_needs_food")
            return done(None, "unresolved", None, "Choose the food to work out this amount.", True)
        density = food.density_g_per_ml or 1.0
        if food.density_g_per_ml is None or food.density_assumed:
            warnings.append("density_assumed")
        warnings.append("generic_unit_conversion")
        return done(count * HOUSEHOLD_ML[unit] * density, "generic_conversion", "low",
                    f"{count:g} {unit} taken as {HOUSEHOLD_ML[unit]:g} ml each (a typical size). Please check.", True)

    if count is None and food is not None and food.default_serving is not None and not item.estimated_weight_g:
        warnings.append("serving_size_assumed")
        return done(food.default_serving.grams, "catalogue_serving", "low",
                    f"Assumed 1 x {food.default_serving.label} ({food.default_serving.grams:g} g). Please check.", True)

    return from_model_weight("no matching serving size" if unit else "no amount given")


def _option_from_match(m: FoodMatch) -> FoodOption:
    return FoodOption(
        food_id=m.food_id, name=m.name, brand=m.brand, source=m.source, source_ref=m.source_ref,
        match_confidence=m.confidence, per_100=m.per_100, default_serving=m.default_serving,
        quality_flags=m.quality.flags,
    )


async def _selected_food(db: SupabaseRest, user: AuthenticatedUser, food_id: uuid.UUID) -> tuple[FoodOption, FoodPortionContext] | None:
    rows = await db.select(user, "foods", {
        "select": "id,name,brand,source,source_ref,basis,density_g_per_ml,kcal_per_100,protein_g_per_100,"
                  "carbs_g_per_100,fat_g_per_100,fiber_g_per_100,sugars_g_per_100,saturated_fat_g_per_100,"
                  "sodium_g_per_100,quality_flags,is_matchable,food_servings(label,grams,is_default)",
        "id": f"eq.{food_id}",
    })
    if not rows or not rows[0].get("is_matchable"):
        return None
    r = rows[0]
    servings = [s for s in (r.get("food_servings") or []) if s.get("is_default")]
    serving = Serving(label=servings[0]["label"], grams=float(servings[0]["grams"])) if servings else None
    opt = lambda k: None if r.get(k) is None else float(r[k])  # noqa: E731
    option = FoodOption(
        food_id=r["id"], name=r["name"], brand=r.get("brand"), source=r["source"], source_ref=r.get("source_ref"),
        match_confidence=None, default_serving=serving, quality_flags=list(r.get("quality_flags") or []),
        per_100=NutritionPer100(
            basis=r["basis"], kcal=float(r["kcal_per_100"]), protein_g=float(r["protein_g_per_100"]),
            carbs_g=float(r["carbs_g_per_100"]), fat_g=float(r["fat_g_per_100"]),
            fiber_g=opt("fiber_g_per_100"), sugars_g=opt("sugars_g_per_100"),
            saturated_fat_g=opt("saturated_fat_g_per_100"), sodium_g=opt("sodium_g_per_100"),
        ),
    )
    return option, _context(option, r.get("density_g_per_ml"))


def _context(option: FoodOption, density: Any) -> FoodPortionContext:
    return FoodPortionContext(
        basis=option.per_100.basis,
        density_g_per_ml=None if density is None else float(density),
        density_assumed="density_assumed" in option.quality_flags,
        default_serving=option.default_serving,
    )


async def _density(db: SupabaseRest, user: AuthenticatedUser, food_id: uuid.UUID) -> float | None:
    rows = await db.select(user, "foods", {"select": "density_g_per_ml", "id": f"eq.{food_id}"})
    value = rows[0].get("density_g_per_ml") if rows else None
    return None if value is None else float(value)


async def ground_item(db: SupabaseRest, user: AuthenticatedUser, item: ProposalItemInput) -> ProposalItem:
    warnings: list[str] = []

    # 1. Match
    selected: FoodOption | None = None
    context: FoodPortionContext | None = None
    options: list[FoodOption] = []
    match_score: float | None = None
    if item.selected_food_id is not None:
        found = await _selected_food(db, user, item.selected_food_id)
        if found is None:
            decision: Literal["confident", "ambiguous", "no_match", "user_selected"] = "no_match"
            warnings.append("selected_food_unavailable")
        else:
            selected, context = found
            decision = "user_selected"
    else:
        results = await matching.search(db, user, item.food_name, item.brand, None, "g", matching.MAX_CANDIDATES + 1)
        results = [m for m in results if m.confidence >= matching.MIN_RETURNED_SCORE]
        decision = matching.decide(results)  # type: ignore[assignment]
        options = [_option_from_match(m) for m in results[:3]]
        if decision == "confident":
            selected = options[0]
            match_score = results[0].confidence
            context = _context(selected, await _density(db, user, selected.food_id))
        elif decision == "ambiguous":
            warnings.append("choose_food")
        else:
            warnings.append("no_catalogue_match")

    if selected is not None and "energy_mismatch" in selected.quality_flags:
        warnings.append("catalogue_data_inconsistent")

    # 2. Portion
    portion, portion_level, portion_warnings = resolve_portion(item, context)
    warnings.extend(w for w in portion_warnings if w not in warnings)

    # 3. Nutrition (only with a food and grams; never invented)
    nutrition: NutritionInfo | None = None
    if selected is not None and portion.grams is not None:
        rows = await db.rpc(user, "food_portion", {"p_food_id": str(selected.food_id), "p_grams": portion.grams})
        row = rows[0] if rows else None
        if row and row.get("nutrients_per_100g") is not None:
            snapshot = {k: float(v) for k, v in row["nutrients_per_100g"].items()}
            nutrition = NutritionInfo(
                per_100g=snapshot,
                calories=float(row["calories"]), protein_g=float(row["protein_g"]),
                carbs_g=float(row["carbs_g"]), fat_g=float(row["fat_g"]),
                missing_nutrients=[n for n in OPTIONAL_NUTRIENTS if n not in snapshot],
                source=selected.source, source_ref=selected.source_ref,
            )
            if nutrition.missing_nutrients:
                warnings.append("some_nutrients_missing")
        else:
            warnings.append("nutrition_unavailable")

    recognition = item.recognition_confidence
    if recognition is not None and recognition < 0.5:
        warnings.append("low_recognition_confidence")
    status: Literal["ready", "needs_attention"] = "ready" if nutrition is not None else "needs_attention"
    return ProposalItem(
        candidate_id=item.candidate_id,
        food_name=item.food_name,
        brand=item.brand,
        match=MatchInfo(decision=decision, selected=selected, options=options),
        portion=portion,
        nutrition=nutrition,
        confidence=ConfidenceInfo(
            recognition=recognition,
            recognition_level=None if recognition is None else ("high" if recognition >= 0.8 else "medium" if recognition >= 0.5 else "low"),
            match=match_score,
            match_level=decision,
            portion_level=portion_level,
        ),
        warnings=warnings,
        status=status,
    )


def build_proposal(items: list[ProposalItem]) -> MealProposal:
    ready = [i for i in items if i.nutrition is not None]
    totals = ProposalTotals(
        calories=round(sum(i.nutrition.calories for i in ready), 1),  # type: ignore[union-attr]
        protein_g=round(sum(i.nutrition.protein_g for i in ready), 1),  # type: ignore[union-attr]
        carbs_g=round(sum(i.nutrition.carbs_g for i in ready), 1),  # type: ignore[union-attr]
        fat_g=round(sum(i.nutrition.fat_g for i in ready), 1),  # type: ignore[union-attr]
        items_counted=len(ready),
        is_estimate=any(i.portion.is_estimate for i in ready),
    )
    return MealProposal(items=items, totals=totals, can_confirm=bool(items) and len(ready) == len(items))


async def ground(db: SupabaseRest, user: AuthenticatedUser, items: list[ProposalItemInput]) -> MealProposal:
    return build_proposal([await ground_item(db, user, i) for i in items])
