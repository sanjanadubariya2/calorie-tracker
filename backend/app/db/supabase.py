"""User-scoped access to Supabase's REST API (PostgREST).

Every call is made *as the end user*: the verified access token is forwarded
as `Authorization: Bearer <token>`, so Postgres runs the query with role
`authenticated` and `auth.uid()` = that user. Row Level Security and function
privileges therefore apply exactly as they do for the mobile app. The
service-role key is never used here, and this service holds no credential that
bypasses RLS.

`apikey` is the project's anon/publishable key, which only identifies the
project to the API gateway.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.core.config import Settings
from app.core.security import AuthenticatedUser

logger = logging.getLogger(__name__)


class DatabaseError(Exception):
    """A database call failed. `status_code` and `code` are safe to act on;
    `message` is for logs only and is never returned to clients."""

    def __init__(self, status_code: int, code: str | None, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class DatabaseUnavailable(Exception):
    """Supabase could not be reached or timed out."""


class SupabaseRest:
    def __init__(self, settings: Settings, http: httpx.AsyncClient) -> None:
        self._base = settings.rest_url
        self._apikey = settings.supabase_anon_key.get_secret_value()
        self._http = http
        self._timeout = settings.upstream_timeout_seconds

    async def rpc(self, user: AuthenticatedUser, function: str, params: dict[str, Any]) -> Any:
        """Calls a Postgres function as `user` and returns the decoded JSON."""
        try:
            response = await self._http.post(
                f"{self._base}/rpc/{function}",
                json=params,
                headers={
                    "apikey": self._apikey,
                    "Authorization": f"Bearer {user.access_token}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            logger.error("Supabase RPC %s unreachable: %s", function, type(exc).__name__)
            raise DatabaseUnavailable() from exc

        if response.is_success:
            return response.json()

        code: str | None = None
        message = ""
        try:
            body = response.json()
            code = body.get("code")
            message = body.get("message", "")
        except ValueError:
            message = response.text[:200]
        logger.warning("Supabase RPC %s failed: HTTP %s code=%s", function, response.status_code, code)
        raise DatabaseError(response.status_code, code, message)
