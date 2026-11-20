"""Structured assistant responses.

The model ends every turn by calling `respond` with a response type and its
message. The server validates that call and BUILDS the response: data cards
(nutrition summaries, recommendations, search results, proposals) come from
this turn's tool results or from deterministic backend code, never from
model-written JSON or numbers.
"""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

from app.assistant.tools.base import ToolContext, ToolExecution, to_tool_schema
from app.assistant.tools.catalogue import SearchFoodsResult
from app.assistant.tools.nutrition import DailyStatusResult, HistoryResult, UserTargetsResult
from app.assistant.tools.recommend import RecommendResult
from app.llm.types import ToolSpec
from app.assistant.proposals import FoodLogProposal
from app.assistant.tools.proposals import ItemIssue

RESPOND_TOOL = "respond"
ModelResponseType = Literal[
    "text", "nutrition_summary", "meal_recommendation", "food_search_results", "proposed_action", "clarification",
]

# Which successful tools can back which response type.
REQUIRES: dict[str, tuple[str, ...]] = {
    "nutrition_summary": ("get_daily_status", "get_nutrition_history", "get_user_targets"),
    "meal_recommendation": ("recommend_meals",),
    "food_search_results": ("search_foods",),
    "proposed_action": ("prepare_food_log",),
}

# Wording that claims a change was made. The assistant can only propose.
_COMPLETED_CLAIM = re.compile(
    r"\b(i('ve| have)? (logged|added|saved|recorded|updated|deleted|removed)|"
    r"(has|have) been (logged|added|saved|recorded|updated|deleted)|"
    r"(logged|added|saved) (it|this|that|them) (to|in) your)\b",
    re.IGNORECASE,
)


# ============================================================================ what the model sends

class RespondArgs(BaseModel):
    """Arguments of the `respond` tool."""

    model_config = ConfigDict(extra="forbid")
    response_type: ModelResponseType = Field(description=(
        "text: general answer. nutrition_summary: about the user's own intake/targets/trends (needs data from "
        "get_daily_status, get_nutrition_history or get_user_targets this turn). meal_recommendation: needs "
        "recommend_meals. food_search_results: needs search_foods. proposed_action: a food-log proposal made by "
        "prepare_food_log this turn; the user confirms it in the app. clarification: ask the user a question."))
    message: str = Field(min_length=1, max_length=4000, description="What the user reads. Plain text.")
    clarification_options: list[str] = Field(default_factory=list, max_length=4,
                                             description="Optional short answer choices for a clarification.")

    @field_validator("clarification_options")
    @classmethod
    def _options(cls, v: list[str]) -> list[str]:
        out = [" ".join(o.split())[:80] for o in v if o and o.strip()]
        return out


def respond_spec() -> ToolSpec:
    return ToolSpec(
        name=RESPOND_TOOL,
        description=("Send the final reply to the user. Always end your turn by calling this exactly once. "
                     "Use data tools first when the answer depends on the user's data or the catalogue."),
        parameters=to_tool_schema(RespondArgs),
    )


# ============================================================================ what the client receives

class _Base(BaseModel):
    message: str
    # Where the facts in this response came from: "food_log", "catalogue", "general_knowledge".
    sources: list[str] = Field(default_factory=list)


class TextResponse(_Base):
    type: Literal["text"] = "text"


class NutritionSummaryResponse(_Base):
    type: Literal["nutrition_summary"] = "nutrition_summary"
    daily_status: DailyStatusResult | None = None
    history: HistoryResult | None = None
    targets: UserTargetsResult | None = None


class MealRecommendationResponse(_Base):
    type: Literal["meal_recommendation"] = "meal_recommendation"
    recommendations: RecommendResult


class FoodSearchResultsResponse(_Base):
    type: Literal["food_search_results"] = "food_search_results"
    search: SearchFoodsResult


class ProposedAction(BaseModel):
    kind: Literal["log_food"] = "log_food"
    requires_user_confirmation: Literal[True] = True
    # Confirm with POST /v1/assistant/proposals/{proposal.id}/confirm (the app, never the model).
    proposal: FoodLogProposal


class ProposedActionResponse(_Base):
    type: Literal["proposed_action"] = "proposed_action"
    action: ProposedAction


