"""Google Gemini chat provider (google-genai SDK).

* Tools are sent as function declarations with a JSON Schema; the SDK's
  automatic function calling is disabled: the app's agent loop decides what runs.
* Within a turn, the model's own reply object is replayed verbatim
  (`provider_state`), which preserves Gemini's thought signatures.
* Fallback: if a model is overloaded (5xx), slow, or over its request quota
  (429; Gemini quotas are per model), the next model is tried, unless the
  request is pinned to one model (a tool turn already in progress).
* Each attempt is bounded by our own timeout, independent of the SDK's HTTP stack.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any

from app.llm.errors import (
    LLMError,
    LLMInvalidOutput,
    LLMRateLimited,
    LLMRefused,
    LLMRequestRejected,
    LLMTimeout,
    LLMUnavailable,
)
from app.llm.types import ChatMessage, LLMRequest, LLMResponse, ToolCall, Usage

logger = logging.getLogger(__name__)

_REFUSAL_FINISH = {
    "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
    "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION",
}
_MODES = {"auto": "AUTO", "required": "ANY", "none": "NONE"}


def _enum_name(value: Any) -> str | None:
    if value is None:
        return None
    return getattr(value, "name", None) or str(value).rsplit(".", 1)[-1]


def _retry_after(exc: Exception) -> int | None:
    headers = getattr(getattr(exc, "response", None), "headers", None)
    value = headers.get("retry-after") if headers is not None else None
    return int(value) if isinstance(value, str) and value.isdigit() else None


class GeminiLLM:
    name = "gemini"

    def __init__(self, api_key: str, model: str, fallback_models: tuple[str, ...], thinking_level: str,
                 timeout_seconds: float) -> None:
        from google import genai
        from google.genai import errors, types

        self._t = types
        self._errors = errors
        self._models = (model, *[m for m in fallback_models if m and m != model])
        self._thinking = thinking_level.upper()
        self._timeout = timeout_seconds
        self._client = genai.Client(
            api_key=api_key,
            http_options=types.HttpOptions(
                timeout=int(timeout_seconds * 1000),           # milliseconds
                retry_options=types.HttpRetryOptions(attempts=1),  # retries/fallback are ours
            ),
        )

    @property
    def models(self) -> tuple[str, ...]:
        return self._models

    async def aclose(self) -> None:
        close = getattr(self._client.aio, "aclose", None)
        if close is not None:
            await close()

    # ------------------------------------------------------------------ request translation

    def _contents(self, messages: tuple[ChatMessage, ...], model: str) -> list[Any]:
        t = self._t
        contents: list[Any] = []
        for m in messages:
            if m.role == "user":
                contents.append(t.Content(role="user", parts=[t.Part(text=m.text or "")]))
            elif m.role == "assistant":
                if m.provider_state is not None and m.provider_model == model:
                    contents.append(m.provider_state)   # verbatim: keeps thought signatures
                    continue
                parts = [t.Part(text=m.text)] if m.text else []
                parts += [t.Part(function_call=t.FunctionCall(id=c.id, name=c.name, args=c.arguments))
                          for c in m.tool_calls]
                contents.append(t.Content(role="model", parts=parts or [t.Part(text="")]))
            else:  # tool results
                contents.append(t.Content(role="user", parts=[
                    t.Part(function_response=t.FunctionResponse(id=r.call_id, name=r.name, response=r.content))
                    for r in m.tool_results
                ]))
        return contents

    def _config(self, request: LLMRequest) -> Any:
        t = self._t
        kwargs: dict[str, Any] = {
            "system_instruction": request.system,
            "max_output_tokens": request.max_output_tokens,
            "thinking_config": t.ThinkingConfig(thinking_level=self._thinking),
            "automatic_function_calling": t.AutomaticFunctionCallingConfig(disable=True),
        }
        if request.response_schema is not None:
            kwargs["response_mime_type"] = "application/json"
            kwargs["response_json_schema"] = request.response_schema
        if request.tools:
            kwargs["tools"] = [t.Tool(function_declarations=[
                t.FunctionDeclaration(name=s.name, description=s.description, parameters_json_schema=s.parameters)
                for s in request.tools
            ])]
            fcc: dict[str, Any] = {"mode": _MODES[request.tool_mode]}
            if request.allowed_tools is not None and request.tool_mode == "required":
                fcc["allowed_function_names"] = list(request.allowed_tools)
            kwargs["tool_config"] = t.ToolConfig(function_calling_config=t.FunctionCallingConfig(**fcc))
        return t.GenerateContentConfig(**kwargs)

    # ------------------------------------------------------------------ calls

    async def generate(self, request: LLMRequest) -> LLMResponse:
        models = (request.pinned_model,) if request.pinned_model else self._models
        last: LLMError | None = None
        for model in models:
            try:
                return await self._generate_with(model, request)
            except (LLMTimeout, LLMUnavailable, LLMRateLimited) as exc:
                last = exc
                if model != models[-1]:
                    logger.warning("LLM model %s failed (%s); trying fallback", model, type(exc).__name__)
        assert last is not None
        raise last

    async def _generate_with(self, model: str, request: LLMRequest) -> LLMResponse:
        errors = self._errors
        started = time.monotonic()
        try:
            response = await asyncio.wait_for(
                self._client.aio.models.generate_content(
                    model=model, contents=self._contents(request.messages, model), config=self._config(request)
                ),
                timeout=self._timeout + 2,
            )
        except (asyncio.TimeoutError, TimeoutError) as exc:
            raise LLMTimeout(f"{model} timed out") from exc
        except errors.APIError as exc:
            code = getattr(exc, "code", None)
            if code == 429:
                raise LLMRateLimited(_retry_after(exc)) from exc
            if code == 504:
                raise LLMTimeout(f"{model} deadline exceeded") from exc
            if isinstance(code, int) and code >= 500:
                raise LLMUnavailable(f"{model} HTTP {code}") from exc
            logger.error("LLM request rejected by provider (HTTP %s)", code)
            raise LLMRequestRejected(f"HTTP {code}") from exc
        except LLMError:
            raise
        except Exception as exc:  # transport errors from whichever HTTP library the SDK uses
            if "timeout" in type(exc).__name__.lower():
                raise LLMTimeout(f"{model} timed out") from exc
            raise LLMUnavailable(f"{model} unreachable: {type(exc).__name__}") from exc
        return self._parse(response, model, request, int((time.monotonic() - started) * 1000))

    def _parse(self, response: Any, model: str, request: LLMRequest, latency_ms: int) -> LLMResponse:
        feedback = getattr(response, "prompt_feedback", None)
        if feedback is not None and getattr(feedback, "block_reason", None):
            raise LLMRefused("prompt blocked")
        candidates = getattr(response, "candidates", None) or []
        if not candidates:
            raise LLMRefused("no candidates")
        candidate = candidates[0]
        finish_name = _enum_name(getattr(candidate, "finish_reason", None))
        if finish_name in _REFUSAL_FINISH:
            raise LLMRefused(f"finish {finish_name}")
        content = getattr(candidate, "content", None)
        parts = (getattr(content, "parts", None) or []) if content is not None else []

        calls = tuple(
            ToolCall(id=p.function_call.id or f"call_{uuid.uuid4().hex[:12]}", name=p.function_call.name or "",
                     arguments=dict(p.function_call.args or {}))
            for p in parts if getattr(p, "function_call", None) is not None
        )
        text = "".join(p.text for p in parts if getattr(p, "text", None) and not getattr(p, "thought", False)) or None

        usage_meta = getattr(response, "usage_metadata", None)
        usage = Usage(
            input_tokens=getattr(usage_meta, "prompt_token_count", None) or 0,
            output_tokens=getattr(usage_meta, "candidates_token_count", None) or 0,
            thinking_tokens=getattr(usage_meta, "thoughts_token_count", None) or 0,
            cached_tokens=getattr(usage_meta, "cached_content_token_count", None) or 0,
        )

        if finish_name == "MAX_TOKENS" and not calls:
            raise LLMInvalidOutput("output truncated (max tokens)")

        parsed: dict[str, Any] | None = None
        if request.response_schema is not None:
            if not text:
                raise LLMInvalidOutput("no JSON text in response")
            try:
                value = json.loads(text)
            except json.JSONDecodeError as exc:
                raise LLMInvalidOutput("response is not JSON") from exc
            if not isinstance(value, dict):
                raise LLMInvalidOutput("response JSON is not an object")
            parsed = value
        elif not calls and not text:
            raise LLMInvalidOutput("empty response")

        # Keep the model's own content object for verbatim replay within the turn.
        state = content if calls else None
        return LLMResponse(
            text=text, tool_calls=calls, finish="tool_calls" if calls else "stop", usage=usage,
            model=model, provider=self.name, provider_state=state, json=parsed, latency_ms=latency_ms,
            extra={"model_version": getattr(response, "model_version", None)},
        )
