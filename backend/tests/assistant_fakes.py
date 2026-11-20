"""Fakes for assistant tests: a scripted LLM, an in-memory conversation store
(ownership enforced like RLS) and a per-user fake of the database the tools read."""

from __future__ import annotations

import datetime as dt
import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import jwt

from app.assistant.store import AssistantRecord, Conversation, StoredMessage
from app.core.security import AuthenticatedUser
from app.llm.errors import LLMError
from app.llm.types import LLMRequest, LLMResponse, ToolCall, Usage


# ============================================================================ scripted LLM

def call(name: str, call_id: str | None = None, **arguments: Any) -> ToolCall:
    return ToolCall(id=call_id or f"call-{name}-{uuid.uuid4().hex[:6]}", name=name, arguments=arguments)


def respond(response_type: str = "text", message: str = "Done.", **extra: Any) -> ToolCall:
    return call("respond", response_type=response_type, message=message, **extra)


def reply(*calls: ToolCall, model: str = "m1", tokens: tuple[int, int] = (100, 20), text: str | None = None) -> LLMResponse:
    return LLMResponse(text=text, tool_calls=tuple(calls), finish="tool_calls" if calls else "stop",
                       usage=Usage(input_tokens=tokens[0], output_tokens=tokens[1]), model=model, provider="scripted",
                       provider_state={"raw": [c.name for c in calls]} if calls else None)


def json_reply(data: dict[str, Any], model: str = "m1") -> LLMResponse:
    return LLMResponse(text=json.dumps(data), tool_calls=(), finish="stop", usage=Usage(50, 30), model=model,
                       provider="scripted", json=data)


Step = LLMResponse | LLMError | Callable[[LLMRequest], LLMResponse]


class ScriptedLLM:
    """Returns scripted responses in order and records every request."""

    name = "scripted"

    def __init__(self, *script: Step) -> None:
        self.script = list(script)
        self.requests: list[LLMRequest] = []

    @property
    def models(self) -> tuple[str, ...]:
        return ("m1", "m2")

    def then(self, *script: Step) -> "ScriptedLLM":
        self.script.extend(script)
        return self

    async def generate(self, request: LLMRequest) -> LLMResponse:
        self.requests.append(request)
        if not self.script:
            raise AssertionError("ScriptedLLM: no scripted response left")
        step = self.script.pop(0)
        if isinstance(step, LLMError):
            raise step
        if callable(step) and not isinstance(step, LLMResponse):
            return step(request)
        return step

    async def aclose(self) -> None:
        return None


# ============================================================================ in-memory store

