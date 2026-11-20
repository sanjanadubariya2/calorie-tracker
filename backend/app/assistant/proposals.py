"""Food-log proposals (Phase 2 Task 5).

Three separate paths:
* Proposal generation (the `prepare_food_log` tool): resolves foods against the
  catalogue, prices them deterministically (grounding / food_portion) and
  stores a PENDING proposal for the verified user. Nothing is logged.
* Confirmation (HTTP only, called by the app with the user's token): claims the
  pending proposal, re-validates and re-prices every item, then inserts the
  food logs AS THE USER through the normal path (RLS, nutrition snapshot and
  streak triggers). The model has no tool that can reach this.
* Rejection (HTTP only).

A proposal is single-use: pending -> confirming -> confirmed. A failed save
puts it back to pending so the user can retry; a second confirmation gets 409.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from app.assistant.store import AssistantWriter
from app.core.security import AuthenticatedUser
from app.db.supabase import SupabaseRest
from app.schemas.recognition import ProposalItem, ProposalItemInput
from app.services import grounding
from app.services.recognition.model_output import UNITS

MealType = Literal["breakfast", "lunch", "dinner", "morning_snack", "afternoon_snack", "evening_snack"]
Unit = Literal[UNITS]  # type: ignore[valid-type]
ProposalStatus = Literal["pending", "confirming", "confirmed", "rejected", "expired"]


# ============================================================================ models

class ItemNutrition(BaseModel):
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float


class ProposedFood(BaseModel):
    food_id: uuid.UUID                     # catalogue food
    food_name: str                         # the catalogue's name
    requested_name: str                    # what the user/model asked for
    quantity: float | None
    unit: str | None
    grams: float
    quantity_source: str                   # user_stated | model_estimate | manual
    portion_source: str                    # how grams were derived
    portion_is_estimate: bool
    portion_explanation: str
    nutrition: ItemNutrition
    per_100g: dict[str, float]
    nutrition_source: str                  # e.g. indb
    source_ref: str | None
    warnings: list[str]


class ProposalTotals(BaseModel):
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float


class FoodLogProposal(BaseModel):
    id: uuid.UUID
    status: ProposalStatus
    expires_at: dt.datetime
    meal_type: MealType
    logged_date: dt.date
    items: list[ProposedFood]
    totals: ProposalTotals
    requires_user_confirmation: Literal[True] = True
    food_log_ids: list[uuid.UUID] = Field(default_factory=list)


class ItemEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    index: int = Field(ge=0, le=9)
    quantity: float | None = Field(default=None, gt=0, le=10000)
    unit: Unit | None = None
    remove: bool = False


class ConfirmRequest(BaseModel):
    """What the user may change on the confirmation screen."""
    model_config = ConfigDict(extra="forbid")
    meal_type: MealType | None = None
    items: list[ItemEdit] = Field(default_factory=list, max_length=10)


class SavedLog(BaseModel):
    id: uuid.UUID
    food_name: str
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float
    serving_g: float | None
    meal_type: str
    logged_date: dt.date


class ConfirmResult(BaseModel):
    proposal: FoodLogProposal
    food_logs: list[SavedLog]


# ============================================================================ errors

class ProposalNotFound(Exception):
    pass


class ProposalStateError(Exception):
    """Not pending (already confirmed/rejected/being saved) or expired."""

    def __init__(self, status: str) -> None:
        super().__init__(status)
        self.status = status


class ProposalInvalid(Exception):
    """Re-validation failed; nothing was saved."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


class ProposalSaveFailed(Exception):
    """The database refused or failed the insert; nothing was saved, retry is possible."""


# ============================================================================ pricing (shared by prepare and confirm)

def _r1(v: float) -> float:
    return round(float(v), 1)


def to_proposed(item: ProposalItem, requested_name: str, quantity_source: str) -> ProposedFood | None:
    """A ready grounded item as a proposal line; None if it isn't loggable."""
    sel = item.match.selected
    if item.status != "ready" or sel is None or item.nutrition is None or item.portion.grams is None:
        return None
    n = item.nutrition
    return ProposedFood(
        food_id=sel.food_id, food_name=sel.name, requested_name=requested_name,
        quantity=item.portion.quantity, unit=item.portion.unit, grams=item.portion.grams,
        quantity_source=quantity_source, portion_source=item.portion.source,
        portion_is_estimate=item.portion.is_estimate, portion_explanation=item.portion.explanation,
        nutrition=ItemNutrition(calories=n.calories, protein_g=n.protein_g, carbs_g=n.carbs_g, fat_g=n.fat_g),
        per_100g=n.per_100g, nutrition_source=n.source, source_ref=n.source_ref, warnings=item.warnings,
    )


def totals(items: list[ProposedFood]) -> ProposalTotals:
    return ProposalTotals(
        calories=_r1(sum(i.nutrition.calories for i in items)), protein_g=_r1(sum(i.nutrition.protein_g for i in items)),
        carbs_g=_r1(sum(i.nutrition.carbs_g for i in items)), fat_g=_r1(sum(i.nutrition.fat_g for i in items)),
    )


# ============================================================================ storage

