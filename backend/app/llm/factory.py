"""Builds the LLM service from settings. The API key stays on the backend."""

from __future__ import annotations

from app.core.config import Settings
from app.llm.provider import DisabledLLM, LLMProvider
from app.llm.service import LLMService, ModelPrice, RetryPolicy


def build_llm_provider(settings: Settings) -> LLMProvider:
    if settings.assistant_provider == "gemini" and settings.gemini_api_key is not None:
        from app.llm.gemini import GeminiLLM

        return GeminiLLM(
            api_key=settings.gemini_api_key.get_secret_value(),
            model=settings.assistant_model,
            fallback_models=settings.assistant_fallbacks,
            thinking_level=settings.assistant_thinking_level,
            timeout_seconds=settings.assistant_llm_timeout_seconds,
        )
    return DisabledLLM()


def build_llm_service(settings: Settings, provider: LLMProvider | None = None) -> LLMService:
    prices = {m: ModelPrice(i, o) for m, (i, o) in settings.llm_prices.items()}
    return LLMService(provider or build_llm_provider(settings), prices,
                      RetryPolicy(attempts=settings.assistant_llm_retry_attempts))
