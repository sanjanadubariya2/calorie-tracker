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

    def _headers(self, user: AuthenticatedUser, extra: dict[str, str] | None = None) -> dict[str, str]:
        return {
            "apikey": self._apikey,
            "Authorization": f"Bearer {user.access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            **(extra or {}),
        }

    async def _request(
        self,
        user: AuthenticatedUser,
        method: str,
        path: str,
        *,
        label: str,
        json: Any = None,
        params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        try:
            response = await self._http.request(
                method,
                f"{self._base}/{path}",
                json=json,
                params=params,
                headers=self._headers(user, headers),
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            logger.error("Supabase %s unreachable: %s", label, type(exc).__name__)
            raise DatabaseUnavailable() from exc

        if response.is_success:
            if response.status_code == 204 or not response.content:
                return None
            return response.json()

        code: str | None = None
        message = ""
        try:
            body = response.json()
            code = body.get("code")
            message = body.get("message", "")
        except ValueError:
            message = response.text[:200]
        logger.warning("Supabase %s failed: HTTP %s code=%s", label, response.status_code, code)
        raise DatabaseError(response.status_code, code, message)

    async def rpc(self, user: AuthenticatedUser, function: str, params: dict[str, Any]) -> Any:
        """Calls a Postgres function as `user` and returns the decoded JSON."""
        return await self._request(user, "POST", f"rpc/{function}", label=f"RPC {function}", json=params)

    async def select(self, user: AuthenticatedUser, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        """GET /<table>?<params> as `user` (PostgREST filter syntax)."""
        return await self._request(user, "GET", table, label=f"select {table}", params=params) or []

    async def insert(self, user: AuthenticatedUser, table: str, row: dict[str, Any]) -> dict[str, Any]:
        """Inserts one row as `user` and returns it."""
        rows = await self._request(
            user, "POST", table, label=f"insert {table}", json=row,
            headers={"Prefer": "return=representation"},
        )
        if not isinstance(rows, list) or len(rows) != 1:
            raise DatabaseError(502, None, f"insert {table} returned an unexpected shape")
        return rows[0]

    async def insert_many(self, user: AuthenticatedUser, table: str, rows: list[dict[str, Any]], *,
                          select: str = "*") -> list[dict[str, Any]]:
        """Inserts several rows as `user` in ONE request, which PostgREST runs as
        one transaction: either every row is saved or none is."""
        saved = await self._request(
            user, "POST", table, label=f"insert {table}", json=rows, params={"select": select},
            headers={"Prefer": "return=representation"},
        )
        if not isinstance(saved, list) or len(saved) != len(rows):
            raise DatabaseError(502, None, f"insert {table} returned an unexpected shape")
        return saved

    async def upsert(self, user: AuthenticatedUser, table: str, row: dict[str, Any], *, on_conflict: str,
                     select: str = "*") -> dict[str, Any]:
        """Inserts or updates one row as `user` (RLS applies to both) and returns it."""
        rows = await self._request(
            user, "POST", table, label=f"upsert {table}", json=row,
            params={"on_conflict": on_conflict, "select": select},
            headers={"Prefer": "return=representation,resolution=merge-duplicates"},
        )
        if not isinstance(rows, list) or len(rows) != 1:
            raise DatabaseError(502, None, f"upsert {table} returned an unexpected shape")
        return rows[0]

    async def delete(self, user: AuthenticatedUser, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
        """Deletes matching rows as `user` and returns the deleted rows."""
        return await self._request(
            user, "DELETE", table, label=f"delete {table}", params=params,
            headers={"Prefer": "return=representation"},
        ) or []
