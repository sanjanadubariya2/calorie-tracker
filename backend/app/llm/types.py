"""Provider-neutral request/response types for chat with tools."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Role = Literal["user", "assistant", "tool"]


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ToolResult:
    call_id: str
    name: str
    content: dict[str, Any]


@dataclass(frozen=True)
class ChatMessage:
    """One conversation item.

    * user / assistant text: `text`
    * assistant turn that requested tools: `tool_calls` (+ `provider_state`,
      the provider's own copy of that turn, replayed verbatim within a turn
      so provider-specific data such as Gemini thought signatures survives)
    * tool results: role "tool", `tool_results`
    """

    role: Role
    text: str | None = None
    tool_calls: tuple[ToolCall, ...] = ()
    tool_results: tuple[ToolResult, ...] = ()
    provider_state: Any = None
    provider_model: str | None = None

    @staticmethod
    def user(text: str) -> "ChatMessage":
        return ChatMessage(role="user", text=text)

    @staticmethod
    def assistant(text: str) -> "ChatMessage":
        return ChatMessage(role="assistant", text=text)


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]   # JSON Schema (object)


ToolMode = Literal["auto", "required", "none"]


@dataclass(frozen=True)
class LLMRequest:
    system: str
    messages: tuple[ChatMessage, ...]
    tools: tuple[ToolSpec, ...] = ()
    tool_mode: ToolMode = "auto"
    allowed_tools: tuple[str, ...] | None = None    # restrict which tools may be called this step
    response_schema: dict[str, Any] | None = None   # JSON mode (no tools): a JSON Schema object
    max_output_tokens: int = 2048
    # Use exactly this model (no fallback): a tool-calling turn stays on the
    # model that started it, because provider state is model-specific.
    pinned_model: str | None = None
    purpose: str = "chat"                            # for logs/usage only


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0
    cached_tokens: int = 0

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens + self.thinking_tokens

    def add(self, other: "Usage") -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.thinking_tokens += other.thinking_tokens
        self.cached_tokens += other.cached_tokens


FinishReason = Literal["stop", "tool_calls", "max_tokens", "refused", "other"]


@dataclass(frozen=True)
class LLMResponse:
    text: str | None
    tool_calls: tuple[ToolCall, ...]
    finish: FinishReason
    usage: Usage
    model: str
    provider: str
    provider_state: Any = None
    json: dict[str, Any] | None = None   # JSON mode: the parsed object
    latency_ms: int = 0
    estimated_cost_usd: float | None = None
    attempts: int = 1
    extra: dict[str, Any] = field(default_factory=dict)

    def as_message(self) -> ChatMessage:
        """The assistant turn to append before tool results."""
        return ChatMessage(role="assistant", text=self.text, tool_calls=self.tool_calls,
                           provider_state=self.provider_state, provider_model=self.model)