class InMemoryStore:
    """Same contract as SupabaseConversationStore; every method is scoped to the
    calling user exactly as RLS + the writer's user_id filters scope the real one."""

    def __init__(self) -> None:
        self.conversations: dict[uuid.UUID, dict[str, Any]] = {}
        self.messages: list[dict[str, Any]] = []
        self.tool_calls: list[dict[str, Any]] = []
        self.usage: dict[tuple[str, dt.date], int] = {}
        self.locks: set[uuid.UUID] = set()
        self._clock = dt.datetime(2026, 11, 20, 9, 0, tzinfo=dt.timezone.utc)

    def _tick(self) -> dt.datetime:
        self._clock += dt.timedelta(seconds=1)
        return self._clock

    def _own(self, user: AuthenticatedUser, cid: uuid.UUID) -> dict[str, Any] | None:
        c = self.conversations.get(cid)
        return c if c and c["user_id"] == user.user_id else None

    def _conv(self, c: dict[str, Any]) -> Conversation:
        return Conversation.model_validate({k: v for k, v in c.items() if k != "user_id"})

    async def create_conversation(self, user: AuthenticatedUser, title: str | None) -> Conversation:
        now = self._tick()
        cid = uuid.uuid4()
        self.conversations[cid] = dict(
            id=cid, user_id=user.user_id, title=title, turn_status="idle", last_seq=0, message_count=0, summary=None,
            summary_through_seq=0, summary_updated_at=None, input_tokens=0, output_tokens=0, created_at=now,
            updated_at=now, expires_at=now + dt.timedelta(days=90))
        return self._conv(self.conversations[cid])

    async def list_conversations(self, user: AuthenticatedUser, limit: int, before: dt.datetime | None) -> list[Conversation]:
        mine = [c for c in self.conversations.values() if c["user_id"] == user.user_id
                and (before is None or c["updated_at"] < before)]
        mine.sort(key=lambda c: (c["updated_at"], str(c["id"])), reverse=True)
        return [self._conv(c) for c in mine[:limit]]

    async def get_conversation(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> Conversation | None:
        c = self._own(user, conversation_id)
        return self._conv(c) if c else None

    async def delete_conversation(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> bool:
        if not self._own(user, conversation_id):
            return False
        del self.conversations[conversation_id]
        gone = {m["id"] for m in self.messages if m["conversation_id"] == conversation_id}
        self.messages = [m for m in self.messages if m["conversation_id"] != conversation_id]
        self.tool_calls = [t for t in self.tool_calls if t["message_id"] not in gone]
        return True

    def _msgs(self, user: AuthenticatedUser, cid: uuid.UUID) -> list[dict[str, Any]]:
        return sorted((m for m in self.messages if m["conversation_id"] == cid and m["user_id"] == user.user_id),
                      key=lambda m: m["seq"])

    async def list_messages(self, user: AuthenticatedUser, conversation_id: uuid.UUID, before_seq: int | None,
                            limit: int) -> list[StoredMessage]:
        rows = [m for m in self._msgs(user, conversation_id) if before_seq is None or m["seq"] < before_seq]
        return [StoredMessage.model_validate(m) for m in rows[-limit:]]

    async def other_summaries(self, user: AuthenticatedUser, exclude_id: uuid.UUID, limit: int) -> list[Conversation]:
        rows = [c for c in self.conversations.values() if c["user_id"] == user.user_id and c["id"] != exclude_id
                and c["summary"]]
        rows.sort(key=lambda c: c["updated_at"], reverse=True)
        return [self._conv(c) for c in rows[:limit]]

    async def daily_tokens(self, user: AuthenticatedUser, day: dt.date) -> int:
        return self.usage.get((user.user_id, day), 0)

    async def acquire_turn(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> bool:
        if not self._own(user, conversation_id) or conversation_id in self.locks:
            return False
        self.locks.add(conversation_id)
        return True

    async def release_turn(self, user: AuthenticatedUser, conversation_id: uuid.UUID) -> None:
        self.locks.discard(conversation_id)

    async def find_by_client_id(self, user: AuthenticatedUser, conversation_id: uuid.UUID,
                                client_message_id: uuid.UUID) -> tuple[StoredMessage, StoredMessage | None] | None:
        msgs = self._msgs(user, conversation_id)
        m = next((x for x in msgs if x["client_message_id"] == client_message_id), None)
        if m is None:
            return None
        r = next((x for x in msgs if x["seq"] == m["seq"] + 1 and x["role"] == "assistant"), None)
        return StoredMessage.model_validate(m), StoredMessage.model_validate(r) if r else None

    def _add(self, user: AuthenticatedUser, cid: uuid.UUID, **fields: Any) -> dict[str, Any]:
        c = self._own(user, cid)
        if c is None:
            raise LookupError("conversation not found")
        c["last_seq"] += 1
        c["message_count"] += 1
        c["updated_at"] = self._tick()
        row = dict(id=uuid.uuid4(), conversation_id=cid, user_id=user.user_id, seq=c["last_seq"], response=None,
                   outcome=None, client_message_id=None, model=None, input_tokens=None, output_tokens=None,
                   thinking_tokens=None, estimated_cost_usd=None, correlation_id=None, created_at=c["updated_at"])
        row.update(fields)
        self.messages.append(row)
        return row

    async def add_user_message(self, user: AuthenticatedUser, conversation_id: uuid.UUID, content: str,
                               client_message_id: uuid.UUID, correlation_id: str | None) -> StoredMessage:
        return StoredMessage.model_validate(self._add(user, conversation_id, role="user", content=content,
                                                      client_message_id=client_message_id, correlation_id=correlation_id))

    async def add_assistant_message(self, user: AuthenticatedUser, conversation_id: uuid.UUID,
                                    record: AssistantRecord, usage_day: dt.date) -> StoredMessage:
        row = self._add(user, conversation_id, role="assistant", content=record.content, response=record.response,
                        outcome=record.outcome, model=record.model, input_tokens=record.input_tokens,
                        output_tokens=record.output_tokens, thinking_tokens=record.thinking_tokens,
                        estimated_cost_usd=record.estimated_cost_usd, correlation_id=record.correlation_id)
        for tc in record.tool_calls:
            self.tool_calls.append({"message_id": row["id"], "user_id": user.user_id, **tc})
        c = self.conversations[conversation_id]
        c["input_tokens"] += record.input_tokens
        c["output_tokens"] += record.output_tokens + record.thinking_tokens
        key = (user.user_id, usage_day)
        self.usage[key] = self.usage.get(key, 0) + record.input_tokens + record.output_tokens + record.thinking_tokens
        return StoredMessage.model_validate(row)

    async def save_summary(self, user: AuthenticatedUser, conversation_id: uuid.UUID, summary: dict[str, Any],
                           through_seq: int) -> None:
        c = self._own(user, conversation_id)
        if c:
            c.update(summary=summary, summary_through_seq=through_seq, summary_updated_at=self._tick())

    async def set_title(self, user: AuthenticatedUser, conversation_id: uuid.UUID, title: str) -> None:
        c = self._own(user, conversation_id)
        if c and c["title"] is None:
            c["title"] = title


# ============================================================================ fake database for tools

def token_sub(request: httpx.Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        return None
    try:
        return jwt.decode(auth[7:], options={"verify_signature": False}).get("sub")
    except jwt.PyJWTError:
        return None


@dataclass
class UserData:
    status: dict[str, Any] | None = None
    totals: list[dict[str, Any]] = field(default_factory=list)
    logs: list[dict[str, Any]] = field(default_factory=list)
    profile: dict[str, Any] | None = None
    prefs: dict[str, Any] | None = None


def status_row(date: str = "2026-11-20", target: int | None = 2000, consumed: float = 1200,
               protein: tuple[float, int] = (60, 100), carbs: tuple[float, int] = (150, 250),
               fat: tuple[float, int] = (40, 60), entries: int = 4) -> dict[str, Any]:
    has = target is not None
    return {
        "status_date": date, "target_kcal": target, "target_carbs_g": carbs[1] if has else None,
        "target_fat_g": fat[1] if has else None, "target_protein_g": protein[1] if has else None,
        "macro_carb_pct": 50, "macro_fat_pct": 30, "macro_protein_pct": 20,
        "consumed_kcal": consumed, "consumed_carbs_g": carbs[0], "consumed_fat_g": fat[0],
        "consumed_protein_g": protein[0],
        "remaining_kcal": target - consumed if has else None,
        "remaining_carbs_g": carbs[1] - carbs[0] if has else None,
        "remaining_fat_g": fat[1] - fat[0] if has else None,
        "remaining_protein_g": protein[1] - protein[0] if has else None,
        "entry_count": entries,
    }


def food(name: str, category: str | None, kcal100: float, protein100: float, serving_g: float = 100,
         carbs100: float = 20, fat100: float = 5, label: str = "1 serving", food_id: str | None = None) -> dict[str, Any]:
    return {
        "id": food_id or str(uuid.uuid5(uuid.NAMESPACE_DNS, name)), "name": name, "category": category,
        "source": "indb", "source_ref": f"T{abs(hash(name)) % 1000:03d}", "basis": "g", "density_g_per_ml": None,
        "kcal_per_100": kcal100, "protein_g_per_100": protein100, "carbs_g_per_100": carbs100,
        "fat_g_per_100": fat100, "food_servings": [{"label": label, "grams": serving_g, "is_default": True}],
        "brand": None, "quality_flags": [], "is_matchable": True, "fiber_g_per_100": 2.0, "sugars_g_per_100": 1.0,
        "saturated_fat_g_per_100": 1.0, "sodium_g_per_100": 0.1,
    }


def search_row(f: dict[str, Any], score: float = 0.95, match_type: str = "alias") -> dict[str, Any]:
    """A search_food_catalogue row for a fake food."""
    serving = f["food_servings"][0]
    return {
        "food_id": f["id"], "name": f["name"], "brand": None, "category": f["category"], "food_kind": "generic_dish",
        "source": "indb", "source_ref": f["source_ref"], "verification": "curated", "completeness": 1.0,
        "quality_flags": [], "basis": "g", "density_g_per_ml": None, "kcal_per_100": f["kcal_per_100"],
        "protein_g_per_100": f["protein_g_per_100"], "carbs_g_per_100": f["carbs_g_per_100"],
        "fat_g_per_100": f["fat_g_per_100"], "fiber_g_per_100": 2.0, "sugars_g_per_100": 1.0,
        "saturated_fat_g_per_100": 1.0, "sodium_g_per_100": 0.1, "match_type": match_type,
        "matched_text": f["name"].lower(), "name_score": score, "score": score, "portion_grams": None,
        "portion_kcal": None, "portion_carbs_g": None, "portion_fat_g": None, "portion_protein_g": None,
        "default_serving_label": serving["label"], "default_serving_g": serving["grams"],
    }


class FakeNutritionDB:
    """PostgREST + RPC as each user: rows are returned only for the token's user."""

    def __init__(self) -> None:
        self.users: dict[str, UserData] = {}
        self.foods: list[dict[str, Any]] = []
        self.search_rows: list[dict[str, Any]] = []
        self.search_by_query: dict[str, list[dict[str, Any]]] = {}
        self.fail_food_log_insert = False
        self.requests: list[tuple[str | None, str, dict[str, str]]] = []

    def user(self, user_id: str) -> UserData:
        return self.users.setdefault(user_id, UserData())

    def handle_rpc(self, request: httpx.Request) -> httpx.Response:
        sub = token_sub(request)
        name = request.url.path.rsplit("/", 1)[-1]
        body = json.loads(request.content or b"{}")
        self.requests.append((sub, f"rpc:{name}", body))
        data = self.users.get(sub or "", UserData())
        if name == "get_daily_status":
            return httpx.Response(200, json=[data.status or status_row(target=None, consumed=0, entries=0)])
        if name == "get_daily_totals":
            return httpx.Response(200, json=[r for r in data.totals if body["p_start"] <= r["logged_date"] <= body["p_end"]])
        if name == "search_food_catalogue":
            return httpx.Response(200, json=self.search_by_query.get(body["p_query"].lower(), self.search_rows))
        if name == "food_portion":
            f = next((x for x in self.foods if x["id"] == body["p_food_id"]), None)
            if f is None:
                return httpx.Response(200, json=[])
            g = body["p_grams"]
            return httpx.Response(200, json=[{
                "food_id": f["id"],
                "nutrients_per_100g": {"kcal": f["kcal_per_100"], "protein_g": f["protein_g_per_100"],
                                       "carbs_g": f["carbs_g_per_100"], "fat_g": f["fat_g_per_100"]},
                "calories": round(f["kcal_per_100"] * g / 100), "protein_g": round(f["protein_g_per_100"] * g / 100, 1),
                "carbs_g": round(f["carbs_g_per_100"] * g / 100, 1), "fat_g": round(f["fat_g_per_100"] * g / 100, 1)}])
        return httpx.Response(404, json={"message": "no such function"})

    def handle_rest(self, request: httpx.Request) -> httpx.Response:
        sub = token_sub(request)
        table = request.url.path.rsplit("/", 1)[-1]
        params = dict(request.url.params)
        self.requests.append((sub, f"{request.method}:{table}", params))
        data = self.users.get(sub or "", UserData())
        if table == "food_logs" and request.method == "POST":
            if self.fail_food_log_insert:
                return httpx.Response(503, json={"message": "database unavailable"})
            new = json.loads(request.content)
            new = new if isinstance(new, list) else [new]
            if any(r.get("user_id") != sub for r in new):      # RLS with check
                return httpx.Response(403, json={"code": "42501", "message": "row-level security"})
            saved = [{**r, "id": str(uuid.uuid4())} for r in new]
            self.users.setdefault(sub or "", data).logs.extend(saved)
            return httpx.Response(201, json=saved)
        if table == "food_logs":
            rows = data.logs
            if "and" in params:
                lo, hi = params["and"].strip("()").split(",")
                rows = [r for r in rows if lo.split(".")[-1] <= r["logged_date"] <= hi.split(".")[-1]]
            if "meal_type" in params:
                rows = [r for r in rows if r["meal_type"] == params["meal_type"].removeprefix("eq.")]
            if "food_id" in params:
                rows = [r for r in rows if r.get("food_id")]
            rows = sorted(rows, key=lambda r: r["logged_date"], reverse=True)
            return httpx.Response(200, json=rows[: int(params.get("limit", "1000"))])
        if table == "profiles":
            return httpx.Response(200, json=[data.profile] if data.profile else [])
        if table == "user_dietary_preferences":
            if request.method == "GET":
                return httpx.Response(200, json=[data.prefs] if data.prefs else [])
            if request.method == "POST":
                row = json.loads(request.content)
                if row.get("user_id") != sub:      # RLS with check
                    return httpx.Response(403, json={"code": "42501", "message": "row-level security"})
                data.prefs = {**{k: v for k, v in row.items() if k != "user_id"}, "updated_at": "2026-11-20T09:00:00+00:00"}
                self.users[sub or ""] = data
                return httpx.Response(201, json=[data.prefs])
            if request.method == "DELETE":
                had = data.prefs is not None
                data.prefs = None
                return httpx.Response(200, json=[{}] if had else [])
        if table == "foods":
            if params.get("id", "").startswith("eq."):
                return httpx.Response(200, json=[f for f in self.foods if f["id"] == params["id"][3:]])
            return httpx.Response(200, json=self.foods)
        return httpx.Response(404, json={"message": "no such table"})


# ============================================================================ in-memory proposals

class InMemoryProposals:
    """Same contract as SupabaseProposalStore: owner-scoped reads, conditional transitions."""

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}

    async def create(self, user: AuthenticatedUser, conversation_id: uuid.UUID, payload: dict[str, Any],
                     ttl_minutes: int) -> dict[str, Any]:
        now = dt.datetime.now(dt.timezone.utc)
        row = {"id": uuid.uuid4(), "user_id": user.user_id, "conversation_id": conversation_id, "status": "pending",
               "payload": json.loads(json.dumps(payload)), "expires_at": now + dt.timedelta(minutes=ttl_minutes),
               "food_log_ids": [], "created_at": now}
        self.rows[str(row["id"])] = row
        return dict(row)

    async def get(self, user: AuthenticatedUser, proposal_id: uuid.UUID) -> dict[str, Any] | None:
        row = self.rows.get(str(proposal_id))
        return dict(row) if row and row["user_id"] == user.user_id else None

    async def statuses(self, user: AuthenticatedUser, ids: list[uuid.UUID]) -> dict[str, dict[str, Any]]:
        return {str(i): dict(self.rows[str(i)]) for i in ids
                if str(i) in self.rows and self.rows[str(i)]["user_id"] == user.user_id}

    async def transition(self, user: AuthenticatedUser, proposal_id: uuid.UUID, from_status: str, to_status: str,
                         food_log_ids: list[str] | None = None, require_unexpired: bool = False) -> dict[str, Any] | None:
        row = self.rows.get(str(proposal_id))
        if not row or row["user_id"] != user.user_id or row["status"] != from_status:
            return None
        if require_unexpired and row["expires_at"] <= dt.datetime.now(dt.timezone.utc):
            return None
        row["status"] = to_status
        if food_log_ids is not None:
            row["food_log_ids"] = food_log_ids
        return dict(row)
