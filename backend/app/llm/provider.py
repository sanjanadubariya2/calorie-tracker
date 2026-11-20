"""The provider interface. Implementations translate LLMRequest/LLMResponse to
one vendor's SDK and map its failures onto app.llm.errors."""

from __future__ import annotations

from typing import Protocol

from app.llm.errors import LLMNotConfigured
from app.llm.types import LLMRequest, LLMResponse


class LLMProvider(Protocol):
    name: str

    @property
    def models(self) -> tuple[str, ...]: ...

    async def generate(self, request: LLMRequest) -> LLMResponse: ...

    async def aclose(self) -> None: ...


class DisabledLLM:
    """Used when no provider key is configured."""

    name = "disabled"
    models: tuple[str, ...] = ()

    async def generate(self, request: LLMRequest) -> LLMResponse:
        raise LLMNotConfigured("no LLM provider configured")

    async def aclose(self) -> None:
        return None
