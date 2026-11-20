"""Conversation storage (migration 011).

Reads go through PostgREST AS THE USER (RLS: own rows only). Writes go
through the `assistant_writer` Postgres role with the user id taken from the
verified token: clients can't insert or edit messages, so history fed back to
the model can't be forged. Every writer statement is scoped by user_id too.

The writer uses synchronous psycopg in a worker thread (as the catalogue
writer does), which avoids psycopg's async limitations on Windows event loops.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol

from pydantic import BaseModel

from app.core.security import AuthenticatedUser
from app.db.supabase import SupabaseRest


class Conversation(BaseModel):
    id: uuid.UUID
    title: str | None
    turn_status: str
    last_seq: int
    message_count: int
    summary: dict[str, Any] | None
    summary_through_seq: int
    summary_updated_at: dt.datetime | None
    input_tokens: int
    output_tokens: int
    created_at: dt.datetime
    updated_at: dt.datetime
    expires_at: dt.datetime


class StoredMessage(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    seq: int
    role: str
    content: str
    response: dict[str, Any] | None = None
    outcome: str | None = None
    client_message_id: uuid.UUID | None = None
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    thinking_tokens: int | None = None
    estimated_cost_usd: float | None = None
    correlation_id: str | None = None
    created_at: dt.datetime


@dataclass
class AssistantRecord:
    content: str
    response: dict[str, Any]
    outcome: str
    model: str | None
    input_tokens: int
    output_tokens: int
    thinking_tokens: int
    estimated_cost_usd: float | None
    correlation_id: str | None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)   # step, tool, arguments, status, result_chars, duration_ms


class ConversationStore(Protocol):
    async def create_conversation(self, user: AuthenticatedUser, title: str | None) -> Conversation: ...
    async def list_conversations(self, user: AuthenticatedUser, limit: int, before: dt.datetime | None) -> list[Conversation]: ...
    async def get_conversation(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> Conversation | None: ...
    async def delete_conversation(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> bool: ...
    async def list_messages(self, user: AuthenticatedUser, conversation_id: uuid.UUID, before_seq: int | None,
                            limit: int) -> list[StoredMessage]: ...
    async def other_summaries(self, user: AuthenticatedUser, exclude_id: uuid.UUID, limit: int) -> list[Conversation]: ...
    async def daily_tokens(self, user: AuthenticatedUser, day: dt.date) -> int: ...
    async def acquire_turn(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> bool: ...
    async def release_turn(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> None: ...
    async def find_by_client_id(self, user: AuthenticatedUser, conversation_id: uuid.UUID,
                                client_message_id: uuid.UUID) -> tuple[StoredMessage, StoredMessage | None] | None: ...
    async def add_user_message(self, user: AuthenticatedUser, conversation_id: uuid.UUID, content: str,
                               client_message_id: uuid.UUID, correlation_id: str | None) -> StoredMessage: ...
    async def add_assistant_message(self, user: AuthenticatedUser, conversation_id: uuid.UUID,
                                    record: AssistantRecord, usage_day: dt.date) -> StoredMessage: ...
    async def save_summary(self, user: AuthenticatedUser, conversation_id: uuid.UUID, summary: dict[str, Any],
                           through_seq: int) -> None: ...
    async def set_title(self, user: AuthenticatedUser, conversation_id: uuid.UUID, title: str) -> None: ...


class StoreNotConfigured(Exception):
    pass


_CONV_COLUMNS = ("id,title,turn_status,last_seq,message_count,summary,summary_through_seq,summary_updated_at,"
                 "input_tokens,output_tokens,created_at,updated_at,expires_at")
_MSG_COLUMNS = ("id,conversation_id,seq,role,content,response,outcome,client_message_id,model,input_tokens,"
                "output_tokens,thinking_tokens,estimated_cost_usd,correlation_id,created_at")


# ============================================================================ writer (assistant_writer role)

class AssistantWriter:
    def __init__(self, database_url: str, retention_days: int) -> None:
        self._url = database_url
        self._retention = retention_days

    def _connect(self) -> Any:
        import psycopg
        from psycopg.rows import dict_row

        return psycopg.connect(self._url, connect_timeout=10, row_factory=dict_row, prepare_threshold=None)

    async def run(self, fn: Any, *args: Any) -> Any:
        return await asyncio.to_thread(self._run_sync, fn, *args)

    def _run_sync(self, fn: Any, *args: Any) -> Any:
        with self._connect() as conn:
            with conn.transaction():
                return fn(conn, *args)

    # -- statements (run inside one transaction each)

    def create(self, conn: Any, user_id: str, title: str | None) -> dict[str, Any]:
        return conn.execute(
            f"insert into public.assistant_conversations (user_id, title, expires_at) "
            f"values (%s, %s, now() + make_interval(days => %s)) returning {_CONV_COLUMNS}",
            (user_id, title, self._retention)).fetchone()

    def acquire(self, conn: Any, user_id: str, conv_id: str) -> bool:
        row = conn.execute(
            "update public.assistant_conversations set turn_status = 'running', turn_started_at = now() "
            "where id = %s and user_id = %s "
            "and (turn_status = 'idle' or turn_started_at < now() - interval '2 minutes') returning id",
            (conv_id, user_id)).fetchone()
        return row is not None

    def release(self, conn: Any, user_id: str, conv_id: str) -> None:
        conn.execute("update public.assistant_conversations set turn_status = 'idle', turn_started_at = null "
                     "where id = %s and user_id = %s", (conv_id, user_id))

    def _next_seq(self, conn: Any, user_id: str, conv_id: str) -> int:
        row = conn.execute(
            "update public.assistant_conversations set last_seq = last_seq + 1, message_count = message_count + 1, "
            "updated_at = now(), expires_at = now() + make_interval(days => %s) "
            "where id = %s and user_id = %s returning last_seq",
            (self._retention, conv_id, user_id)).fetchone()
        if row is None:
            raise LookupError("conversation not found")
        return int(row["last_seq"])

    def add_user(self, conn: Any, user_id: str, conv_id: str, content: str, client_id: str, cid: str | None) -> dict[str, Any]:
        existing = conn.execute(
            f"select {_MSG_COLUMNS} from public.assistant_messages "
            "where conversation_id = %s and user_id = %s and client_message_id = %s",
            (conv_id, user_id, client_id)).fetchone()
        if existing:
            return existing
        seq = self._next_seq(conn, user_id, conv_id)
        return conn.execute(
            f"insert into public.assistant_messages (conversation_id, user_id, seq, role, content, client_message_id, "
            f"correlation_id) values (%s, %s, %s, 'user', %s, %s, %s) returning {_MSG_COLUMNS}",
            (conv_id, user_id, seq, content, client_id, cid)).fetchone()

    def find_by_client(self, conn: Any, user_id: str, conv_id: str, client_id: str) -> tuple[dict, dict | None] | None:
        msg = conn.execute(
            f"select {_MSG_COLUMNS} from public.assistant_messages "
            "where conversation_id = %s and user_id = %s and client_message_id = %s",
            (conv_id, user_id, client_id)).fetchone()
        if msg is None:
            return None
        reply = conn.execute(
            f"select {_MSG_COLUMNS} from public.assistant_messages "
            "where conversation_id = %s and user_id = %s and seq = %s and role = 'assistant'",
            (conv_id, user_id, msg["seq"] + 1)).fetchone()
        return msg, reply

    def add_assistant(self, conn: Any, user_id: str, conv_id: str, rec: AssistantRecord, day: dt.date) -> dict[str, Any]:
        from psycopg.types.json import Jsonb

        seq = self._next_seq(conn, user_id, conv_id)
        msg = conn.execute(
            f"insert into public.assistant_messages (conversation_id, user_id, seq, role, content, response, outcome, "
            f"model, input_tokens, output_tokens, thinking_tokens, estimated_cost_usd, correlation_id) "
            f"values (%s, %s, %s, 'assistant', %s, %s, %s, %s, %s, %s, %s, %s, %s) returning {_MSG_COLUMNS}",
            (conv_id, user_id, seq, rec.content, Jsonb(rec.response), rec.outcome, rec.model, rec.input_tokens,
             rec.output_tokens, rec.thinking_tokens, rec.estimated_cost_usd, rec.correlation_id)).fetchone()
        for tc in rec.tool_calls:
            conn.execute(
                "insert into public.assistant_tool_calls (message_id, user_id, step, tool, arguments, status, "
                "result_chars, duration_ms) values (%s, %s, %s, %s, %s, %s, %s, %s)",
                (msg["id"], user_id, tc["step"], tc["tool"][:64], Jsonb(tc["arguments"]), tc["status"],
                 tc["result_chars"], tc["duration_ms"]))
        output = rec.output_tokens + rec.thinking_tokens
        cost = rec.estimated_cost_usd or 0
        conn.execute(
            "update public.assistant_conversations set input_tokens = input_tokens + %s, "
            "output_tokens = output_tokens + %s, estimated_cost_usd = estimated_cost_usd + %s "
            "where id = %s and user_id = %s", (rec.input_tokens, output, cost, conv_id, user_id))
        conn.execute(
            "insert into public.assistant_usage_daily as u (user_id, usage_date, turns, input_tokens, output_tokens, "
            "estimated_cost_usd) values (%s, %s, 1, %s, %s, %s) on conflict (user_id, usage_date) do update set "
            "turns = u.turns + 1, input_tokens = u.input_tokens + excluded.input_tokens, "
            "output_tokens = u.output_tokens + excluded.output_tokens, "
            "estimated_cost_usd = u.estimated_cost_usd + excluded.estimated_cost_usd",
            (user_id, day, rec.input_tokens, output, cost))
        return msg

    def save_summary(self, conn: Any, user_id: str, conv_id: str, summary: dict, through: int) -> None:
        from psycopg.types.json import Jsonb

        conn.execute(
            "update public.assistant_conversations set summary = %s, summary_through_seq = %s, "
            "summary_updated_at = now() where id = %s and user_id = %s",
            (Jsonb(summary), through, conv_id, user_id))

    def set_title(self, conn: Any, user_id: str, conv_id: str, title: str) -> None:
        conn.execute("update public.assistant_conversations set title = %s where id = %s and user_id = %s and title is null",
                     (title[:120], conv_id, user_id))

    def purge_expired(self, conn: Any) -> int:
        return conn.execute("delete from public.assistant_conversations where expires_at < now()").rowcount


# ============================================================================ store

class SupabaseConversationStore:
    def __init__(self, db: SupabaseRest, writer: AssistantWriter | None) -> None:
        self._db = db
        self._writer = writer

    def _w(self) -> AssistantWriter:
        if self._writer is None:
            raise StoreNotConfigured("ASSISTANT_DATABASE_URL is not set")
        return self._writer

    # -- reads, as the user (RLS)

    async def list_conversations(self, user: AuthenticatedUser, limit: int, before: dt.datetime | None) -> list[Conversation]:
        params = {"select": _CONV_COLUMNS, "order": "updated_at.desc,id.desc", "limit": str(limit)}
        if before is not None:
            params["updated_at"] = f"lt.{before.isoformat()}"
        return [Conversation.model_validate(r) for r in await self._db.select(user, "assistant_conversations", params)]

    async def get_conversation(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> Conversation | None:
        rows = await self._db.select(user, "assistant_conversations",
                                     {"select": _CONV_COLUMNS, "id": f"eq.{conversation_id}", "limit": "1"})
        return Conversation.model_validate(rows[0]) if rows else None

    async def delete_conversation(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> bool:
        return bool(await self._db.delete(user, "assistant_conversations", {"id": f"eq.{conversation_id}"}))

    async def list_messages(self, user: AuthenticatedUser, conversation_id: uuid.UUID, before_seq: int | None,
                            limit: int) -> list[StoredMessage]:
        params = {"select": _MSG_COLUMNS, "conversation_id": f"eq.{conversation_id}", "order": "seq.desc",
                  "limit": str(limit)}
        if before_seq is not None:
            params["seq"] = f"lt.{before_seq}"
        rows = await self._db.select(user, "assistant_messages", params)
        return [StoredMessage.model_validate(r) for r in reversed(rows)]

    async def other_summaries(self, user: AuthenticatedUser, exclude_id: uuid.UUID, limit: int) -> list[Conversation]:
        rows = await self._db.select(user, "assistant_conversations", {
            "select": _CONV_COLUMNS, "id": f"neq.{exclude_id}", "summary": "not.is.null",
            "order": "updated_at.desc", "limit": str(limit)})
        return [Conversation.model_validate(r) for r in rows]

    async def daily_tokens(self, user: AuthenticatedUser, day: dt.date) -> int:
        rows = await self._db.select(user, "assistant_usage_daily", {
            "select": "input_tokens,output_tokens", "usage_date": f"eq.{day.isoformat()}", "limit": "1"})
        return int(rows[0]["input_tokens"]) + int(rows[0]["output_tokens"]) if rows else 0

    # -- writes, as assistant_writer, scoped by the verified user id

    async def create_conversation(self, user: AuthenticatedUser, title: str | None) -> Conversation:
        w = self._w()
        return Conversation.model_validate(await w.run(w.create, user.user_id, title))

    async def acquire_turn(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> bool:
        w = self._w()
        return bool(await w.run(w.acquire, user.user_id, str(conversation_id)))

    async def release_turn(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> None:
        w = self._w()
        await w.run(w.release, user.user_id, str(conversation_id))

    async def find_by_client_id(self, user: AuthenticatedUser, conversation_id: uuid.UUID,
                                client_message_id: uuid.UUID) -> tuple[StoredMessage, StoredMessage | None] | None:
        w = self._w()
        found = await w.run(w.find_by_client, user.user_id, str(conversation_id), str(client_message_id))
        if found is None:
            return None
        msg, reply = found
        return StoredMessage.model_validate(msg), StoredMessage.model_validate(reply) if reply else None

    async def add_user_message(self, user: AuthenticatedUser, conversation_id: uuid.UUID, content: str,
                               client_message_id: uuid.UUID, correlation_id: str | None) -> StoredMessage:
        w = self._w()
        return StoredMessage.model_validate(await w.run(w.add_user, user.user_id, str(conversation_id), content,
                                                        str(client_message_id), correlation_id))

    async def add_assistant_message(self, user: AuthenticatedUser, conversation_id: uuid.UUID,
                                    record: AssistantRecord, usage_day: dt.date) -> StoredMessage:
        w = self._w()
        return StoredMessage.model_validate(await w.run(w.add_assistant, user.user_id, str(conversation_id),
                                                        record, usage_day))

    async def save_summary(self, user: AuthenticatedUser, conversation_id: uuid.UUID, summary: dict[str, Any],
                           through_seq: int) -> None:
        w = self._w()
        await w.run(w.save_summary, user.user_id, str(conversation_id), json.loads(json.dumps(summary)), through_seq)

    async def set_title(self, user: AuthenticatedUser, conversation_id: uuid.UUID, title: str) -> None:
        w = self._w()
        await w.run(w.set_title, user.user_id, str(conversation_id), title)