class ProposalStore(Protocol):
    async def create(self, user: AuthenticatedUser, conversation_id: uuid.UUID, payload: dict[str, Any],
                     ttl_minutes: int) -> dict[str, Any]: ...
    async def get(self, user: AuthenticatedUser, proposal_id: uuid.UUID) -> dict[str, Any] | None: ...
    async def statuses(self, user: AuthenticatedUser, ids: list[uuid.UUID]) -> dict[str, dict[str, Any]]: ...
    async def transition(self, user: AuthenticatedUser, proposal_id: uuid.UUID, from_status: str, to_status: str,
                         food_log_ids: list[str] | None = None, require_unexpired: bool = False) -> dict[str, Any] | None: ...


_COLUMNS = "id,status,payload,expires_at,food_log_ids,created_at"


class SupabaseProposalStore:
    """Reads as the user (RLS). Writes as assistant_writer, scoped by user id,
    and only as conditional status transitions (no blind updates)."""

    def __init__(self, db: SupabaseRest, writer: AssistantWriter | None) -> None:
        self._db = db
        self._writer = writer

    def _w(self) -> AssistantWriter:
        if self._writer is None:
            from app.assistant.store import StoreNotConfigured
            raise StoreNotConfigured("ASSISTANT_DATABASE_URL is not set")
        return self._writer

    async def create(self, user: AuthenticatedUser, conversation_id: uuid.UUID, payload: dict[str, Any],
                     ttl_minutes: int) -> dict[str, Any]:
        from psycopg.types.json import Jsonb

        def run(conn: Any) -> dict[str, Any]:
            return conn.execute(
                f"insert into public.assistant_proposals (user_id, conversation_id, payload, expires_at) "
                f"values (%s, %s, %s, now() + make_interval(mins => %s)) returning {_COLUMNS}",
                (user.user_id, str(conversation_id), Jsonb(payload), ttl_minutes)).fetchone()
        return await self._w().run(run)

    async def get(self, user: AuthenticatedUser, proposal_id: uuid.UUID) -> dict[str, Any] | None:
        rows = await self._db.select(user, "assistant_proposals", {"select": _COLUMNS, "id": f"eq.{proposal_id}", "limit": "1"})
        return rows[0] if rows else None

    async def statuses(self, user: AuthenticatedUser, ids: list[uuid.UUID]) -> dict[str, dict[str, Any]]:
        if not ids:
            return {}
        rows = await self._db.select(user, "assistant_proposals", {
            "select": "id,status,expires_at,food_log_ids", "id": f"in.({','.join(str(i) for i in ids)})"})
        return {str(r["id"]): r for r in rows}

    async def transition(self, user: AuthenticatedUser, proposal_id: uuid.UUID, from_status: str, to_status: str,
                         food_log_ids: list[str] | None = None, require_unexpired: bool = False) -> dict[str, Any] | None:
        expiry = "and expires_at > now()" if require_unexpired else ""

        def run(conn: Any) -> dict[str, Any] | None:
            return conn.execute(
                f"update public.assistant_proposals set status = %s, status_changed_at = now(), "
                f"food_log_ids = coalesce(%s::uuid[], food_log_ids) "
                f"where id = %s and user_id = %s and status = %s {expiry} returning {_COLUMNS}",
                (to_status, food_log_ids, str(proposal_id), user.user_id, from_status)).fetchone()
        return await self._w().run(run)


# ============================================================================ service

def effective_status(row: dict[str, Any], now: dt.datetime | None = None) -> str:
    now = now or dt.datetime.now(dt.timezone.utc)
    expires = row["expires_at"]
    if isinstance(expires, str):
        expires = dt.datetime.fromisoformat(expires)
    return "expired" if row["status"] == "pending" and expires <= now else row["status"]


def to_out(row: dict[str, Any]) -> FoodLogProposal:
    p = row["payload"]
    return FoodLogProposal(
        id=row["id"], status=effective_status(row), expires_at=row["expires_at"], meal_type=p["meal_type"],
        logged_date=p["logged_date"], items=p["items"], totals=p["totals"],
        food_log_ids=row.get("food_log_ids") or [],
    )


