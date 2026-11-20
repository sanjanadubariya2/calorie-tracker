"""Request correlation ids.

Every request gets an id: the client's `X-Request-ID` if it is a short, safe
token, otherwise a new one. It is returned in the response header, attached
to log lines that ask for it, and stored with assistant messages so a user's
report can be traced without logging message content.
"""

from __future__ import annotations

import re
import uuid
from contextvars import ContextVar

from starlette.types import ASGIApp, Message, Receive, Scope, Send

HEADER = "x-request-id"
_SAFE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
_current: ContextVar[str | None] = ContextVar("correlation_id", default=None)


def correlation_id() -> str | None:
    return _current.get()


def new_correlation_id() -> str:
    return uuid.uuid4().hex


class CorrelationIdMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        supplied = next((v.decode("latin-1") for k, v in scope.get("headers", []) if k == HEADER.encode()), None)
        cid = supplied if supplied and _SAFE.match(supplied) else new_correlation_id()
        token = _current.set(cid)

        async def send_with_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != HEADER.encode()]
                headers.append((HEADER.encode(), cid.encode()))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            _current.reset(token)
