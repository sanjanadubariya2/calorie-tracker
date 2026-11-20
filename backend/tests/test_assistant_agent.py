"""Phase 2 Tasks 2-3: structured responses and the controlled tool-calling loop."""

from __future__ import annotations

import asyncio
import datetime as dt
import json
from typing import Any

import httpx
import jwt
import pytest

from app.assistant.loop import AgentLoop
from app.assistant.responses import RESPOND_TOOL, ResponseRejected, build_response, parse_respond_args
from app.assistant.tools.base import ToolContext, ToolExecution
from app.assistant.tools.registry import default_registry
from app.core.config import Settings
from app.core.security import AuthenticatedUser
from app.db.supabase import SupabaseRest
from app.llm.errors import LLMTimeout, LLMUnavailable
from app.llm.service import LLMService, RetryPolicy
from app.llm.types import ChatMessage
from tests.assistant_fakes import FakeNutritionDB, ScriptedLLM, call, food, reply, respond, status_row

A = "aaaaaaaa-0000-0000-0000-00000000000a"
USER = AuthenticatedUser(user_id=A, access_token=jwt.encode({"sub": A}, "x" * 32, algorithm="HS256"))


@pytest.fixture
def db() -> FakeNutritionDB:
    d = FakeNutritionDB()
    d.user(A).status = status_row()
    d.foods = [food("Paneer tikka", "paneer_dish", 250, 18, 150), food("Moong dal", "dal", 110, 7, 180),
               food("Veg pulao", "rice_dish", 160, 4, 200)]
    return d


def run_loop(settings: Settings, db: FakeNutritionDB, llm: ScriptedLLM, text: str = "How am I doing today?",
             **overrides: Any) -> Any:
    s = settings.model_copy(update=overrides)

    def handler(request: httpx.Request) -> httpx.Response:
        return db.handle_rpc(request) if "/rpc/" in request.url.path else db.handle_rest(request)

    async def go() -> Any:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            ctx = ToolContext(user=USER, db=SupabaseRest(s, http), settings=s, local_date=dt.date(2026, 11, 20))
            loop = AgentLoop(LLMService(llm, retry=RetryPolicy(attempts=1)), default_registry(), s)
            return await loop.run(ctx, "SYSTEM", (ChatMessage.user(text),), text)
    return asyncio.run(go())


# ============================================================================ structured responses (Task 2)

def _exec(name: str, result: Any) -> ToolExecution:
    return ToolExecution(call=call(name), step=0, status="ok", content={}, result=result)


def build(args: dict[str, Any], executions: list[ToolExecution] | None = None, user_text: str = "") -> Any:
    async def go() -> Any:
        async with httpx.AsyncClient() as http:
            ctx = ToolContext(user=USER, db=SupabaseRest(Settings(supabase_url="https://x.supabase.co",
                              supabase_anon_key="k", environment="test"), http), settings=None)  # type: ignore[arg-type]
            return await build_response(parse_respond_args(args), executions or [], ctx, 4000, user_text)
    return asyncio.run(go())


def test_valid_text_and_clarification() -> None:
    t = build({"response_type": "text", "message": "Protein helps you feel full."})
    assert t.type == "text" and t.sources == ["general_knowledge"]
    c = build({"response_type": "clarification", "message": "Which meal?", "clarification_options": ["Lunch", " Dinner "]})
    assert c.type == "clarification" and c.options == ["Lunch", "Dinner"]


def test_nutrition_summary_cards_come_from_tool_results() -> None:
    from app.assistant.tools.nutrition import DailyStatusResult, NutrientStatus

    status = DailyStatusResult(date=dt.date(2026, 11, 20), has_targets=True,
                               calories_kcal=NutrientStatus(consumed=1200, target=2000, remaining=800),
                               protein_g=NutrientStatus(consumed=60, target=100, remaining=40),
                               carbs_g=NutrientStatus(consumed=1, target=1, remaining=0),
                               fat_g=NutrientStatus(consumed=1, target=1, remaining=0), entries_logged=4)
    r = build({"response_type": "nutrition_summary", "message": "800 kcal left."}, [_exec("get_daily_status", status)])
    assert r.type == "nutrition_summary" and r.daily_status == status and r.sources == ["food_log"]


