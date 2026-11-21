"""Phase 2 Task 2: LLM service, Gemini adapter (SDK mocked), correlation ids, config."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from google.genai import errors as genai_errors
from google.genai import types as gt
from pydantic import SecretStr, ValidationError

from app.core.config import Environment, Settings
from app.llm.errors import (
    LLMInvalidOutput,
    LLMNotConfigured,
    LLMRateLimited,
    LLMRefused,
    LLMRequestRejected,
    LLMTimeout,
    LLMUnavailable,
)
from app.llm.factory import build_llm_provider, build_llm_service
from app.llm.gemini import GeminiLLM
from app.llm.provider import DisabledLLM
from app.llm.service import LLMService, ModelPrice, RetryPolicy, estimate_cost
from app.llm.types import ChatMessage, LLMRequest, ToolCall, ToolResult, ToolSpec, Usage
from app.main import create_app
from tests.assistant_fakes import ScriptedLLM, reply

FAST = RetryPolicy(attempts=2, base_delay_seconds=0.0)
REQ = LLMRequest(system="sys", messages=(ChatMessage.user("hi"),))


# ============================================================================ LLMService

def test_transient_failures_are_retried() -> None:
    llm = ScriptedLLM(LLMUnavailable("503"), reply())
    response = asyncio.run(LLMService(llm, retry=FAST).generate(REQ))
    assert response.attempts == 2 and len(llm.requests) == 2


def test_short_quota_waits_are_retried_once(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.llm.service as svc_mod

    waits: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        waits.append(seconds)

    monkeypatch.setattr(svc_mod.asyncio, "sleep", fake_sleep)
    llm = ScriptedLLM(LLMRateLimited(4), reply())
    assert asyncio.run(LLMService(llm, retry=FAST).generate(REQ)).attempts == 2
    assert waits == [4]
    llm = ScriptedLLM(LLMRateLimited(None), LLMRateLimited(None), reply())
    with pytest.raises(LLMRateLimited):
        asyncio.run(LLMService(llm, retry=FAST).generate(REQ))   # bounded: one retry
    long = ScriptedLLM(LLMRateLimited(60), reply())
    with pytest.raises(LLMRateLimited):
        asyncio.run(LLMService(long, retry=FAST).generate(REQ))  # long waits go back to the user
    assert len(long.requests) == 1


@pytest.mark.parametrize("error", [LLMRefused("x"), LLMRequestRejected("400"), LLMInvalidOutput("x")])
def test_non_transient_failures_are_not_retried(error: Exception) -> None:
    llm = ScriptedLLM(error, reply())
    with pytest.raises(type(error)):
        asyncio.run(LLMService(llm, retry=FAST).generate(REQ))
    assert len(llm.requests) == 1


def test_retries_are_bounded() -> None:
    llm = ScriptedLLM(LLMTimeout("t"), LLMTimeout("t"), reply())
    with pytest.raises(LLMTimeout):
        asyncio.run(LLMService(llm, retry=FAST).generate(REQ))
    assert len(llm.requests) == 2


def test_cost_tracking() -> None:
    price = ModelPrice(input_per_million=0.10, output_per_million=0.40)
    assert estimate_cost(Usage(input_tokens=1_000_000, output_tokens=500_000, thinking_tokens=500_000), price) == 0.5
    assert estimate_cost(Usage(10, 10), None) is None
    service = LLMService(ScriptedLLM(reply(tokens=(2000, 1000))), {"m1": price}, FAST)
    assert asyncio.run(service.generate(REQ)).estimated_cost_usd == round((2000 * 0.10 + 1000 * 0.40) / 1e6, 6)
    unknown = LLMService(ScriptedLLM(reply(model="other")), {"m1": price}, FAST)
    assert asyncio.run(unknown.generate(REQ)).estimated_cost_usd is None


def test_missing_configuration(settings: Settings) -> None:
    assert isinstance(build_llm_provider(settings), DisabledLLM)        # no GEMINI_API_KEY
    service = build_llm_service(settings)
    assert service.configured is False
    with pytest.raises(LLMNotConfigured):
        asyncio.run(service.generate(REQ))
    keyed = settings.model_copy(update={"gemini_api_key": SecretStr("k")})
    assert isinstance(build_llm_provider(keyed), GeminiLLM)
    off = keyed.model_copy(update={"assistant_provider": "disabled"})
    assert isinstance(build_llm_provider(off), DisabledLLM)


@pytest.mark.parametrize("value", ["not json", '{"m": 1}', '{"m": {"input": -1, "output": 1}}'])
def test_invalid_price_config_stops_startup(value: str) -> None:
    with pytest.raises(ValidationError):
        Settings(supabase_url="https://x.supabase.co", supabase_anon_key="k", environment="test", llm_prices_json=value)


def test_prices_are_parsed() -> None:
    s = Settings(supabase_url="https://x.supabase.co", supabase_anon_key="k", environment="test",
                 llm_prices_json='{"gemini-3.5-flash-lite": {"input": 0.1, "output": 0.4}}')
    assert s.llm_prices == {"gemini-3.5-flash-lite": (0.1, 0.4)}


# ============================================================================ Gemini adapter

def _content(*parts: gt.Part) -> gt.Content:
    return gt.Content(role="model", parts=list(parts))


def _gresp(*parts: gt.Part, finish: str = "STOP", block: str | None = None, usage: tuple[int, int, int] = (120, 30, 15)) -> gt.GenerateContentResponse:
    if block:
        return gt.GenerateContentResponse(candidates=[], prompt_feedback=gt.GenerateContentResponsePromptFeedback(block_reason=block))
    return gt.GenerateContentResponse(
        candidates=[gt.Candidate(content=_content(*parts), finish_reason=finish)],
        usage_metadata=gt.GenerateContentResponseUsageMetadata(prompt_token_count=usage[0], candidates_token_count=usage[1],
                                                               thoughts_token_count=usage[2]),
        model_version="gemini-3.5-flash-lite-001")


def _gemini(monkeypatch: pytest.MonkeyPatch, behaviour: dict[str, Any] | Any) -> tuple[GeminiLLM, list[dict[str, Any]]]:
    llm = GeminiLLM(api_key="k", model="gemini-3.5-flash-lite", fallback_models=("gemini-3.8-flash",),
                    thinking_level="low", timeout_seconds=5)
    calls: list[dict[str, Any]] = []

    async def generate_content(**kwargs: Any) -> Any:
        calls.append(kwargs)
        outcome = behaviour[kwargs["model"]] if isinstance(behaviour, dict) else behaviour
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(llm._client.aio.models, "generate_content", generate_content)
    return llm, calls


def _err(cls: type, code: int, retry_after: str | None = None) -> Exception:
    e = cls(code, {"error": {"code": code, "message": "provider detail", "status": "X"}})
    if retry_after:
        e.response = type("R", (), {"headers": {"retry-after": retry_after}})()
    return e


TOOL = ToolSpec(name="get_daily_status", description="d",
                parameters={"type": "object", "properties": {"date": {"type": ["string", "null"]}}, "additionalProperties": False})


def test_gemini_tool_request_and_function_call_parsing(monkeypatch: pytest.MonkeyPatch) -> None:
    fc = gt.Part(function_call=gt.FunctionCall(id="c1", name="get_daily_status", args={"date": None}))
    llm, calls = _gemini(monkeypatch, _gresp(gt.Part(text="thinking", thought=True), fc))
    resp = asyncio.run(llm.generate(LLMRequest(system="SYS", messages=(ChatMessage.user("left today?"),), tools=(TOOL,),
                                                tool_mode="required", allowed_tools=("get_daily_status",))))
    assert resp.tool_calls == (ToolCall(id="c1", name="get_daily_status", arguments={"date": None}),)
    assert resp.text is None                                     # thought text is never surfaced
    assert (resp.usage.input_tokens, resp.usage.output_tokens, resp.usage.thinking_tokens) == (120, 30, 15)
    assert resp.model == "gemini-3.5-flash-lite"                 # configured name, not the version string
    cfg = calls[0]["config"]
    assert cfg.system_instruction == "SYS"
    assert cfg.tools[0].function_declarations[0].parameters_json_schema == TOOL.parameters
    assert cfg.tool_config.function_calling_config.mode.name == "ANY"
    assert cfg.tool_config.function_calling_config.allowed_function_names == ["get_daily_status"]
    assert cfg.automatic_function_calling.disable is True
    assert cfg.thinking_config.thinking_level.name == "LOW"


def test_gemini_replays_its_own_turn_and_sends_tool_results(monkeypatch: pytest.MonkeyPatch) -> None:
    raw = _content(gt.Part(function_call=gt.FunctionCall(id="c1", name="get_daily_status", args={}),
                           thought_signature=b"sig"))
    llm, calls = _gemini(monkeypatch, _gresp(gt.Part(text="ok")))
    history = (
        ChatMessage.user("q"),
        ChatMessage(role="assistant", tool_calls=(ToolCall("c1", "get_daily_status", {}),), provider_state=raw,
                    provider_model="gemini-3.5-flash-lite"),
        ChatMessage(role="tool", tool_results=(ToolResult("c1", "get_daily_status", {"result": {"kcal": 1}}),)),
    )
    asyncio.run(llm.generate(LLMRequest(system="s", messages=history, pinned_model="gemini-3.5-flash-lite")))
    contents = calls[0]["contents"]
    assert contents[1] is raw                                     # verbatim: thought signature kept
    fr = contents[2].parts[0].function_response
    assert (fr.id, fr.name, fr.response) == ("c1", "get_daily_status", {"result": {"kcal": 1}})


def test_gemini_rebuilds_turns_from_another_model(monkeypatch: pytest.MonkeyPatch) -> None:
    llm, calls = _gemini(monkeypatch, _gresp(gt.Part(text="ok")))
    msg = ChatMessage(role="assistant", tool_calls=(ToolCall("c1", "x", {"a": 1}),), provider_state=object(),
                      provider_model="some-other-model")
    asyncio.run(llm.generate(LLMRequest(system="s", messages=(ChatMessage.user("q"), msg))))
    part = calls[0]["contents"][1].parts[0]
    assert part.function_call.name == "x" and part.function_call.args == {"a": 1}


def test_gemini_json_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    llm, calls = _gemini(monkeypatch, _gresp(gt.Part(text='{"summary": "s", "key_facts": [], "open_questions": []}')))
    schema = {"type": "object", "properties": {"summary": {"type": "string"}}}
    resp = asyncio.run(llm.generate(LLMRequest(system="s", messages=(ChatMessage.user("q"),), response_schema=schema)))
    assert resp.json == {"summary": "s", "key_facts": [], "open_questions": []}
    assert calls[0]["config"].response_mime_type == "application/json"
    assert calls[0]["config"].response_json_schema == schema


@pytest.mark.parametrize("response,expected", [
    (_gresp(gt.Part(text="not json")), LLMInvalidOutput),
    (_gresp(gt.Part(text="[1]")), LLMInvalidOutput),
    (_gresp(gt.Part(text='{"a": 1')), LLMInvalidOutput),
    (_gresp(gt.Part(text='{"a":'), finish="MAX_TOKENS"), LLMInvalidOutput),
    (_gresp(finish="SAFETY"), LLMRefused),
    (_gresp(block="PROHIBITED_CONTENT"), LLMRefused),
    (gt.GenerateContentResponse(candidates=[]), LLMRefused),
])
def test_gemini_malformed_output(monkeypatch: pytest.MonkeyPatch, response: Any, expected: type) -> None:
    llm, _ = _gemini(monkeypatch, response)
    with pytest.raises(expected):
        asyncio.run(llm.generate(LLMRequest(system="s", messages=(ChatMessage.user("q"),), response_schema={"type": "object"})))


def test_gemini_empty_reply_is_invalid(monkeypatch: pytest.MonkeyPatch) -> None:
    llm, _ = _gemini(monkeypatch, _gresp())
    with pytest.raises(LLMInvalidOutput):
        asyncio.run(llm.generate(REQ))


@pytest.mark.parametrize("error,expected", [
    (lambda: _err(genai_errors.ClientError, 429, "9"), LLMRateLimited),
    (lambda: _err(genai_errors.ClientError, 400), LLMRequestRejected),
    (lambda: _err(genai_errors.ClientError, 403), LLMRequestRejected),
    (lambda: _err(genai_errors.ServerError, 503), LLMUnavailable),
    (lambda: _err(genai_errors.ServerError, 504), LLMTimeout),
    (lambda: httpx.ReadTimeout("slow"), LLMTimeout),
    (lambda: httpx.ConnectError("down"), LLMUnavailable),
])
def test_gemini_errors(monkeypatch: pytest.MonkeyPatch, error: Any, expected: type) -> None:
    llm, calls = _gemini(monkeypatch, error())
    with pytest.raises(expected) as raised:
        asyncio.run(llm.generate(REQ))
    if expected is LLMRateLimited:
        assert raised.value.retry_after == 9
    # 5xx, timeouts and per-model quota (429) fall back to the next model; request errors don't.
    assert len(calls) == (2 if expected in (LLMUnavailable, LLMTimeout, LLMRateLimited) else 1)
    assert "provider detail" not in str(raised.value)


def test_gemini_falls_back_then_pins(monkeypatch: pytest.MonkeyPatch) -> None:
    llm, calls = _gemini(monkeypatch, {"gemini-3.5-flash-lite": _err(genai_errors.ServerError, 503),
                                       "gemini-3.8-flash": _gresp(gt.Part(text="hello"))})
    assert asyncio.run(llm.generate(REQ)).model == "gemini-3.8-flash"
    assert [c["model"] for c in calls] == ["gemini-3.5-flash-lite", "gemini-3.8-flash"]
    with pytest.raises(LLMUnavailable):
        asyncio.run(llm.generate(LLMRequest(system="s", messages=(ChatMessage.user("q"),), pinned_model="gemini-3.5-flash-lite")))
    assert calls[-1]["model"] == "gemini-3.5-flash-lite"


def test_gemini_timeout_is_ours(monkeypatch: pytest.MonkeyPatch) -> None:
    llm = GeminiLLM(api_key="k", model="a", fallback_models=(), thinking_level="low", timeout_seconds=0.01)

    async def hang(**_: Any) -> Any:
        await asyncio.sleep(10)

    monkeypatch.setattr(llm._client.aio.models, "generate_content", hang)
    import app.llm.gemini as g
    real = asyncio.wait_for
    monkeypatch.setattr(g.asyncio, "wait_for", lambda aw, timeout: real(aw, 0.05))
    with pytest.raises(LLMTimeout):
        asyncio.run(llm.generate(REQ))


# ============================================================================ correlation ids

def test_correlation_id_is_returned(client: TestClient) -> None:
    generated = client.get("/health")
    assert len(generated.headers["x-request-id"]) == 32
    echoed = client.get("/health", headers={"X-Request-ID": "app-req-12345678"})
    assert echoed.headers["x-request-id"] == "app-req-12345678"
    unsafe = client.get("/health", headers={"X-Request-ID": "bad id\r\nSet-Cookie: x"})
    assert unsafe.headers["x-request-id"] != "bad id" and len(unsafe.headers["x-request-id"]) == 32
    assert client.get("/nope").headers.get("x-request-id")        # errors carry it too


def test_api_key_never_reaches_responses_or_openapi(settings: Settings, fake_supabase: Any) -> None:
    keyed = settings.model_copy(update={"gemini_api_key": SecretStr("AIza-SECRET-KEY-123"), "environment": Environment.development})
    with TestClient(create_app(keyed, transport=httpx.MockTransport(fake_supabase.handle))) as c:
        assert "AIza-SECRET-KEY-123" not in c.get("/openapi.json").text
    assert "AIza-SECRET-KEY-123" not in repr(keyed) and "AIza-SECRET-KEY-123" not in json.dumps(keyed.model_dump(mode="json"))