class ClarificationResponse(_Base):
    type: Literal["clarification"] = "clarification"
    options: list[str] = Field(default_factory=list)
    # When a food-log proposal couldn't be made: what's unclear, with catalogue options.
    food_issues: list[ItemIssue] = Field(default_factory=list)


class ErrorResponse(_Base):
    type: Literal["error"] = "error"
    code: str
    retryable: bool


AssistantResponse = Annotated[
    Union[TextResponse, NutritionSummaryResponse, MealRecommendationResponse, FoodSearchResultsResponse,
          ProposedActionResponse, ClarificationResponse, ErrorResponse],
    Field(discriminator="type"),
]
RESPONSE_ADAPTER: TypeAdapter[Any] = TypeAdapter(AssistantResponse)


def parse_stored_response(value: dict[str, Any] | None) -> Any:
    return RESPONSE_ADAPTER.validate_python(value) if value else None


# ============================================================================ building

class ResponseRejected(Exception):
    """The model's `respond` call can't be accepted; the message tells it why."""


def _latest(executions: list[ToolExecution], tool: str) -> Any:
    for ex in reversed(executions):
        if ex.call.name == tool and ex.status == "ok" and ex.result is not None:
            return ex.result
    return None


def _sources(executions: list[ToolExecution]) -> list[str]:
    used = {ex.call.name for ex in executions if ex.status == "ok"}
    out = []
    if used & {"get_daily_status", "get_nutrition_history", "get_recent_food_logs", "get_user_targets"}:
        out.append("food_log")
    if used & {"search_foods", "recommend_meals", "prepare_food_log"}:
        out.append("catalogue")
    return out


def parse_respond_args(arguments: dict[str, Any]) -> RespondArgs:
    try:
        return RespondArgs.model_validate(arguments)
    except ValidationError as exc:
        problems = "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'arguments'}: {e['msg']}"
                             for e in exc.errors(include_input=False, include_url=False)[:6])
        raise ResponseRejected(f"Invalid respond arguments ({problems}).") from None


async def build_response(args: RespondArgs, executions: list[ToolExecution], ctx: ToolContext,
                         max_chars: int, user_text: str = "") -> Any:
    message = args.message.strip()
    if not message:
        raise ResponseRejected("The message is empty.")
    if len(message) > max_chars:
        raise ResponseRejected(f"The message is too long; keep it under {max_chars} characters.")
    if _COMPLETED_CLAIM.search(message):
        raise ResponseRejected(
            "You can't save, log or change anything. Rephrase without claiming an action was completed; "
            "offer it as a proposal the user can confirm in the app.")

    kind = args.response_type
    for tool in REQUIRES.get(kind, ()):
        if _latest(executions, tool) is not None:
            break
    else:
        if kind in REQUIRES:
            needed = " or ".join(REQUIRES[kind])
            raise ResponseRejected(f"A {kind} response needs data from {needed} in this turn. Call it first, "
                                   "or answer with response_type 'text'.")
    prepared = _latest(executions, "prepare_food_log")
    if kind == "proposed_action" and (prepared is None or prepared.status != "proposed"):
        raise ResponseRejected("No proposal was created this turn (prepare_food_log returned questions). "
                               "Ask them with response_type 'clarification'.")

    sources = _sources(executions) or ["general_knowledge"]
    if kind == "text":
        return TextResponse(message=message, sources=sources)
    if kind == "clarification":
        issues = prepared.issues if prepared is not None and prepared.status == "needs_clarification" else []
        return ClarificationResponse(message=message, options=args.clarification_options, sources=sources,
                                     food_issues=issues)
    if kind == "nutrition_summary":
        return NutritionSummaryResponse(
            message=message, sources=sources, daily_status=_latest(executions, "get_daily_status"),
            history=_latest(executions, "get_nutrition_history"), targets=_latest(executions, "get_user_targets"))
    if kind == "meal_recommendation":
        return MealRecommendationResponse(message=message, sources=sources,
                                          recommendations=_latest(executions, "recommend_meals"))
    if kind == "food_search_results":
        return FoodSearchResultsResponse(message=message, sources=sources, search=_latest(executions, "search_foods"))
    # proposed_action: the stored proposal, priced by the backend; nothing is saved until the user confirms.
    return ProposedActionResponse(message=message, sources=sources, action=ProposedAction(proposal=prepared.proposal))
