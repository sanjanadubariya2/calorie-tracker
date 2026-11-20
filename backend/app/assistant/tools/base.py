"""Tool registry and controlled execution.

Rules every tool follows:
* Identity comes from ToolContext (the verified token), never from arguments.
  Argument models forbid unknown fields, so a `user_id` is rejected outright.
* Arguments are validated by Pydantic (types, enums, bounds), then by the
  handler for context-dependent limits (date ranges relative to today), which
  raises ToolArgumentError.
* Tools are read-only and run as the user through PostgREST (RLS applies).
  None accepts SQL, column names, table names or function names.
* Results are size-capped; every execution is recorded (arguments only).
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ValidationError

from app.core.config import Settings
from app.core.security import AuthenticatedUser
from app.db.supabase import DatabaseError, DatabaseUnavailable, SupabaseRest
from app.llm.types import ToolCall, ToolSpec

logger = logging.getLogger(__name__)

ToolStatus = Literal["ok", "invalid_arguments", "error", "timeout", "unknown_tool", "limit_exceeded"]

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean_text(value: str | None, max_len: int = 120) -> str | None:
    """User- or catalogue-supplied strings going to the model: no control
    characters, bounded length. They are data, never instructions."""
    if value is None:
        return None
    value = _CONTROL.sub(" ", value).strip()
    return value[:max_len]


class ToolArgumentError(Exception):
    """Arguments are well-typed but not allowed (e.g. a date range too long)."""


@dataclass
class ToolContext:
    user: AuthenticatedUser
    db: SupabaseRest
    settings: Settings
    local_date: dt.date | None = None           # the user's date, if the app sent it
    services: dict[str, Any] = field(default_factory=dict)   # shared caches (catalogue pool), proposal service
    conversation_id: Any = None                  # the conversation this turn belongs to
    user_text: str = ""                          # the user's message (to check stated quantities)
    turn_state: dict[str, Any] = field(default_factory=dict)  # per turn only (e.g. food ids seen in results)

    @property
    def today(self) -> dt.date:
        return self.local_date or dt.datetime.now(dt.timezone.utc).date()


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    args: type[BaseModel]
    result: type[BaseModel]
    run: Callable[[ToolContext, Any], Awaitable[BaseModel]]
    # Response types this tool's result can back (see assistant/responses.py).
    supports: tuple[str, ...] = ()
    # Permission class. "read": reads the user's data or the catalogue.
    # "proposal": prepares a pending proposal for the user to confirm in the app.
    # There is no write class: confirmations are HTTP-only paths outside the registry.
    kind: Literal["read", "proposal"] = "read"

    def spec(self) -> ToolSpec:
        return ToolSpec(name=self.name, description=self.description, parameters=to_tool_schema(self.args))


@dataclass
class ToolExecution:
    call: ToolCall
    step: int
    status: ToolStatus
    content: dict[str, Any]                 # what the model sees
    result: BaseModel | None = None         # the validated result (for response cards)
    duration_ms: int = 0
    result_chars: int = 0

    def record_arguments(self) -> dict[str, Any]:
        text = json.dumps(self.call.arguments, default=str)
        return self.call.arguments if len(text) <= 2000 else {"truncated": text[:2000]}


# ---------------------------------------------------------------------------- JSON Schema for providers

def to_tool_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Pydantic schema -> a self-contained JSON Schema the provider accepts:
    $refs inlined, Optional as type unions, no titles/defaults."""
    schema = model.model_json_schema()
    defs = schema.pop("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                return walk(defs[node["$ref"].rsplit("/", 1)[-1]])
            node = {k: walk(v) for k, v in node.items() if k not in ("title", "default")}
            any_of = node.get("anyOf")
            if isinstance(any_of, list) and len(any_of) == 2 and {"type": "null"} in any_of:
                other = next(x for x in any_of if x != {"type": "null"})
                if isinstance(other.get("type"), str) and "anyOf" not in other:
                    merged = {**other, "type": [other["type"], "null"]}
                    if "enum" in merged:
                        merged["enum"] = [*merged["enum"], None]
                    rest = {k: v for k, v in node.items() if k != "anyOf"}
                    return {**rest, **merged}
            return node
        if isinstance(node, list):
            return [walk(x) for x in node]
        return node

    out = walk(schema)
    out.setdefault("properties", {})
    out["additionalProperties"] = False
    return out


# ---------------------------------------------------------------------------- registry

class ToolRegistry:
    def __init__(self, tools: list[Tool]) -> None:
        names = [t.name for t in tools]
        if len(set(names)) != len(names):
            raise ValueError("duplicate tool names")
        self._tools = {t.name: t for t in tools}

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(self._tools)

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def specs(self) -> tuple[ToolSpec, ...]:
        return tuple(t.spec() for t in self._tools.values())

    def names_of_kind(self, kind: str) -> tuple[str, ...]:
        return tuple(n for n, t in self._tools.items() if t.kind == kind)

    async def execute(self, ctx: ToolContext, call: ToolCall, step: int) -> ToolExecution:
        started = time.monotonic()

        def done(status: ToolStatus, content: dict[str, Any], result: BaseModel | None = None) -> ToolExecution:
            text = json.dumps(content, default=str)
            return ToolExecution(call=call, step=step, status=status, content=content, result=result,
                                 duration_ms=int((time.monotonic() - started) * 1000), result_chars=len(text))

        tool = self._tools.get(call.name)
        if tool is None:
            return done("unknown_tool", {"error": {
                "code": "unknown_tool",
                "message": f"There is no tool named {clean_text(call.name, 64)!r}. Available tools: {', '.join(self.names)}.",
            }})
        try:
            args = tool.args.model_validate(call.arguments)
        except ValidationError as exc:
            # Field locations and messages only: never echo the input values back.
            details = [{"field": ".".join(str(p) for p in e["loc"]) or "(arguments)", "problem": e["msg"]}
                       for e in exc.errors(include_input=False, include_url=False)][:8]
            return done("invalid_arguments", {"error": {"code": "invalid_arguments", "details": details}})

        try:
            result = await asyncio.wait_for(tool.run(ctx, args), timeout=ctx.settings.assistant_tool_timeout_seconds)
        except ToolArgumentError as exc:
            return done("invalid_arguments", {"error": {"code": "invalid_arguments", "message": str(exc)}})
        except (asyncio.TimeoutError, TimeoutError):
            logger.warning("Tool %s timed out", tool.name)
            return done("timeout", {"error": {"code": "timeout", "message": "The tool took too long. Try a narrower request."}})
        except (DatabaseError, DatabaseUnavailable) as exc:
            logger.warning("Tool %s database failure: %s", tool.name, type(exc).__name__)
            return done("error", {"error": {"code": "tool_failed", "message": "The data couldn't be loaded right now."}})
        except Exception as exc:  # a bug in a tool must not break the turn or leak details
            logger.exception("Tool %s failed: %s", tool.name, type(exc).__name__)
            return done("error", {"error": {"code": "tool_failed", "message": "The tool failed."}})

        content = {"result": result.model_dump(mode="json")}
        if len(json.dumps(content, default=str)) > ctx.settings.assistant_max_tool_result_chars:
            logger.warning("Tool %s result exceeded the size limit", tool.name)
            return done("limit_exceeded", {"error": {
                "code": "result_too_large", "message": "Too much data. Ask for a shorter period or fewer results."}})
        return done("ok", content, result)
