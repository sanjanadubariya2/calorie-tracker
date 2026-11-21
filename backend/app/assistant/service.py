"""AssistantService: one user message in, one validated assistant message out.

Order of a turn:
  conversation exists (RLS) -> idempotent retry? -> per-minute limit ->
  daily token budget -> lock the conversation -> save the user message ->
  build context -> run the tool loop (overall timeout) -> save the assistant
  message, tool records and usage -> unlock -> (later) summarise if long.

Provider failures (timeout, overload, quota) are raised to the route, which
returns a safe error; the user message stays saved, and retrying with the
same client_message_id continues without duplicating it.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import uuid
from typing import Any

from app.assistant.context import build_context
from app.assistant.loop import AgentLoop, TurnResult
from app.assistant.preferences import get_preferences
from app.assistant.proposals import ProposalService
from app.assistant.responses import ErrorResponse
from app.assistant.store import AssistantRecord, Conversation, ConversationStore, StoredMessage
from app.assistant.summaries import summarize
from app.assistant.tools.base import ToolContext, ToolRegistry
from app.core.config import Settings
from app.core.request_context import correlation_id
from app.core.security import AuthenticatedUser
from app.db.supabase import SupabaseRest
from app.llm.errors import LLMError, LLMRefused, LLMTimeout
from app.llm.service import LLMService
from app.services.catalogue.importer import _SlidingWindow

logger = logging.getLogger(__name__)


class ConversationNotFound(Exception):
    pass


class TurnInProgress(Exception):
    pass


class RateLimited(Exception):
    def __init__(self, message: str, retry_after: int) -> None:
        super().__init__(message)
        self.message = message
        self.retry_after = retry_after


class NothingToSummarize(Exception):
    pass


def _utc_today() -> dt.date:
    return dt.datetime.now(dt.timezone.utc).date()


class AssistantService:
    def __init__(self, store: ConversationStore, llm: LLMService, registry: ToolRegistry, settings: Settings,
                 db: SupabaseRest, proposals: ProposalService, recommendations: Any = None) -> None:
        self.store = store
        self.proposals = proposals
        self.llm = llm
        self.registry = registry
        self.settings = settings
        self._db = db
        self._loop = AgentLoop(llm, registry, settings)
        self._limiter = _SlidingWindow(settings.assistant_turns_per_user_per_minute, 60)
        # Shared with tools: the proposal service and the app's recommendation repository
        # (so the assistant and the app use the same candidate cache and logic).
        self._services: dict[str, Any] = {"proposal_service": proposals}
        if recommendations is not None:
            self._services["recommendations"] = recommendations

    # ------------------------------------------------------------------ turn

    async def send_message(self, user: AuthenticatedUser, conversation_id: uuid.UUID, content: str,
                           client_message_id: uuid.UUID, local_date: dt.date | None
                           ) -> tuple[Conversation, StoredMessage, StoredMessage]:
        conv = await self.store.get_conversation(user, conversation_id)
        if conv is None:
            raise ConversationNotFound()

        previous = await self.store.find_by_client_id(user, conversation_id, client_message_id)
        if previous is not None and previous[1] is not None:
            return conv, previous[0], previous[1]           # a retry of a completed turn: same answer

        if not self._limiter.hit(user.user_id):
            raise RateLimited("You're sending messages too quickly. Wait a moment.", 60)
        if await self.store.daily_tokens(user, _utc_today()) >= self.settings.assistant_daily_token_budget:
            raise RateLimited("You've reached today's assistant limit. It resets at midnight UTC.", 3600)

        if not await self.store.acquire_turn(user, conversation_id):
            raise TurnInProgress()
        try:
            user_msg = previous[0] if previous else await self.store.add_user_message(
                user, conversation_id, content, client_message_id, correlation_id())
            result = await self._run(user, conv, user_msg, local_date)
            reply = await self.store.add_assistant_message(user, conversation_id, self._record(result), _utc_today())
            if conv.title is None:
                await self.store.set_title(user, conversation_id, _title(user_msg.content))
        finally:
            await self.store.release_turn(user, conversation_id)
        logger.info("Assistant turn %s: steps=%d tools=%s tokens=%d cid=%s", result.outcome, result.steps,
                    ",".join(f"{e.call.name}:{e.status}" for e in result.executions) or "-",
                    result.usage.total, correlation_id())
        conv = await self.store.get_conversation(user, conversation_id) or conv
        return conv, user_msg, reply

    async def _run(self, user: AuthenticatedUser, conv: Conversation, user_msg: StoredMessage,
                   local_date: dt.date | None) -> TurnResult:
        s = self.settings
        history = [m for m in await self.store.list_messages(user, conv.id, user_msg.seq, s.assistant_history_max_messages * 2)]
        prefs = await get_preferences(self._db, user)
        others = await self.store.other_summaries(user, conv.id, 2)
        built = build_context(
            conversation=conv, history=history, new_message=user_msg.content, preferences=prefs,
            other_conversations=others, local_date=local_date, token_budget=s.assistant_context_token_budget,
            max_history_messages=s.assistant_history_max_messages,
        )
        ctx = ToolContext(user=user, db=self._db, settings=s, local_date=local_date, services=self._services,
                          conversation_id=conv.id, user_text=user_msg.content)
        try:
            return await asyncio.wait_for(self._loop.run(ctx, built.system, built.messages, user_msg.content),
                                          timeout=s.assistant_turn_timeout_seconds)
        except (asyncio.TimeoutError, TimeoutError) as exc:
            raise LLMTimeout("assistant turn timed out") from exc
        except LLMRefused:
            return TurnResult(response=ErrorResponse(
                message="I can't help with that request. I can answer questions about your nutrition and food.",
                code="refused", retryable=False), outcome="refused")

    def _record(self, result: TurnResult) -> AssistantRecord:
        r = result.response
        return AssistantRecord(
            content=r.message, response=r.model_dump(mode="json"), outcome=result.outcome, model=result.model,
            input_tokens=result.usage.input_tokens, output_tokens=result.usage.output_tokens,
            thinking_tokens=result.usage.thinking_tokens, estimated_cost_usd=result.estimated_cost_usd,
            correlation_id=correlation_id(),
            tool_calls=[{"step": e.step, "tool": e.call.name, "arguments": e.record_arguments(), "status": e.status,
                         "result_chars": e.result_chars, "duration_ms": e.duration_ms} for e in result.executions],
        )

    # ------------------------------------------------------------------ summaries

    def _summarizable(self, conv: Conversation) -> int:
        """Seq up to which messages may be summarised (the recent window stays verbatim)."""
        return max(0, conv.last_seq - self.settings.assistant_history_max_messages)

    async def maybe_summarize(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> bool:
        """After a turn: fold older messages into the summary once enough have piled up."""
        conv = await self.store.get_conversation(user, conversation_id)
        if conv is None:
            return False
        through = self._summarizable(conv)
        if through - conv.summary_through_seq < self.settings.assistant_summary_trigger_messages:
            return False
        try:
            await self._summarize(user, conv, conv.summary, conv.summary_through_seq, through)
            return True
        except LLMError as exc:
            logger.warning("Summary failed (%s) cid=%s", type(exc).__name__, correlation_id())
            return False

    async def regenerate_summary(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> Conversation:
        conv = await self.store.get_conversation(user, conversation_id)
        if conv is None:
            raise ConversationNotFound()
        through = self._summarizable(conv)
        if through == 0:
            raise NothingToSummarize()
        await self._summarize(user, conv, None, 0, through)
        return await self.store.get_conversation(user, conversation_id) or conv

    async def _summarize(self, user: AuthenticatedUser, conv: Conversation, previous: dict | None,
                         after_seq: int, through: int) -> None:
        messages: list[StoredMessage] = []
        before = through + 1
        while True:                                     # page backwards through (after_seq, through]
            page = await self.store.list_messages(user, conv.id, before, 100)
            page = [m for m in page if m.seq > after_seq]
            if not page:
                break
            messages = page + messages
            before = page[0].seq
            if before <= after_seq + 1 or len(messages) >= 400:
                break
        if not messages:
            return
        summary = await summarize(self.llm, self.settings.assistant_summary_model, previous, messages)
        await self.store.save_summary(user, conv.id, summary.model_dump(), through)


def _title(first_message: str) -> str:
    text = " ".join(first_message.split())
    return text if len(text) <= 60 else text[:57].rstrip() + "..."
