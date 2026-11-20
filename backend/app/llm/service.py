"""The LLM service: what business logic calls.

Adds, on top of a provider:
* a retry policy for transient failures (timeouts, overload), with backoff;
  429 (our quota), refusals and rejected requests are never retried;
* cost estimates from configured per-model prices (no prices: cost unknown);
* structured logging with the request's correlation id (never prompt or
  response content).
"""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Mapping
from dataclasses import dataclass, replace

from app.core.request_context import correlation_id
from app.llm.errors import LLMError
from app.llm.provider import LLMProvider
from app.llm.types import LLMRequest, LLMResponse, Usage

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ModelPrice:
    """USD per million tokens. Thinking tokens are billed as output."""
    input_per_million: float
    output_per_million: float


@dataclass(frozen=True)
class RetryPolicy:
    attempts: int = 2
    base_delay_seconds: float = 0.5
    max_delay_seconds: float = 4.0

    def delay(self, attempt: int) -> float:
        backoff = min(self.max_delay_seconds, self.base_delay_seconds * (2 ** attempt))
        return backoff * (0.5 + random.random() / 2)   # jitter


def estimate_cost(usage: Usage, price: ModelPrice | None) -> float | None:
    if price is None:
        return None
    billable_input = max(0, usage.input_tokens)
    billable_output = usage.output_tokens + usage.thinking_tokens
    return round((billable_input * price.input_per_million + billable_output * price.output_per_million) / 1_000_000, 6)


class LLMService:
    def __init__(self, provider: LLMProvider, prices: Mapping[str, ModelPrice] | None = None,
                 retry: RetryPolicy | None = None) -> None:
        self.provider = provider
        self._prices = dict(prices or {})
        self._retry = retry or RetryPolicy()

    @property
    def configured(self) -> bool:
        return self.provider.name != "disabled"

    def price_for(self, model: str) -> ModelPrice | None:
        return self._prices.get(model)

    async def generate(self, request: LLMRequest) -> LLMResponse:
        attempt = 0
        while True:
            try:
                response = await self.provider.generate(request)
            except LLMError as exc:
                retry = exc.retryable and attempt + 1 < self._retry.attempts
                logger.warning("LLM %s failed: %s (attempt %d%s) cid=%s", request.purpose, type(exc).__name__,
                               attempt + 1, ", retrying" if retry else "", correlation_id())
                if not retry:
                    raise
                await asyncio.sleep(self._retry.delay(attempt))
                attempt += 1
                continue
            cost = estimate_cost(response.usage, self.price_for(response.model))
            response = replace(response, estimated_cost_usd=cost, attempts=attempt + 1)
            logger.info(
                "LLM %s ok: model=%s in=%d out=%d think=%d calls=%d latency=%dms cid=%s",
                request.purpose, response.model, response.usage.input_tokens, response.usage.output_tokens,
                response.usage.thinking_tokens, len(response.tool_calls), response.latency_ms, correlation_id(),
            )
            return response
