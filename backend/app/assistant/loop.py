"""The controlled tool-calling loop for one assistant turn.

  for step in 1..max_steps:
      ask the model, with the registered tools + `respond`, a tool call REQUIRED
      (on the last step only `respond` is allowed)
      for each requested call:
          `respond`        -> validate and build the response; done if accepted,
                              otherwise tell the model why and continue
          a registered tool -> validate arguments, run as the user, cap result
          anything else     -> "unknown tool" error back to the model
      stop early if the turn's token budget is spent

The model never touches the database: tools run with the verified user from
ToolContext, and their arguments can't name a user, table or query.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from app.assistant.responses import (
    RESPOND_TOOL,
    ErrorResponse,
    ResponseRejected,
    RespondArgs,
    build_response,
    parse_respond_args,
    respond_spec,
)
from app.assistant.tools.base import ToolContext, ToolExecution, ToolRegistry, clean_text
from app.core.config import Settings
from app.core.request_context import correlation_id
from app.llm.service import LLMService
from app.llm.types import ChatMessage, LLMRequest, ToolResult, Usage

logger = logging.getLogger(__name__)


@dataclass
class TurnResult:
    response: Any                                  # an AssistantResponse model
    outcome: str                                   # complete | clarification | step_limit | budget_exceeded | refused
    usage: Usage = field(default_factory=Usage)
    estimated_cost_usd: float | None = None
    model: str | None = None
    executions: list[ToolExecution] = field(default_factory=list)
    steps: int = 0


class AgentLoop:
    def __init__(self, llm: LLMService, registry: ToolRegistry, settings: Settings) -> None:
        self._llm = llm
        self._registry = registry
        self._s = settings

    async def run(self, ctx: ToolContext, system: str, messages: tuple[ChatMessage, ...], user_text: str) -> TurnResult:
        s = self._s
        specs = (*self._registry.specs(), respond_spec())
        convo = list(messages)
        result = TurnResult(response=None, outcome="complete")
        cost: float | None = None
        pinned: str | None = None

        for step in range(s.assistant_max_steps):
            last_step = step == s.assistant_max_steps - 1
            response = await self._llm.generate(LLMRequest(
                system=system, messages=tuple(convo), tools=specs, tool_mode="required",
                allowed_tools=(RESPOND_TOOL,) if last_step else None,
                max_output_tokens=s.assistant_max_output_tokens, pinned_model=pinned, purpose="assistant",
            ))
            pinned = pinned or response.model       # the rest of the turn stays on this model
            result.model = response.model
            result.steps = step + 1
            result.usage.add(response.usage)
            if response.estimated_cost_usd is not None:
                cost = (cost or 0.0) + response.estimated_cost_usd
            result.estimated_cost_usd = cost

            if not response.tool_calls:
                # Despite "required", the model answered in plain text: accept it only as a text reply.
                text = clean_text(response.text, s.assistant_reply_max_chars) if response.text else None
                if text:
                    try:
                        result.response = await build_response(
                            RespondArgs(response_type="text", message=text), result.executions, ctx,
                            s.assistant_reply_max_chars, user_text)
                        return result
                    except ResponseRejected:
                        pass
                break

            convo.append(response.as_message())
            tool_results: list[ToolResult] = []
            respond_calls = [c for c in response.tool_calls if c.name == RESPOND_TOOL]
            data_calls = [c for c in response.tool_calls if c.name != RESPOND_TOOL]

            for i, call in enumerate(data_calls):
                if i >= s.assistant_max_tool_calls_per_step:
                    ex = ToolExecution(call=call, step=step, status="limit_exceeded", content={"error": {
                        "code": "too_many_calls",
                        "message": f"At most {s.assistant_max_tool_calls_per_step} tool calls per step."}})
                else:
                    ex = await self._registry.execute(ctx, call, step)
                result.executions.append(ex)
                tool_results.append(ToolResult(call_id=call.id, name=call.name, content=ex.content))

            accepted = None
            for call in respond_calls:
                if accepted is not None:
                    tool_results.append(ToolResult(call_id=call.id, name=call.name,
                                                   content={"error": {"message": "Only one respond call per turn."}}))
                    continue
                try:
                    accepted = await build_response(parse_respond_args(call.arguments), result.executions, ctx,
                                                    s.assistant_reply_max_chars, user_text)
                    tool_results.append(ToolResult(call_id=call.id, name=call.name, content={"result": "delivered"}))
                except ResponseRejected as exc:
                    logger.info("respond rejected at step %d cid=%s", step, correlation_id())
                    tool_results.append(ToolResult(call_id=call.id, name=call.name,
                                                   content={"error": {"code": "response_rejected", "message": str(exc)}}))
            if accepted is not None:
                result.response = accepted
                result.outcome = "clarification" if accepted.type == "clarification" else "complete"
                return result

            convo.append(ChatMessage(role="tool", tool_results=tuple(tool_results)))
            if result.usage.total > s.assistant_turn_token_budget:
                result.response = ErrorResponse(
                    message="That question needed more processing than allowed. Try asking something narrower.",
                    code="budget_exceeded", retryable=False)
                result.outcome = "budget_exceeded"
                return result

        result.response = ErrorResponse(
            message="I couldn't finish answering that. Please try rephrasing your question.",
            code="step_limit", retryable=True)
        result.outcome = "step_limit"
        return result