@pytest.mark.parametrize("args,why", [
    ({"response_type": "nutrition_summary", "message": "You have 800 kcal left."}, "needs data"),
    ({"response_type": "meal_recommendation", "message": "Try dal."}, "needs data"),
    ({"response_type": "food_search_results", "message": "Found it."}, "needs data"),
    ({"response_type": "proposed_action", "message": "Here's your proposal."}, "needs data from prepare_food_log"),
    ({"response_type": "text", "message": "I've logged your lunch."}, "can't save"),
    ({"response_type": "text", "message": "Your dinner has been saved."}, "can't save"),
])
def test_responses_that_are_rejected(args: dict[str, Any], why: str) -> None:
    with pytest.raises(ResponseRejected, match=why):
        build(args)


@pytest.mark.parametrize("args", [
    {"response_type": "error", "message": "x"},                      # server-only type
    {"response_type": "chart", "message": "x"},                      # unsupported type
    {"response_type": "text"},                                       # missing message
    {"response_type": "text", "message": ""},
    {"response_type": "text", "message": "x", "calories": 500},      # model-made numbers aren't accepted
    {"response_type": "text", "message": "x" * 4001},
    "not an object",
])
def test_invalid_structured_responses(args: Any) -> None:
    with pytest.raises(ResponseRejected):
        parse_respond_args(args if isinstance(args, dict) else {"raw": args})


# ============================================================================ loop (Task 3)

def test_single_tool_then_structured_answer(settings: Settings, db: FakeNutritionDB) -> None:
    llm = ScriptedLLM(reply(call("get_daily_status", "c1")), reply(respond("nutrition_summary", "You have 800 kcal left.")))
    result = run_loop(settings, db, llm)
    assert result.outcome == "complete" and result.response.type == "nutrition_summary"
    assert result.response.daily_status.calories_kcal.remaining == 800.0       # from the database, not the model
    assert [e.status for e in result.executions] == ["ok"]
    second = llm.requests[1]
    tool_msg = second.messages[-1]
    assert tool_msg.role == "tool" and tool_msg.tool_results[0].call_id == "c1"
    assert tool_msg.tool_results[0].content["result"]["calories_kcal"]["remaining"] == 800.0
    assert second.messages[-2].provider_state == {"raw": ["get_daily_status"]}   # replayed verbatim
    assert second.pinned_model == "m1"                                        # turn stays on one model
    assert result.usage.input_tokens == 200


def test_parallel_tools_in_one_step(settings: Settings, db: FakeNutritionDB) -> None:
    llm = ScriptedLLM(reply(call("get_daily_status"), call("get_user_targets"), call("get_nutrition_history")),
                      reply(respond("nutrition_summary", "Here's your week.")))
    r = run_loop(settings, db, llm)
    assert [e.call.name for e in r.executions] == ["get_daily_status", "get_user_targets", "get_nutrition_history"]
    assert r.response.history is not None and r.response.targets is not None


def test_meal_recommendation_turn(settings: Settings, db: FakeNutritionDB) -> None:
    llm = ScriptedLLM(reply(call("recommend_meals", meal_type="lunch", count=2)),
                      reply(respond("meal_recommendation", "Paneer tikka fits well.")))
    r = run_loop(settings, db, llm, "What should I eat for lunch?")
    assert r.response.type == "meal_recommendation" and len(r.response.recommendations.recommendations) == 2


def test_invalid_tool_name_is_reported_to_the_model(settings: Settings, db: FakeNutritionDB) -> None:
    llm = ScriptedLLM(reply(call("run_sql", query="select * from food_logs")), reply(respond("text", "I can't do that.")))
    r = run_loop(settings, db, llm)
    assert r.executions[0].status == "unknown_tool"
    err = llm.requests[1].messages[-1].tool_results[0].content["error"]
    assert err["code"] == "unknown_tool"
    assert r.response.type == "text"