class ProposalService:
    def __init__(self, store: ProposalStore, db: SupabaseRest, ttl_minutes: int) -> None:
        self.store = store
        self._db = db
        self._ttl = ttl_minutes

    async def create(self, user: AuthenticatedUser, conversation_id: uuid.UUID, meal_type: str,
                     logged_date: dt.date, items: list[ProposedFood]) -> FoodLogProposal:
        payload = {"meal_type": meal_type, "logged_date": logged_date.isoformat(),
                   "items": [i.model_dump(mode="json") for i in items],
                   "totals": totals(items).model_dump(mode="json")}
        return to_out(await self.store.create(user, conversation_id, payload, self._ttl))

    async def get(self, user: AuthenticatedUser, proposal_id: uuid.UUID) -> FoodLogProposal:
        row = await self.store.get(user, proposal_id)
        if row is None:
            raise ProposalNotFound()
        return to_out(row)

    async def reject(self, user: AuthenticatedUser, proposal_id: uuid.UUID) -> FoodLogProposal:
        row = await self.store.get(user, proposal_id)
        if row is None:
            raise ProposalNotFound()
        status = effective_status(row)
        if status != "pending":
            raise ProposalStateError(status)
        updated = await self.store.transition(user, proposal_id, "pending", "rejected")
        if updated is None:
            raise ProposalStateError((await self.store.get(user, proposal_id) or row)["status"])
        return to_out(updated)

    async def confirm(self, user: AuthenticatedUser, proposal_id: uuid.UUID, request: ConfirmRequest) -> ConfirmResult:
        row = await self.store.get(user, proposal_id)                 # RLS: someone else's id is "not found"
        if row is None:
            raise ProposalNotFound()
        status = effective_status(row)
        if status == "expired" and row["status"] == "pending":
            await self.store.transition(user, proposal_id, "pending", "expired")
        if status != "pending":
            raise ProposalStateError(status)
        claimed = await self.store.transition(user, proposal_id, "pending", "confirming", require_unexpired=True)
        if claimed is None:                                            # lost a race, or expired just now
            latest = await self.store.get(user, proposal_id)
            raise ProposalStateError(effective_status(latest) if latest else "expired")
        try:
            items, meal_type, logged_date = await self._revalidate(user, claimed["payload"], request)
            saved = await self._insert_logs(user, items, meal_type, logged_date)
        except Exception:
            await self.store.transition(user, proposal_id, "confirming", "pending")   # nothing saved: allow retry
            raise
        done = await self.store.transition(user, proposal_id, "confirming", "confirmed",
                                           food_log_ids=[str(s.id) for s in saved])
        out = to_out(done or {**claimed, "status": "confirmed", "food_log_ids": [str(s.id) for s in saved]})
        return ConfirmResult(proposal=out, food_logs=saved)

    async def _revalidate(self, user: AuthenticatedUser, payload: dict[str, Any], request: ConfirmRequest
                          ) -> tuple[list[ProposedFood], str, str]:
        stored = [ProposedFood.model_validate(i) for i in payload["items"]]
        edits = {e.index: e for e in request.items}
        if any(i >= len(stored) for i in edits):
            raise ProposalInvalid(["An edit refers to an item that isn't in the proposal."])
        inputs: list[tuple[ProposedFood, ProposalItemInput, str]] = []
        for idx, item in enumerate(stored):
            edit = edits.get(idx)
            if edit and edit.remove:
                continue
            quantity, unit, source = item.quantity, item.unit, item.quantity_source
            if edit and (edit.quantity is not None or edit.unit is not None):
                quantity = edit.quantity if edit.quantity is not None else quantity
                unit = edit.unit if edit.unit is not None else unit
                source = "manual"
            if quantity is None:                                    # fall back to the grams that were proposed
                quantity, unit = item.grams, "g"
            inputs.append((item, ProposalItemInput(
                food_name=item.food_name, quantity=quantity, unit=unit, selected_food_id=item.food_id,
                quantity_source="manual" if source == "manual" else ("user_stated" if source == "user_stated" else "model_estimate"),
            ), source))
        if not inputs:
            raise ProposalInvalid(["Nothing left to log: every item was removed."])
        grounded = await asyncio.gather(*(grounding.ground_item(self._db, user, inp) for _, inp, _ in inputs))
        fresh: list[ProposedFood] = []
        problems: list[str] = []
        for (item, _, source), g in zip(inputs, grounded):
            p = to_proposed(g, item.requested_name, source)
            if p is None or g.match.decision != "user_selected":
                problems.append(f"{item.food_name}: can't be logged as proposed ({', '.join(g.warnings) or 'not available'}).")
            else:
                fresh.append(p)
        if problems:
            raise ProposalInvalid(problems)
        return fresh, request.meal_type or payload["meal_type"], payload["logged_date"]

    async def _insert_logs(self, user: AuthenticatedUser, items: list[ProposedFood], meal_type: str,
                           logged_date: str) -> list[SavedLog]:
        from app.db.supabase import DatabaseError, DatabaseUnavailable

        rows = [{
            "user_id": user.user_id, "logged_date": logged_date, "meal_type": meal_type, "food_name": i.food_name,
            "calories": i.nutrition.calories, "carbs_g": i.nutrition.carbs_g, "fat_g": i.nutrition.fat_g,
            "protein_g": i.nutrition.protein_g, "serving_g": i.grams, "is_quick_add": False,
            "source": "ai_assisted", "food_id": str(i.food_id),
            # The database replaces this with the catalogue's own snapshot for food_id (trigger).
            "nutrients_per_100g": {k: v for k, v in i.per_100g.items()
                                   if k in ("kcal", "carbs_g", "fat_g", "protein_g", "fiber_g", "sugars_g",
                                            "saturated_fat_g", "sodium_g")} or None,
        } for i in items]
        try:
            saved = await self._db.insert_many(user, "food_logs", rows,
                                               select="id,food_name,calories,protein_g,carbs_g,fat_g,serving_g,meal_type,logged_date")
        except (DatabaseError, DatabaseUnavailable) as exc:
            raise ProposalSaveFailed() from exc
        return [SavedLog.model_validate(r) for r in saved]
