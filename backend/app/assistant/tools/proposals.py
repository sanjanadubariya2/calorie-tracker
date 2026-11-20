"""prepare_food_log: the only proposal-generation tool.

Turns "log two boiled eggs for breakfast" into a PENDING proposal:
  interpret items -> match each against the catalogue -> resolve quantity/units
  -> price with food_portion (deterministic) -> store a proposal with an id and
  an expiry. It never logs food; the user confirms in the app.

If anything is uncertain it creates nothing and says what to ask:
  * ambiguous or unknown food (with up to 3 catalogue options),
  * missing quantity (the default serving is offered, not assumed),
  * a quantity/unit that can't be converted, or no usable nutrition.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.assistant.proposals import FoodLogProposal, MealType, ProposalService, ProposedFood, Unit, to_proposed
from app.assistant.tools.base import Tool, ToolArgumentError, ToolContext, clean_text
from app.schemas.recognition import ProposalItem, ProposalItemInput
from app.services import grounding
from app.services.recognition.pipeline import _quantity_in_text

MAX_PAST_DAYS = 7


class FoodRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    food_name: str = Field(min_length=1, max_length=120, description="The food as the user named it.")
    food_id: uuid.UUID | None = Field(default=None, description=(
        "Only a food_id returned by search_foods or prepare_food_log options in THIS turn, when the user's choice "
        "is clear. Omit to let the catalogue matcher decide."))
    quantity: float | None = Field(default=None, gt=0, le=10000, description="Only what the user said. Omit if not stated.")
    unit: Unit | None = Field(default=None, description="piece, bowl, katori, g, ml, ... Omit if not stated.")

    @field_validator("food_name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("food_name is empty")
        return v


class PrepareFoodLogArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[FoodRequest] = Field(min_length=1, max_length=10)
    meal_type: MealType = Field(description="Ask the user if they didn't say which meal.")
    date: dt.date | None = Field(default=None, description="YYYY-MM-DD. Omit for today.")


class FoodOptionOut(BaseModel):
    food_id: uuid.UUID
    name: str
    kcal_per_100: float
    default_serving: str | None


class ItemIssue(BaseModel):
    requested_name: str
    issue: Literal["ambiguous_food", "unknown_food", "quantity_missing", "portion_unresolved", "nutrition_unavailable"]
    question: str
    options: list[FoodOptionOut] = Field(default_factory=list)


class PrepareFoodLogResult(BaseModel):
    status: Literal["proposed", "needs_clarification"]
    proposal: FoodLogProposal | None = None
    issues: list[ItemIssue] = Field(default_factory=list)
    note: str


def _options(item: ProposalItem) -> list[FoodOptionOut]:
    return [FoodOptionOut(food_id=o.food_id, name=clean_text(o.name) or "", kcal_per_100=o.per_100.kcal,
                          default_serving=f"{o.default_serving.label} ({o.default_serving.grams:g} g)"
                          if o.default_serving else None)
            for o in item.match.options[:3]]


def _issue(req: FoodRequest, item: ProposalItem) -> ItemIssue | None:
    name = req.food_name
    if item.match.decision == "ambiguous":
        return ItemIssue(requested_name=name, issue="ambiguous_food", options=_options(item),
                         question=f"Which '{name}' did you have?")
    if item.match.decision == "no_match" or item.match.selected is None:
        return ItemIssue(requested_name=name, issue="unknown_food", options=_options(item),
                         question=f"I couldn't find '{name}' in the food database. Can you describe it differently?")
    if req.quantity is None:
        serving = item.match.selected.default_serving
        hint = f" One standard serving is {serving.label} ({serving.grams:g} g)." if serving else ""
        return ItemIssue(requested_name=name, issue="quantity_missing",
                         question=f"How much {item.match.selected.name} did you have?{hint}")
    if item.portion.grams is None:
        return ItemIssue(requested_name=name, issue="portion_unresolved",
                         question=f"How much {item.match.selected.name} was that in grams or pieces?")
    if item.nutrition is None:
        return ItemIssue(requested_name=name, issue="nutrition_unavailable", options=_options(item),
                         question=f"{item.match.selected.name} has no usable nutrition data. Choose a similar food?")
    return None


async def run_prepare_food_log(ctx: ToolContext, args: PrepareFoodLogArgs) -> PrepareFoodLogResult:
    service: ProposalService | None = ctx.services.get("proposal_service")
    if service is None or ctx.conversation_id is None:
        raise ToolArgumentError("Food logging proposals aren't available right now.")
    day = args.date or ctx.today
    if day > ctx.today + dt.timedelta(days=1) or day < ctx.today - dt.timedelta(days=MAX_PAST_DAYS):
        raise ToolArgumentError(f"date must be today or within the last {MAX_PAST_DAYS} days.")
    seen = ctx.turn_state.setdefault("seen_food_ids", set())
    for req in args.items:
        if req.food_id is not None and str(req.food_id) not in seen:
            raise ToolArgumentError("food_id must come from search_foods results in this turn. "
                                    "Search first, or omit food_id.")

    def stated(q: float | None) -> str:
        return "user_stated" if q is not None and _quantity_in_text(q, ctx.user_text) else "model_estimate"

    inputs = [ProposalItemInput(food_name=r.food_name, quantity=r.quantity, unit=r.unit,
                                quantity_source=stated(r.quantity) if r.quantity is not None else "unspecified",
                                selected_food_id=r.food_id) for r in args.items]
    grounded = await asyncio.gather(*(grounding.ground_item(ctx.db, ctx.user, i) for i in inputs))

    issues: list[ItemIssue] = []
    ready: list[ProposedFood] = []
    for req, inp, item in zip(args.items, inputs, grounded):
        seen.update(str(o.food_id) for o in item.match.options)
        problem = _issue(req, item)
        if problem:
            issues.append(problem)
            continue
        proposed = to_proposed(item, req.food_name, inp.quantity_source)
        if proposed is None:
            issues.append(ItemIssue(requested_name=req.food_name, issue="nutrition_unavailable",
                                    question=f"I can't price {req.food_name} right now."))
        else:
            ready.append(proposed)
    if issues:
        return PrepareFoodLogResult(status="needs_clarification", issues=issues,
                                    note="Nothing was proposed. Ask the user the questions, then call again.")
    proposal = await service.create(ctx.user, ctx.conversation_id, args.meal_type, day, ready)
    return PrepareFoodLogResult(status="proposed", proposal=proposal,
                                note="A proposal was created. The user must confirm it in the app; it is NOT logged.")


PREPARE_FOOD_LOG = Tool(
    name="prepare_food_log",
    description=("Prepare a food-log PROPOSAL when the user asks to log food. Matches each food in the catalogue, "
                 "resolves the portion and computes nutrition. Returns either a pending proposal (the user confirms "
                 "or cancels it in the app) or questions to ask when a food is ambiguous or a quantity is missing. "
                 "It never saves anything, and nothing you say can confirm it."),
    args=PrepareFoodLogArgs, result=PrepareFoodLogResult, run=run_prepare_food_log,
    supports=("proposed_action", "clarification"), kind="proposal",
)
