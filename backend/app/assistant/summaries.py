"""Conversation summaries (Part D).

Older messages are folded into a rolling summary {summary, key_facts,
open_questions} once enough of them fall outside the recent window, so the
context stays small without losing what matters. The latest
`assistant_history_max_messages` messages always stay verbatim. A summary can
be regenerated from scratch. Summaries are stored on the user's own
conversation row (same ownership and deletion as the messages).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, ValidationError, field_validator

from app.assistant.prompts import SUMMARY_SCHEMA, SUMMARY_SYSTEM
from app.assistant.store import StoredMessage
from app.assistant.tools.base import clean_text
from app.llm.errors import LLMInvalidOutput
from app.llm.service import LLMService
from app.llm.types import ChatMessage, LLMRequest

MAX_TRANSCRIPT_CHARS = 24000
MAX_MESSAGE_CHARS = 1200


class ConversationSummary(BaseModel):
    summary: str = Field(max_length=1200)
    key_facts: list[str] = Field(default_factory=list, max_length=8)
    open_questions: list[str] = Field(default_factory=list, max_length=4)

    @field_validator("summary")
    @classmethod
    def _s(cls, v: str) -> str:
        v = clean_text(v, 1200) or ""
        if not v:
            raise ValueError("empty summary")
        return v

    @field_validator("key_facts", "open_questions", mode="before")
    @classmethod
    def _items(cls, v: Any, info: Any) -> Any:
        if isinstance(v, list):
            cap = 8 if info.field_name == "key_facts" else 4
            return [clean_text(str(x), 200) for x in v if str(x).strip()][:cap]
        return v


def _transcript(messages: list[StoredMessage]) -> str:
    lines = [f"{'User' if m.role == 'user' else 'Assistant'}: {m.content[:MAX_MESSAGE_CHARS]}" for m in messages]
    text = "\n".join(lines)
    return text[-MAX_TRANSCRIPT_CHARS:]      # the latest part if very long


async def summarize(llm: LLMService, model: str, previous: dict[str, Any] | None,
                    messages: list[StoredMessage], max_output_tokens: int = 1024) -> ConversationSummary:
    prior = ""
    if previous:
        prior = ("<previous_summary>\n" + str(previous.get("summary", ""))
                 + "\nKey facts: " + "; ".join(map(str, previous.get("key_facts", [])))
                 + "\nOpen questions: " + "; ".join(map(str, previous.get("open_questions", [])))
                 + "\n</previous_summary>\n")
    prompt = (prior + "<conversation>\n" + _transcript(messages) + "\n</conversation>\n"
              "Update the summary to cover everything above.")
    response = await llm.generate(LLMRequest(
        system=SUMMARY_SYSTEM, messages=(ChatMessage.user(prompt),), response_schema=SUMMARY_SCHEMA,
        max_output_tokens=max_output_tokens, pinned_model=model, purpose="summary",
    ))
    try:
        return ConversationSummary.model_validate(response.json or {})
    except ValidationError as exc:
        raise LLMInvalidOutput("summary did not match the schema") from exc
