"""Recommendation orchestration, shared by the app API and the assistant tool:
context and candidates -> engine -> exact pricing by the database -> history.

Nothing here logs food. Writes, all as the user through PostgREST (RLS):
  * recommendation history (sets/items, 90-day retention) when persist=True;
  * interaction events and feedback the user sends;
  * a PENDING food-log proposal, which the user must confirm through the
    existing proposal flow (the only path that writes food logs).
The assistant uses persist=False: its tool is read-only.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import math
import uuid
from typing import Any

from app.assistant.proposals import (
    FoodLogProposal,
    ItemNutrition,
    ProposalService,
    ProposedFood,
    price_recipe_item,
    to_proposed,
)
from app.core.security import AuthenticatedUser
from app.db.supabase import DatabaseError, SupabaseRest
from app.recommendations import engine
from app.recommendations.config import DEFAULT_CONFIG, ENGINE_VERSION, EngineConfig, protein_focus
from app.recommendations.models import AddOn, Candidate, Nutrition, Part, Recommendation, Request
from app.recommendations.repository import RecommendationRepository, item_key
from app.schemas.recognition import ProposalItemInput
from app.schemas.recommendations import (
    BudgetOut,
    DataQualityOut,
    ExclusionOut,
    FeedbackOut,
    FeedbackResult,
    IngredientOut,
    LogProposalIn,
    NutritionOut,
    OptionalComponentOut,
    PortionOut,
    RecommendationDetail,
    RecommendationOut,
    RecommendationQuery,
    RecommendationResponse,
    ScoreOut,
    WithheldOut,
)
from app.services import grounding

log = logging.getLogger(__name__)

SPARES = 3   # extra ranked picks kept in case one cannot be priced
APP_MEAL = {"breakfast": "breakfast", "lunch": "lunch", "dinner": "dinner", "snack": "afternoon_snack"}
EVENT_FOR = {"viewed": "viewed", "selected": "selected", "rejected": "rejected", "planned": "planned",
             "saved": "saved", "unsaved": "unsaved", "not_interested": "rejected", "never": "rejected"}
FEEDBACK_FOR = {"saved": "saved", "not_interested": "less_often", "never": "never"}
ITEM_COLUMNS = ("id,set_id,rank,kind,food_id,template_id,recipe_id,score,score_breakdown,created_at,"
                "recommendation_sets(meal_type,local_date)")
FEEDBACK_COLUMNS = "id,feedback,food_id,template_id,recipe_family_id,name,item_id,created_at,expires_at"


class RecommendationNotFound(Exception):
    """No such recommendation for this user (RLS hides other users' rows)."""


class RecommendationUnavailable(Exception):
    """The recommended meal can no longer be served or priced (retired recipe,
    inactive food...). Never presented as available."""


class InvalidOptional(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class InvalidServings(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


# ============================================================================ pricing

def portion_grams(part: Part, servings: float) -> float | None:
    """The weight sent to food_portion (recipes are priced by servings instead)."""
    return round(part.serving_grams * servings, 1) if part.ref_kind == "food" and part.serving_grams else None


async def price_part(db: SupabaseRest, user: AuthenticatedUser, part: Part, servings: float) -> Nutrition | None:
    """Exact nutrition for `servings` of one part, from the database functions
    used for logging. None if the database cannot price it (never estimated)."""
    try:
        if part.ref_kind == "food":
            grams = portion_grams(part, servings)
            if grams is None:
                return None
            rows = await db.rpc(user, "food_portion", {"p_food_id": part.ref_id, "p_grams": grams})
            row = rows[0] if isinstance(rows, list) and rows else None
            if not row or row.get("calories") is None:
                return None
            return Nutrition(float(row["calories"]), float(row["protein_g"]), float(row["carbs_g"]), float(row["fat_g"]))
        value = await db.rpc(user, "recipe_portion", {"p_recipe_id": part.ref_id, "p_portions": servings})
        if not isinstance(value, dict) or value.get("calories") is None:
            return None
        return Nutrition(float(value["calories"]), float(value["protein_g"]), float(value["carbs_g"]),
                         float(value["fat_g"]))
    except DatabaseError as exc:
        log.warning("recommendation pricing failed for %s %s: %s", part.ref_kind, part.ref_id, exc.code)
        return None


async def price_parts(db: SupabaseRest, user: AuthenticatedUser, parts: tuple[Part, ...],
                      servings: tuple[float, ...]) -> Nutrition | None:
    priced = await asyncio.gather(*(price_part(db, user, p, s) for p, s in zip(parts, servings, strict=True)))
    if any(p is None for p in priced):
        return None
    total = Nutrition(0, 0, 0, 0)
    for p in priced:
        total = total + p  # type: ignore[operator]
    return total


async def price(db: SupabaseRest, user: AuthenticatedUser, r: Recommendation) -> Nutrition | None:
    return await price_parts(db, user, r.candidate.parts, r.servings)


async def price_in_order(db: SupabaseRest, user: AuthenticatedUser, ranked: tuple[Recommendation, ...],
                         count: int) -> tuple[list[tuple[Recommendation, Nutrition]], int]:
    """Prices picks in rank order until `count` are confirmed. Returns the
    priced picks and how many were dropped because they could not be priced."""
    kept: list[tuple[Recommendation, Nutrition]] = []
    dropped = 0
    start = 0
    while len(kept) < count and start < len(ranked):
        batch = ranked[start:start + (count - len(kept))]
        start += len(batch)
        results = await asyncio.gather(*(price(db, user, r) for r in batch))
        for r, n in zip(batch, results, strict=True):
            if n is None:
                dropped += 1
            else:
                kept.append((r, n))
    return kept[:count], dropped


# ============================================================================ output

def ingredients_for(c: Candidate, servings: tuple[float, ...]) -> list[IngredientOut]:
    """Recipe ingredients scaled to the servings; template components as listed."""
    out: list[IngredientOut] = []
    for idx, (p, s) in enumerate(zip(c.parts, servings, strict=True)):
        if p.ref_kind == "recipe" and p.yields:
            f = s / p.yields
            for i in p.ingredients:
                q, g = i.get("quantity"), i.get("grams")
                out.append(IngredientOut(
                    part=idx, name=i.get("food_name") or "", unit=i.get("unit"),
                    quantity=round(float(q) * f, 2) if q is not None else None,
                    grams=round(float(g) * f, 1) if g is not None else None,
                    preparation=i.get("preparation"), optional=bool(i.get("optional"))))
        elif p.ref_kind == "food" and c.kind == "meal":
            out.append(IngredientOut(part=idx, name=p.name, quantity=s, unit=p.serving_label,
                                     grams=portion_grams(p, s)))
    return out


def _nout(n: Nutrition) -> NutritionOut:
    return NutritionOut(kcal=half_up(n.kcal), protein_g=half_up(n.protein_g), carbs_g=half_up(n.carbs_g),
                        fat_g=half_up(n.fat_g))


async def price_addons(db: SupabaseRest, user: AuthenticatedUser, addons: tuple[AddOn, ...]
                       ) -> tuple[list[tuple[AddOn, Nutrition]], list[tuple[str, str]]]:
    """Each offered add-on priced at its default servings. One the database
    cannot price is withheld, never estimated."""
    prices = await asyncio.gather(*(price_part(db, user, a.part, a.part.default) for a in addons))
    ok = [(a, n) for a, n in zip(addons, prices, strict=True) if n is not None]
    lost = [(a.part.name, "incomplete_nutrition") for a, n in zip(addons, prices, strict=True) if n is None]
    return ok, lost


def addon_out(a: AddOn, n: Nutrition) -> OptionalComponentOut:
    p = a.part
    return OptionalComponentOut(
        id=p.ref_id, name=p.name, slot=p.slot, servings=p.default, serving_label=p.serving_label,
        grams=portion_grams(p, p.default), nutrition=_nout(n), diet_classes=sorted(a.diet_classes),
        diet_status=a.diet_status, allergens_detected=sorted(a.allergens),  # type: ignore[arg-type]
        allergen_status=a.allergen_status, quality_flags=sorted(a.quality_flags))  # type: ignore[arg-type]


def item_out(rank: int, c: Candidate, servings: tuple[float, ...], n: Nutrition, *, score: float, fit: str,
             components: dict[str, float], weights: dict[str, float], adjustments: dict[str, float],
             diversity_penalty: float, reasons: list[str], warnings: list[str],
             item_id: str | None = None, addons: list[tuple[AddOn, Nutrition]] | None = None,
             withheld: list[tuple[str, str]] | None = None) -> RecommendationOut:
    addons = addons or []
    with_optional = None
    if addons:
        total = n
        for _, an in addons:
            total = total + an
        with_optional = _nout(total)
    return RecommendationOut(
        id=item_id, key=c.key, rank=rank, kind=c.kind, name=c.name, variant=c.variant, description=c.description,
        total_minutes=c.total_minutes, equipment=sorted(c.equipment) if c.equipment is not None else None,
        portions=[PortionOut(kind=p.ref_kind, id=p.ref_id, name=p.name, servings=s, serving_label=p.serving_label,
                             grams=portion_grams(p, s), slot=p.slot, min_servings=min(p.options),
                             max_servings=max(p.options))
                  for p, s in zip(c.parts, servings, strict=True)],
        ingredients=ingredients_for(c, servings),
        nutrition=_nout(n),
        optional_components=[addon_out(a, an) for a, an in addons],
        optional_withheld=[WithheldOut(name=name, reason=reason, label=engine.REASON_LABEL.get(reason, reason))
                           for name, reason in (withheld or [])],
        nutrition_with_optional=with_optional,
        score=ScoreOut(total=round(score, 2), fit=fit,  # type: ignore[arg-type]
                       components={k: round(v, 1) for k, v in components.items()}, weights=weights,
                       adjustments={k: round(v, 2) for k, v in adjustments.items()},
                       diversity_penalty=round(diversity_penalty, 2)),
        reasons=reasons, warnings=warnings,
        data=DataQualityOut(
            source=c.source, verification=c.verification, approximate=c.quantities_estimated,
            diet_classes=sorted(c.diet_classes), diet_status=c.diet_status,  # type: ignore[arg-type]
            allergens_detected=sorted(c.allergens), allergen_status=c.allergen_status,  # type: ignore[arg-type]
            quality_flags=sorted(c.quality_flags),
            approval_level=c.approval_level if c.kind == "meal" else None),  # type: ignore[arg-type]
    )


def _breakdown(r: Recommendation, out: RecommendationOut, weights: dict[str, float]) -> dict[str, Any]:
    c = r.candidate
    return {
        "components": {k: round(v, 3) for k, v in r.components.items()},
        "adjustments": {k: round(v, 3) for k, v in r.adjustments.items()},
        "weights": weights, "servings": list(r.servings), "fit": r.fit,
        "diversity_penalty": round(r.diversity_penalty, 4), "kcal": out.nutrition.kcal,
        "name": c.name[:200], "reasons": list(r.reasons)[:8], "warnings": list(r.warnings)[:8],
        **({"family_id": c.family_id} if c.family_id else {}),
        **({"with_recipe_id": c.extra_recipe_id} if c.extra_recipe_id else {}),
    }


def _history_rows(set_id: str, items: list[RecommendationOut], picks: list[Recommendation],
                  weights: dict[str, float]) -> list[dict]:
    rows = []
    for out, r in zip(items, picks, strict=True):
        c = r.candidate
        rows.append({
            "set_id": set_id, "rank": out.rank, "kind": c.kind,
            "food_id": c.food_id if c.kind == "food" else None,
            "template_id": c.template_id if c.kind == "meal" else None,
            "recipe_id": c.recipe_id if c.kind in ("recipe", "combo") else None,
            "score": round(r.score, 4), "score_breakdown": _breakdown(r, out, weights),
        })
    return rows


async def _save_history(db: SupabaseRest, user: AuthenticatedUser, q: RecommendationQuery,
                        response: RecommendationResponse, picks: list[Recommendation],
                        weights: dict[str, float]) -> tuple[str | None, dict[int, str]]:
    """Records what was shown. Failure to record never hides the recommendations."""
    try:
        saved = await db.insert(user, "recommendation_sets", {
            "meal_type": q.meal_type, "mode": q.mode, "local_date": response.local_date.isoformat(),
            "engine_version": ENGINE_VERSION,
            "context": {
                "status": response.status, "tolerance": q.tolerance, "count": q.count, "protein": q.protein,
                "max_kcal": q.max_kcal, "cuisine": q.cuisine,
                "budget": response.budget.model_dump(mode="json"), "considered": response.considered,
                "excluded": {e.reason: e.count for e in response.excluded},
            },
        })
        ids: dict[int, str] = {}
        if response.items:
            rows = await db.insert_many(user, "recommendation_items",
                                        _history_rows(saved["id"], response.items, picks, weights), select="rank,id")
            ids = {int(r["rank"]): str(r["id"]) for r in rows}
        return str(saved["id"]), ids
    except DatabaseError as exc:
        log.warning("could not record recommendation history: %s", exc.code)
        return None, {}


# ============================================================================ list

async def recommend(db: SupabaseRest, user: AuthenticatedUser, repo: RecommendationRepository,
                    q: RecommendationQuery, cfg: EngineConfig = DEFAULT_CONFIG,
                    persist: bool = True) -> RecommendationResponse:
    ctx = await repo.context(user, q.date)
    candidates = await repo.candidates(user, q.mode)
    ereq = Request(meal_type=q.meal_type, count=q.count, mode=q.mode, tolerance=q.tolerance,
                   target_kcal=q.target_kcal, max_kcal=q.max_kcal, protein=q.protein, cuisine=q.cuisine,
                   exclude_keys=frozenset(q.exclude))
    result = engine.recommend(candidates, ctx, ereq, cfg, limit=q.count + SPARES)

    kept, dropped = await price_in_order(db, user, result.items, q.count)
    status, notes = result.status, list(result.notes)
    if dropped:
        notes.append(f"{dropped} option{'s' if dropped != 1 else ''} left out because the database could not "
                     "confirm their nutrition.")
    if result.items and not kept:
        status = "insufficient_data"
    elif status == "ok" and len(kept) < q.count:
        status = "partial"
        notes.append(f"Only {len(kept)} option{'s' if len(kept) != 1 else ''} fit well; no weaker ones were "
                     "added to fill the list.")

    w = cfg.weights(ctx.goal)
    if q.protein == "high":
        w = protein_focus(w)
    weights = {k: round(v, 3) for k, v in w.as_dict().items()}
    priced_addons = await asyncio.gather(*(price_addons(db, user, r.addons) for r, _ in kept))
    items = [item_out(i, r.candidate, r.servings, n, score=r.score, fit=r.fit, components=r.components,
                      weights=weights, adjustments=r.adjustments, diversity_penalty=r.diversity_penalty,
                      reasons=list(r.reasons), warnings=list(r.warnings), addons=ok,
                      withheld=list(r.addons_withheld) + lost)
             for i, ((r, n), (ok, lost)) in enumerate(zip(kept, priced_addons, strict=True), start=1)]
    b = result.budget
    response = RecommendationResponse(
        set_id=None, engine_version=ENGINE_VERSION, status=status, local_date=ctx.local_date,
        budget=BudgetOut(meal_type=q.meal_type, kcal=half_up(b.kcal), protein_g=half_up(b.protein_g),
                         carbs_g=half_up(b.carbs_g), fat_g=half_up(b.fat_g), basis=b.basis, mode=b.mode,
                         remaining_kcal=None if b.remaining_kcal is None else half_up(b.remaining_kcal),
                         tolerance=q.tolerance),
        items=items, considered=result.considered,
        excluded=[ExclusionOut(reason=k, label=engine.REASON_LABEL.get(k, k), count=v)
                  for k, v in result.excluded.items()],
        notes=notes,
    )
    if not persist:
        return response
    set_id, ids = await _save_history(db, user, q, response, [r for r, _ in kept], weights)
    return response.model_copy(update={
        "set_id": set_id,
        "items": [i.model_copy(update={"id": ids.get(i.rank)}) for i in response.items],
    })


# ============================================================================ one recommendation

async def _load_item(db: SupabaseRest, user: AuthenticatedUser, item_id: uuid.UUID) -> dict[str, Any]:
    rows = await db.select(user, "recommendation_items", {"select": ITEM_COLUMNS, "id": f"eq.{item_id}", "limit": "1"})
    if not rows:
        raise RecommendationNotFound()
    return rows[0]


def _stored_key(row: dict[str, Any]) -> str | None:
    if row.get("kind") == "combo":
        extra = (row.get("score_breakdown") or {}).get("with_recipe_id")
        return f"combo:{row['recipe_id']}+{extra}" if row.get("recipe_id") and extra else None
    return item_key(row)


async def _resolve(db: SupabaseRest, user: AuthenticatedUser, repo: RecommendationRepository, item_id: uuid.UUID,
                   servings: list[float] | None) -> tuple[dict[str, Any], Candidate, tuple[float, ...], Nutrition]:
    row = await _load_item(db, user, item_id)
    key = _stored_key(row)
    c = await repo.find(user, key) if key else None
    if c is None or not c.parts:
        raise RecommendationUnavailable()
    recommended = tuple(float(s) for s in (row.get("score_breakdown") or {}).get("servings") or ())
    if len(recommended) != len(c.parts):
        raise RecommendationUnavailable()      # the meal changed shape since it was recommended
    chosen = tuple(float(s) for s in servings) if servings else recommended
    if len(chosen) != len(c.parts):
        raise InvalidServings(f"Give one servings value per portion ({len(c.parts)}).")
    for p, s in zip(c.parts, chosen, strict=True):
        lo, hi = min(p.options) / 2, max(p.options) * 2
        if not lo <= s <= hi:
            raise InvalidServings(f"{p.name}: servings must be between {lo:g} and {hi:g}.")
    n = await price_parts(db, user, c.parts, chosen)
    if n is None:
        raise RecommendationUnavailable()
    return row, c, chosen, n


def _stored_out(row: dict[str, Any], c: Candidate, servings: tuple[float, ...], n: Nutrition,
                addons: list[tuple[AddOn, Nutrition]] | None = None,
                withheld: list[tuple[str, str]] | None = None) -> RecommendationOut:
    b = row.get("score_breakdown") or {}
    return item_out(int(row["rank"]), c, servings, n, score=float(row["score"]), fit=b.get("fit", "fair"),
                    components=b.get("components", {}), weights=b.get("weights", {}),
                    adjustments=b.get("adjustments", {}), diversity_penalty=float(b.get("diversity_penalty", 0)),
                    reasons=list(b.get("reasons", [])), warnings=list(b.get("warnings", [])),
                    item_id=str(row["id"]), addons=addons, withheld=withheld)


def _target(row: dict[str, Any]) -> tuple[str, str] | None:
    """(feedback column, id) for a stored recommendation."""
    if row["kind"] == "food" and row.get("food_id"):
        return "food_id", str(row["food_id"])
    if row["kind"] == "meal" and row.get("template_id"):
        return "template_id", str(row["template_id"])
    family = (row.get("score_breakdown") or {}).get("family_id")
    return ("recipe_family_id", str(family)) if family else None


async def _addons_now(db: SupabaseRest, user: AuthenticatedUser, repo: RecommendationRepository, c: Candidate,
                      selected: list[str]) -> tuple[list[tuple[AddOn, Nutrition]], list[tuple[str, str]],
                                                     list[tuple[AddOn, Nutrition]]]:
    """Add-ons re-checked against the user's CURRENT preferences, priced now.
    Returns (offered, withheld, selected)."""
    if not c.addons:
        if selected:
            raise InvalidOptional("This meal has no optional components.")
        return [], [], []
    offered, withheld = engine.split_addons(c, await repo.preference_context(user))
    ok, lost = await price_addons(db, user, offered)
    by_id = {a.part.ref_id: (a, n) for a, n in ok}
    unknown = [s for s in selected if s not in by_id]
    if unknown:
        raise InvalidOptional("Some optional components aren't offered for this meal (or not to you): "
                              + ", ".join(unknown))
    return ok, list(withheld) + lost, [by_id[s] for s in dict.fromkeys(selected)]


async def get_detail(db: SupabaseRest, user: AuthenticatedUser, repo: RecommendationRepository,
                     item_id: uuid.UUID, servings: list[float] | None = None,
                     optional: list[str] | None = None) -> RecommendationDetail:
    row, c, chosen, n = await _resolve(db, user, repo, item_id, servings)
    ok, withheld, selected = await _addons_now(db, user, repo, c, [str(o) for o in optional or []])
    recipe_ids = [p.ref_id for p in c.parts if p.ref_kind == "recipe"]
    instructions: list[list[str]] = []
    if recipe_ids:
        rows = await db.select(user, "recipes", {"select": "id,instructions", "id": f"in.({','.join(recipe_ids)})"})
        by_id = {str(r["id"]): r.get("instructions") or [] for r in rows}
        instructions = [list(by_id.get(rid, [])) for rid in recipe_ids]
    target = _target(row)
    saved = False
    if target:
        fb = await db.select(user, "recommendation_feedback", {
            "select": "id", target[0]: f"eq.{target[1]}", "feedback": "eq.saved", "limit": "1"})
        saved = bool(fb)
    s = row.get("recommendation_sets") or {}
    return RecommendationDetail(
        id=row["id"], set_id=row["set_id"], meal_type=s.get("meal_type", "lunch"),
        local_date=s.get("local_date") or dt.date.today(), created_at=row["created_at"],
        recommended_servings=list((row.get("score_breakdown") or {}).get("servings") or []),
        item=_stored_out(row, c, chosen, n, ok, withheld), instructions=instructions, saved=saved,
        selected_optional=[a.part.ref_id for a, _ in selected],
        total_nutrition=_nout(sum((an for _, an in selected), n)))


# ============================================================================ feedback

def feedback_out(r: dict[str, Any]) -> FeedbackOut:
    if r.get("food_id"):
        kind, target = "food", r["food_id"]
    elif r.get("template_id"):
        kind, target = "meal", r["template_id"]
    else:
        kind, target = "recipe", r["recipe_family_id"]
    return FeedbackOut(id=r["id"], feedback=r["feedback"], kind=kind, target_id=target, name=r.get("name"),
                       item_id=r.get("item_id"), created_at=r["created_at"], expires_at=r.get("expires_at"))


async def record_feedback(db: SupabaseRest, user: AuthenticatedUser, item_id: uuid.UUID,
                          action: str) -> FeedbackResult:
    row = await _load_item(db, user, item_id)
    await db.insert(user, "recommendation_events",
                    {"set_id": row["set_id"], "rank": row["rank"], "event": EVENT_FOR[action]})
    target = _target(row)
    if target is None or action not in (*FEEDBACK_FOR, "unsaved"):
        return FeedbackResult(recommendation_id=item_id, action=action, event_recorded=True)  # type: ignore[arg-type]
    column, value = target
    if action == "unsaved":
        await db.delete(user, "recommendation_feedback", {column: f"eq.{value}", "feedback": "eq.saved"})
        return FeedbackResult(recommendation_id=item_id, action=action, event_recorded=True)  # type: ignore[arg-type]
    # One feedback row per thing: the newest choice replaces the previous one.
    await db.delete(user, "recommendation_feedback", {column: f"eq.{value}"})
    saved = await db.insert(user, "recommendation_feedback", {
        column: value, "feedback": FEEDBACK_FOR[action], "item_id": str(item_id),
        "name": ((row.get("score_breakdown") or {}).get("name") or None)})
    return FeedbackResult(recommendation_id=item_id, action=action, event_recorded=True,  # type: ignore[arg-type]
                          feedback=feedback_out(saved))


async def list_feedback(db: SupabaseRest, user: AuthenticatedUser, feedback: str | None = None) -> list[FeedbackOut]:
    params = {"select": FEEDBACK_COLUMNS, "order": "created_at.desc", "limit": "500"}
    if feedback:
        params["feedback"] = f"eq.{feedback}"
    now = dt.datetime.now(dt.UTC)
    rows = await db.select(user, "recommendation_feedback", params)
    return [feedback_out(r) for r in rows
            if not r.get("expires_at") or dt.datetime.fromisoformat(str(r["expires_at"]).replace("Z", "+00:00")) > now]


async def delete_feedback(db: SupabaseRest, user: AuthenticatedUser, feedback_id: uuid.UUID) -> bool:
    return bool(await db.delete(user, "recommendation_feedback", {"id": f"eq.{feedback_id}"}))


# ============================================================================ log proposal

async def _proposed(db: SupabaseRest, user: AuthenticatedUser, c: Candidate, part: Part,
                    servings: float) -> ProposedFood | None:
    if part.ref_kind == "food":
        grams = portion_grams(part, servings)
        if grams is None:
            return None
        item = await grounding.ground_item(db, user, ProposalItemInput(
            food_name=part.name, quantity=grams, unit="g", selected_food_id=part.ref_id, quantity_source="manual"))
        return to_proposed(item, part.name, "manual")
    base = ProposedFood(
        food_id=None, food_name=part.name, requested_name=c.name, quantity=servings, unit="serving", grams=None,
        quantity_source="manual", portion_source="recipe", portion_is_estimate=c.quantities_estimated,
        portion_explanation=f"{servings:g} x {part.serving_label} of the published recipe",
        nutrition=ItemNutrition(calories=0, protein_g=0, carbs_g=0, fat_g=0), per_100g={},
        nutrition_source="recipe", source_ref=None,
        warnings=(["Ingredient quantities are typical home amounts, so nutrition is approximate."]
                  if c.quantities_estimated else []),
        recipe_id=part.ref_id, recipe_servings=servings)
    return await price_recipe_item(db, user, base, servings)


async def create_log_proposal(db: SupabaseRest, user: AuthenticatedUser, repo: RecommendationRepository,
                              proposals: ProposalService, item_id: uuid.UUID, body: LogProposalIn) -> FoodLogProposal:
    """A PENDING proposal for this recommendation. Nothing is logged until the
    user confirms it (POST /v1/assistant/proposals/{id}/confirm)."""
    row, c, chosen, _ = await _resolve(db, user, repo, item_id, body.servings)
    _, _, selected = await _addons_now(db, user, repo, c, [str(o) for o in body.optional])
    parts = list(zip(c.parts, chosen, strict=True)) + [(a.part, a.part.default) for a, _ in selected]
    items = await asyncio.gather(*(_proposed(db, user, c, p, s) for p, s in parts))
    if any(i is None for i in items):
        raise RecommendationUnavailable()
    s = row.get("recommendation_sets") or {}
    meal_type = body.meal_type or APP_MEAL.get(s.get("meal_type", "lunch"), "lunch")
    logged_date = body.date or dt.date.fromisoformat(str(s.get("local_date") or dt.date.today()))
    proposal = await proposals.create(user, None, meal_type, logged_date, list(items),  # type: ignore[arg-type]
                                      recommendation_item_id=item_id)
    try:
        await db.insert(user, "recommendation_events", {"set_id": row["set_id"], "rank": row["rank"],
                                                        "event": "selected"})
    except DatabaseError:
        pass
    return proposal
