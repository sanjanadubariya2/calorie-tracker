"""Recognition providers.

The pipeline depends only on RecognitionProvider; swapping models or vendors
means adding a class here, not changing the pipeline. A provider turns an
image or text into the raw JSON object described by OUTPUT_JSON_SCHEMA and
maps its vendor's failures onto the errors below. It never sees user ids,
tokens or anything beyond the image/text being analysed.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Protocol

from app.services.recognition.model_output import OUTPUT_JSON_SCHEMA, SYSTEM_PROMPT

logger = logging.getLogger(__name__)


class ProviderError(Exception):
    """Base class. Messages are for logs; clients get fixed, safe texts."""


class ProviderNotConfigured(ProviderError):
    pass


class ProviderTimeout(ProviderError):
    pass


class ProviderRateLimited(ProviderError):
    def __init__(self, retry_after: int | None = None) -> None:
        super().__init__("provider rate limited")
        self.retry_after = retry_after


class ProviderUnavailable(ProviderError):
    pass


class ProviderRefused(ProviderError):
    """The model declined to analyse the input."""


class InvalidModelOutput(ProviderError):
    pass


@dataclass(frozen=True)
class RecognitionInput:
    text: str | None = None
    image_jpeg: bytes | None = None


@dataclass(frozen=True)
class RawRecognition:
    data: dict[str, Any]
    provider: str
    model: str


class RecognitionProvider(Protocol):
    name: str
    model: str

    async def recognize(self, request: RecognitionInput) -> RawRecognition: ...


class DisabledProvider:
    name = "disabled"
    model = "none"

    async def recognize(self, request: RecognitionInput) -> RawRecognition:
        raise ProviderNotConfigured("recognition is not configured")


class GeminiProvider:
    """Google Gemini via the google-genai SDK with a JSON-schema response.

    * Model and thinking level come from settings (default gemini-3.8-flash, medium).
    * Fallback models: when a model is overloaded (5xx) or doesn't answer within
      the per-model timeout, the next model in `fallback_models` is tried. Each
      attempt is bounded by our own timeout, so the result doesn't depend on
      which HTTP library the SDK uses. 429 (our quota) is surfaced with
      Retry-After rather than retried on another model.
    * A blocked prompt or a safety stop becomes ProviderRefused.
    """

    name = "gemini"
    _REFUSAL_FINISH = {
        "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
        "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION",
    }

    def __init__(self, api_key: str, model: str, effort: str, timeout: float,
                 fallback_models: tuple[str, ...] = ()) -> None:
        from google import genai
        from google.genai import errors, types

        self._types = types
        self._errors = errors
        self.model = model
        self._models = (model, *[m for m in fallback_models if m and m != model])
        self._effort = effort
        self._timeout = timeout
        self._client = genai.Client(
            api_key=api_key,
            # Falling back to another model replaces SDK retries on the same one.
            http_options=types.HttpOptions(
                timeout=int(timeout * 1000),  # milliseconds
                retry_options=types.HttpRetryOptions(attempts=1),
            ),
        )

    async def aclose(self) -> None:
        close = getattr(self._client.aio, "aclose", None)
        if close is not None:
            await close()

    def _contents(self, request: RecognitionInput) -> list[Any]:
        t = self._types
        if request.image_jpeg is not None:
            return [
                t.Part.from_bytes(data=request.image_jpeg, mime_type="image/jpeg"),
                "Identify the foods in this meal photo.",
            ]
        return [
            "Identify the foods in this meal description.\n"
            f"<meal_description>\n{request.text}\n</meal_description>"
        ]

    def _config(self) -> Any:
        t = self._types
        return t.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_json_schema=OUTPUT_JSON_SCHEMA,
            thinking_config=t.ThinkingConfig(thinking_level=self._effort.upper()),
            max_output_tokens=16000,
            # No tools are declared; keep the SDK's function-calling loop off.
            automatic_function_calling=t.AutomaticFunctionCallingConfig(disable=True),
        )

    async def recognize(self, request: RecognitionInput) -> RawRecognition:
        last: ProviderError | None = None
        for model in self._models:
            try:
                return await self._recognize_with(model, request)
            except (ProviderTimeout, ProviderUnavailable, ProviderRateLimited) as exc:
                if "credentials" in str(exc) or "rejected request" in str(exc):
                    raise  # the same problem on every model
                logger.warning("Recognition model %s failed (%s); %s", model, type(exc).__name__,
                               "trying fallback" if model != self._models[-1] else "no fallback left")
                last = exc
        assert last is not None
        raise last

    async def _recognize_with(self, model: str, request: RecognitionInput) -> RawRecognition:
        errors = self._errors
        try:
            response = await asyncio.wait_for(
                self._client.aio.models.generate_content(
                    model=model, contents=self._contents(request), config=self._config()
                ),
                timeout=self._timeout + 2,
            )
        except (asyncio.TimeoutError, TimeoutError) as exc:
            raise ProviderTimeout("provider timed out") from exc
        except errors.APIError as exc:
            code = getattr(exc, "code", None)
            if code == 429:
                raise ProviderRateLimited(_retry_after(exc)) from exc
            if code in (401, 403):
                logger.error("Recognition provider rejected the configured credentials")
                raise ProviderUnavailable("provider credentials rejected") from exc
            if code == 400:
                logger.warning("Recognition provider rejected the request (HTTP 400)")
                raise ProviderUnavailable("provider rejected request") from exc
            if code == 504:
                raise ProviderTimeout("provider timed out") from exc
            raise ProviderUnavailable(f"provider HTTP {code}") from exc
        except Exception as exc:  # transport errors from whichever HTTP library the SDK uses
            if "timeout" in type(exc).__name__.lower():
                raise ProviderTimeout("provider timed out") from exc
            logger.warning("Recognition provider unreachable: %s", type(exc).__name__)
            raise ProviderUnavailable("provider unreachable") from exc

        feedback = getattr(response, "prompt_feedback", None)
        if feedback is not None and getattr(feedback, "block_reason", None):
            raise ProviderRefused("prompt blocked")
        candidates = response.candidates or []
        if not candidates:
            raise ProviderRefused("no candidates returned")
        finish = _enum_name(getattr(candidates[0], "finish_reason", None))
        if finish in self._REFUSAL_FINISH:
            raise ProviderRefused("model declined")
        if finish == "MAX_TOKENS":
            raise InvalidModelOutput("model output truncated")
        content = getattr(candidates[0], "content", None)
        parts = (getattr(content, "parts", None) or []) if content is not None else []
        text = "".join(p.text for p in parts if getattr(p, "text", None) and not getattr(p, "thought", False))
        if not text:
            raise InvalidModelOutput("no text in model output")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise InvalidModelOutput("model output is not JSON") from exc
        if not isinstance(data, dict):
            raise InvalidModelOutput("model output is not an object")
        return RawRecognition(data=data, provider=self.name, model=getattr(response, "model_version", None) or model)


def _enum_name(value: Any) -> str | None:
    if value is None:
        return None
    return getattr(value, "name", None) or str(value).rsplit(".", 1)[-1]


def _retry_after(exc: Exception) -> int | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    value = headers.get("retry-after") if headers is not None else None
    return int(value) if isinstance(value, str) and value.isdigit() else None


def build_provider(settings: Any) -> RecognitionProvider:
    if settings.recognition_provider == "gemini" and settings.gemini_api_key is not None:
        return GeminiProvider(
            api_key=settings.gemini_api_key.get_secret_value(),
            model=settings.recognition_model,
            effort=settings.recognition_effort,
            timeout=settings.recognition_timeout_seconds,
            fallback_models=tuple(m.strip() for m in settings.recognition_fallback_models.split(",") if m.strip()),
        )
    return DisabledProvider()