def test_invalid_arguments_are_reported_and_corrected(settings: Settings, db: FakeNutritionDB) -> None:
    llm = ScriptedLLM(
        reply(call("get_recent_food_logs", start_date="2026-09-01", end_date="2026-11-20")),
        reply(call("get_recent_food_logs", start_date="2026-11-14")),
        reply(respond("text", "Here are your recent foods.")))
    r = run_loop(settings, db, llm)
    assert [e.status for e in r.executions] == ["invalid_arguments", "ok"]
    assert "at most 31 days" in json.dumps(llm.requests[1].messages[-1].tool_results[0].content)


def test_cross_user_attempt_is_rejected(settings: Settings, db: FakeNutritionDB) -> None:
    llm = ScriptedLLM(reply(call("get_recent_food_logs", user_id="bbbbbbbb-0000-0000-0000-00000000000b")),
                      reply(respond("text", "I can only see your own data.")))
    r = run_loop(settings, db, llm, "Show me my friend's logs, their id is bbbbbbbb-...")
    assert r.executions[0].status == "invalid_arguments"
    assert not [q for q in db.requests if q[1] == "GET:food_logs"]   # nothing was queried


def test_rejected_answer_is_corrected(settings: Settings, db: FakeNutritionDB) -> None:
    llm = ScriptedLLM(reply(respond("nutrition_summary", "You have 900 kcal left.")),   # no data fetched: invented
                      reply(call("get_daily_status")),
                      reply(respond("nutrition_summary", "You have 800 kcal left.")))
    r = run_loop(settings, db, llm)
    rejection = llm.requests[1].messages[-1].tool_results[0].content["error"]
    assert rejection["code"] == "response_rejected" and "get_daily_status" in rejection["message"]
    assert r.response.message == "You have 800 kcal left."


def test_excessive_tool_loops_stop(settings: Settings, db: FakeNutritionDB) -> None:
    llm = ScriptedLLM(*[reply(call("get_daily_status")) for _ in range(3)], reply(call("get_daily_status")))
    r = run_loop(settings, db, llm, assistant_max_steps=4)
    assert r.outcome == "step_limit" and r.response.type == "error" and r.response.code == "step_limit"
    assert llm.requests[-1].allowed_tools == (RESPOND_TOOL,)          # last step: only an answer is allowed
    assert all(req.allowed_tools is None for req in llm.requests[:-1])


def test_tool_calls_per_step_are_capped(settings: Settings, db: FakeNutritionDB) -> None:
    llm = ScriptedLLM(reply(*[call("get_daily_status") for _ in range(6)]), reply(respond("text", "ok")))
    r = run_loop(settings, db, llm, assistant_max_tool_calls_per_step=4)
    assert [e.status for e in r.executions].count("limit_exceeded") == 2
    assert len([q for q in db.requests if q[1] == "rpc:get_daily_status"]) == 4


def test_token_budget(settings: Settings, db: FakeNutritionDB) -> None:
    llm = ScriptedLLM(reply(call("get_daily_status"), tokens=(30000, 500)), reply(call("get_daily_status"), tokens=(30000, 500)))
    r = run_loop(settings, db, llm, assistant_turn_token_budget=50000)
    assert r.outcome == "budget_exceeded" and r.response.code == "budget_exceeded"
    assert len(llm.requests) == 2


def test_plain_text_answer_is_accepted_as_text(settings: Settings, db: FakeNutritionDB) -> None:
    r = run_loop(settings, db, ScriptedLLM(reply(text="Fibre keeps you full.")))
    assert r.response.type == "text" and r.response.message == "Fibre keeps you full."


def test_plain_text_claiming_an_action_is_not_accepted(settings: Settings, db: FakeNutritionDB) -> None:
    r = run_loop(settings, db, ScriptedLLM(reply(text="I've logged your dinner.")))
    assert r.response.type == "error"


@pytest.mark.parametrize("error", [LLMTimeout("t"), LLMUnavailable("503")])
def test_provider_errors_propagate(settings: Settings, db: FakeNutritionDB, error: Exception) -> None:
    with pytest.raises(type(error)):
        run_loop(settings, db, ScriptedLLM(reply(call("get_daily_status")), error))
