"""Supabase access-token verification.

Supabase Auth signs user access tokens with the project's asymmetric signing
key (ES256 for this project, checked against its JWKS endpoint) and publishes
the public keys at <SUPABASE_URL>/auth/v1/.well-known/jwks.json. A token is
accepted only if all of the following hold:

  1. Its header `alg` is in the configured allow-list (default ES256 only).
     The algorithm is then pinned for verification, so a token can't choose a
     weaker one ("none", or HS256 signed with the public key).
  2. For asymmetric algorithms, its `kid` names a key in the JWKS whose own
     algorithm matches. HS256 is only possible when a legacy secret is
     configured explicitly.
  3. The signature verifies.
  4. `exp`, `iat`, `iss`, `aud` and `sub` are present; it isn't expired (small
     leeway for clock skew); `iss` and `aud` match this project.
  5. `role` is "authenticated" and `sub` is a UUID. This rejects anon and
     service-role tokens and anything that isn't a signed-in user.

Only after that is `sub` used as the user id. Nothing from the request body or
query string is ever treated as identity.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx
import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import Settings

logger = logging.getLogger(__name__)

# Minimum gap between JWKS refetches triggered by an unknown `kid`, so a flood
# of tokens with random kids can't turn into a flood of requests to Supabase.
_UNKNOWN_KID_REFETCH_SECONDS = 30.0


class TokenError(Exception):
    """Any reason a token is not acceptable. The message is for logs only."""


@dataclass(frozen=True)
class AuthenticatedUser:
    """A verified Supabase user. `access_token` is forwarded to Supabase so the
    database applies that user's RLS policies."""

    user_id: str
    access_token: str = field(repr=False)
    claims: dict[str, Any] = field(repr=False, default_factory=dict)


class JwksCache:
    """Fetches and caches the project's public signing keys."""

    def __init__(self, url: str, http: httpx.AsyncClient, ttl_seconds: int) -> None:
        self._url = url
        self._http = http
        self._ttl = ttl_seconds
        self._keys: dict[str, jwt.PyJWK] = {}
        self._fetched_at = 0.0
        self._last_unknown_kid_refetch = 0.0
        self._lock = asyncio.Lock()

    async def _refresh(self) -> None:
        response = await self._http.get(self._url)
        response.raise_for_status()
        keys: dict[str, jwt.PyJWK] = {}
        for jwk in response.json().get("keys", []):
            if jwk.get("use", "sig") != "sig" or "kid" not in jwk:
                continue
            try:
                keys[jwk["kid"]] = jwt.PyJWK(jwk)
            except jwt.PyJWKError:
                logger.warning("Skipping unusable JWK (kid=%s)", jwk.get("kid"))
        self._keys = keys
        self._fetched_at = time.monotonic()

    async def get(self, kid: str) -> jwt.PyJWK:
        async with self._lock:
            now = time.monotonic()
            if not self._keys or now - self._fetched_at > self._ttl:
                await self._refresh()
            elif kid not in self._keys and now - self._last_unknown_kid_refetch > _UNKNOWN_KID_REFETCH_SECONDS:
                # Possibly a key rotation since the last fetch.
                self._last_unknown_kid_refetch = now
                await self._refresh()
        key = self._keys.get(kid)
        if key is None:
            raise TokenError("unknown signing key")
        return key


class TokenVerifier:
    def __init__(self, settings: Settings, jwks: JwksCache) -> None:
        self._settings = settings
        self._jwks = jwks

    async def verify(self, token: str) -> AuthenticatedUser:
        s = self._settings
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise TokenError("malformed token") from exc

        alg = header.get("alg")
        if alg not in s.supabase_jwt_algorithms:
            raise TokenError(f"algorithm {alg!r} not allowed")

        if alg == "HS256":
            if s.supabase_jwt_secret is None:  # also enforced by Settings
                raise TokenError("HS256 not configured")
            key: Any = s.supabase_jwt_secret.get_secret_value()
        else:
            kid = header.get("kid")
            if not isinstance(kid, str) or not kid:
                raise TokenError("missing kid")
            try:
                jwk = await self._jwks.get(kid)
            except httpx.HTTPError as exc:
                logger.error("Could not fetch JWKS: %s", type(exc).__name__)
                raise TokenError("signing keys unavailable") from exc
            if jwk.algorithm_name != alg:
                raise TokenError("key/algorithm mismatch")
            key = jwk.key

        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=[alg],
                audience=s.supabase_jwt_audience,
                issuer=s.jwt_issuer,
                leeway=s.jwt_leeway_seconds,
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
            )
        except jwt.ExpiredSignatureError as exc:
            raise TokenError("expired") from exc
        except jwt.PyJWTError as exc:
            raise TokenError(type(exc).__name__) from exc

        if claims.get("role") != "authenticated":
            raise TokenError("not an authenticated-user token")
        sub = claims.get("sub")
        try:
            user_id = str(uuid.UUID(str(sub)))
        except ValueError as exc:
            raise TokenError("sub is not a UUID") from exc

        return AuthenticatedUser(user_id=user_id, access_token=token, claims=claims)


# --------------------------------------------------------------------------- #
# FastAPI dependency
# --------------------------------------------------------------------------- #

_bearer = HTTPBearer(auto_error=False)


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_token_verifier(request: Request) -> TokenVerifier:
    return request.app.state.token_verifier


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    verifier: TokenVerifier = Depends(get_token_verifier),
) -> AuthenticatedUser:
    """Requires `Authorization: Bearer <Supabase access token>`.

    Every rejection returns the same generic 401, so callers can't probe which
    check failed; the reason is logged without the token.
    """
    if credentials is None or credentials.scheme.lower() != "bearer" or not credentials.credentials:
        raise _unauthorized("Not authenticated")
    try:
        return await verifier.verify(credentials.credentials)
    except TokenError as exc:
        logger.info("Rejected access token: %s", exc)
        raise _unauthorized("Invalid or expired token") from None
