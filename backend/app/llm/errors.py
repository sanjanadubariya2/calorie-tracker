"""LLM failures. Messages are for logs only; clients get fixed, safe texts."""

from __future__ import annotations


class LLMError(Exception):
    retryable = False


class LLMNotConfigured(LLMError):
    pass


class LLMTimeout(LLMError):
    retryable = True


class LLMUnavailable(LLMError):
    """Provider overloaded, 5xx, or unreachable."""
    retryable = True


class LLMRateLimited(LLMError):
    """Our quota with the provider (429). Not retried: it would only burn more."""

    def __init__(self, retry_after: int | None = None) -> None:
        super().__init__("provider rate limited")
        self.retry_after = retry_after


class LLMRequestRejected(LLMError):
    """The provider rejected the request (4xx other than 429): a bug or bad credentials."""


class LLMRefused(LLMError):
    """The model or its safety system declined to answer."""


class LLMInvalidOutput(LLMError):
    """The provider answered, but not in a usable shape."""
