"""User-scoped access to Supabase Storage.

Like the REST client, every call carries the end user's own access token, so
the storage policies in migration 009 (own folder only, exact name shape, no
overwrite) are enforced by Supabase for this service exactly as for the app.
"""

from __future__ import annotations

import logging

import httpx

from app.core.config import Settings
from app.core.security import AuthenticatedUser
from app.db.supabase import DatabaseError, DatabaseUnavailable

logger = logging.getLogger(__name__)


class SupabaseStorage:
    def __init__(self, settings: Settings, http: httpx.AsyncClient) -> None:
        self._base = settings.storage_url
        self._public_base = settings.storage_url
        self._apikey = settings.supabase_anon_key.get_secret_value()
        self._http = http
        self._timeout = settings.upstream_timeout_seconds

    def _headers(self, user: AuthenticatedUser, extra: dict[str, str] | None = None) -> dict[str, str]:
        return {"apikey": self._apikey, "Authorization": f"Bearer {user.access_token}", **(extra or {})}

    async def _send(self, label: str, method: str, url: str, **kwargs: object) -> httpx.Response:
        try:
            response = await self._http.request(method, url, timeout=self._timeout, **kwargs)  # type: ignore[arg-type]
        except httpx.HTTPError as exc:
            logger.error("Storage %s unreachable: %s", label, type(exc).__name__)
            raise DatabaseUnavailable() from exc
        if not response.is_success:
            code = None
            try:
                body = response.json()
                code = str(body.get("statusCode") or body.get("error") or "") or None
            except ValueError:
                pass
            logger.warning("Storage %s failed: HTTP %s code=%s", label, response.status_code, code)
            raise DatabaseError(response.status_code, code, f"storage {label} failed")
        return response

    async def upload(self, user: AuthenticatedUser, bucket: str, path: str, data: bytes, content_type: str) -> None:
        """Creates a new object. Never overwrites (x-upsert: false)."""
        await self._send(
            "upload", "POST", f"{self._base}/object/{bucket}/{path}",
            content=data,
            headers=self._headers(user, {
                "Content-Type": content_type,
                "x-upsert": "false",
                "Cache-Control": "private, max-age=0, no-store",
            }),
        )

    async def signed_url(self, user: AuthenticatedUser, bucket: str, path: str, expires_in: int) -> str:
        """A short-lived URL for one object, issued only if `user` may read it."""
        response = await self._send(
            "sign", "POST", f"{self._base}/object/sign/{bucket}/{path}",
            json={"expiresIn": expires_in},
            headers=self._headers(user, {"Content-Type": "application/json"}),
        )
        signed = response.json().get("signedURL") or response.json().get("signedUrl")
        if not isinstance(signed, str) or not signed.startswith("/"):
            raise DatabaseError(502, None, "storage sign returned an unexpected shape")
        return f"{self._public_base}{signed}"

    async def download(self, user: AuthenticatedUser, bucket: str, path: str, max_bytes: int) -> bytes:
        """Reads a private object as `user` (storage policies apply)."""
        response = await self._send(
            "download", "GET", f"{self._base}/object/authenticated/{bucket}/{path}", headers=self._headers(user)
        )
        if len(response.content) > max_bytes:
            raise DatabaseError(502, None, "stored object larger than expected")
        return response.content

    async def delete(self, user: AuthenticatedUser, bucket: str, path: str) -> None:
        await self._send("delete", "DELETE", f"{self._base}/object/{bucket}/{path}", headers=self._headers(user))
