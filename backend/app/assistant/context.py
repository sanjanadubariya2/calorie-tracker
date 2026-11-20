"""Context assembly for one assistant turn.

Sent to the model each turn, in this order:
1. System instructions (static).
2. <user_context>: the user's local date, their stated dietary preferences,
   this conversation's rolling summary, and short summaries of their other
   recent conversations, all marked as data.
3. Recent messages of this conversation (only those newer than the summary,
   so nothing is repeated), newest first until the token budget or message
   limit is reached.
4. The new user message.

Nutrition status is NOT pre-loaded: the model calls get_daily_status when a
question needs it, so numbers always come from a tool result. Full food-log
history is never sent; tools fetch bounded ranges on demand.

Token counts are estimated (about 4 characters per token); the provider's
reported usage is what gets recorded and budgeted.
"""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass

from app.assistant.preferences import PreferencesOut
from app.assistant.prompts import ASSISTANT_SYSTEM
from app.assistant.store import Conversation, StoredMessage
from app.assistant.tools.base import clean_text
from app.llm.types import ChatMessage

MAX_HISTORY_MESSAGE_CHARS = 2000
MAX_SUMMARY_CHARS = 1500
MAX_OTHER_SUMMARY_CHARS = 400


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / 4)


@dataclass(frozen=True)
class BuiltContext:
    system: str
    messages: tuple[ChatMessage, ...]
    history_included: int
    history_omitted: int
    estimated_tokens: int


def _summary_text(summary: dict | None, max_chars: int) -> str | None:
    if not summary:
        return None
    parts = [clean_text(str(summary.get("summary", "")), max_chars) or ""]
    facts = [clean_text(str(f), 200) for f in summary.get("key_facts", [])][:8]
    questions = [clean_text(str(q), 200) for q in summary.get("open_questions", [])][:4]
    if facts:
        parts.append("Facts the user stated: " + "; ".join(f for f in facts if f))
    if questions:
        parts.append("Open questions: " + "; ".join(q for q in questions if q))
    text = "\n".join(p for p in parts if p)
    return text[:max_chars] or None


def _preferences_text(prefs: PreferencesOut | None) -> str:
    if prefs is None:
        return "Dietary preferences: none entered."
    fields = []
    if prefs.diet:
        fields.append(f"diet: {prefs.diet}")
    if prefs.allergies:
        fields.append("allergies: " + ", ".join(prefs.allergies))
    if prefs.dislikes:
        fields.append("dislikes: " + ", ".join(clean_text(d, 40) or "" for d in prefs.dislikes))
    if prefs.cuisines:
        fields.append("cuisines: " + ", ".join(clean_text(c, 40) or "" for c in prefs.cuisines))
    if prefs.meal_preferences:
        fields.append("meal preferences: " + "; ".join(clean_text(m, 80) or "" for m in prefs.meal_preferences))
    if prefs.notes:
        fields.append("notes: " + (clean_text(prefs.notes, 300) or ""))
    return "Dietary preferences (entered by the user): " + ("; ".join(fields) if fields else "none set") + "."


def _history_text(m: StoredMessage) -> str:
    text = m.content
    if m.role == "assistant" and m.response and m.response.get("type") == "proposed_action":
        text += "\n[A food-log proposal was shown; the user decides in the app whether to save it.]"
    return text[:MAX_HISTORY_MESSAGE_CHARS]


def build_context(
    *,
    conversation: Conversation,
    history: list[StoredMessage],        # this conversation, ascending, excluding the new message
    new_message: str,
    preferences: PreferencesOut | None,
    other_conversations: list[Conversation],
    local_date: dt.date | None,
    token_budget: int,
    max_history_messages: int,
) -> BuiltContext:
    today = local_date or dt.datetime.now(dt.timezone.utc).date()
    lines = [
        f"Today (the user's {'local' if local_date else 'UTC'} date): {today.isoformat()} ({today.strftime('%A')}).",
        _preferences_text(preferences),
    ]
    summary = _summary_text(conversation.summary, MAX_SUMMARY_CHARS)
    if summary:
        lines.append("Earlier in this conversation (summary):\n" + summary)
    others = []
    for c in other_conversations[:2]:
        s = _summary_text(c.summary, MAX_OTHER_SUMMARY_CHARS)
        if s:
            others.append(f"- {clean_text(c.title, 80) or 'Untitled'}: {s}")
    if others:
        lines.append("The user's other recent conversations (summaries):\n" + "\n".join(others))
    system = f"{ASSISTANT_SYSTEM}\n<user_context>\n" + "\n".join(lines) + "\n</user_context>"

    used = estimate_tokens(system) + estimate_tokens(new_message)
    budget_left = max(0, token_budget - used)
    candidates = [m for m in history if m.seq > conversation.summary_through_seq]
    picked: list[StoredMessage] = []
    for m in reversed(candidates):                 # newest first
        if len(picked) >= max_history_messages:
            break
        cost = estimate_tokens(_history_text(m))
        if cost > budget_left:
            break
        picked.append(m)
        budget_left -= cost
    picked.reverse()
    while picked and picked[0].role != "user":      # a conversation must start with the user
        picked.pop(0)

    messages = [ChatMessage.user(_history_text(m)) if m.role == "user" else ChatMessage.assistant(_history_text(m))
                for m in picked]
    messages.append(ChatMessage.user(new_message))
    total = estimate_tokens(system) + sum(estimate_tokens(m.text or "") for m in messages)
    return BuiltContext(system=system, messages=tuple(messages), history_included=len(picked),
                        history_omitted=len(candidates) - len(picked), estimated_tokens=total)
