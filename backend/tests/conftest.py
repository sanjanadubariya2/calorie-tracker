"""Shared fixtures. Unit tests never touch the network: Supabase's JWKS and
REST endpoints are served by an in-memory httpx transport, and tokens are
signed with a P-256 key generated per test session (the same ES256 scheme the
real project uses)."""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.core.config import Environment, Settings
from app.main import create_app

SUPABASE_URL = "https://project-ref.supabase.co"
ISSUER = f"{SUPABASE_URL}/auth/v1"
KID = "test-key-1"
ANON_KEY = "test-anon-key"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(scope="session")
def signing_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


@pytest.fixture(scope="session")
def other_key() -> ec.EllipticCurvePrivateKey:
    """A key that is NOT in the JWKS (forged tokens)."""
    return ec.generate_private_key(ec.SECP256R1())


def _public_jwk(key: ec.EllipticCurvePrivateKey, kid: str) -> dict[str, Any]:
    jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(key.public_key()))
    return {**jwk, "kid": kid, "alg": "ES256", "use": "sig"}


@pytest.fixture
def settings() -> Settings:
    return Settings(
        environment=Environment.test,
        supabase_url=SUPABASE_URL,
        supabase_anon_key=ANON_KEY,
        allowed_origins=["https://app.example.com"],
    )


@dataclass
class FakeSupabase:
    """Records every request; RPC responses are set per test."""

    jwks: dict[str, Any]
    requests: list[httpx.Request] = field(default_factory=list)
    rpc_handler: Callable[[httpx.Request], httpx.Response] | None = None
    rest_handler: Callable[[httpx.Request], httpx.Response] | None = None
    storage_handler: Callable[[httpx.Request], httpx.Response] | None = None
    off_handler: Callable[[httpx.Request], httpx.Response] | None = None
    jwks_fetches: int = 0

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/auth/v1/.well-known/jwks.json":
            self.jwks_fetches += 1
            return httpx.Response(200, json=self.jwks)
        if path.startswith("/rest/v1/rpc/") and self.rpc_handler:
            return self.rpc_handler(request)
        if path.startswith("/rest/v1/") and not path.startswith("/rest/v1/rpc/") and self.rest_handler:
            return self.rest_handler(request)
        if path.startswith("/storage/v1/") and self.storage_handler:
            return self.storage_handler(request)
        if request.url.host == "world.openfoodfacts.org" and self.off_handler:
            return self.off_handler(request)
        return httpx.Response(404, json={"message": "not found"})

    @property
    def rpc_requests(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path.startswith("/rest/v1/rpc/")]

    @property
    def storage_requests(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path.startswith("/storage/v1/")]

    @property
    def rest_requests(self) -> list[httpx.Request]:
        return [r for r in self.requests
                if r.url.path.startswith("/rest/v1/") and not r.url.path.startswith("/rest/v1/rpc/")]


@pytest.fixture
def fake_supabase(signing_key: ec.EllipticCurvePrivateKey) -> FakeSupabase:
    return FakeSupabase(jwks={"keys": [_public_jwk(signing_key, KID)]})


@pytest.fixture
def client(settings: Settings, fake_supabase: FakeSupabase) -> Iterator[TestClient]:
    app = create_app(settings, transport=httpx.MockTransport(fake_supabase.handle))
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture
def make_token(signing_key: ec.EllipticCurvePrivateKey) -> Callable[..., str]:
    """Signs a Supabase-shaped access token; any claim can be overridden."""

    _random = object()

    def _make(
        sub: Any = _random,
        *,
        key: Any = None,
        algorithm: str = "ES256",
        kid: str | None = KID,
        expires_in: int = 3600,
        **overrides: Any,
    ) -> str:
        now = int(time.time())
        claims: dict[str, Any] = {
            "iss": ISSUER,
            "aud": "authenticated",
            "sub": str(uuid.uuid4()) if sub is _random else sub,  # pass None to omit
            "role": "authenticated",
            "iat": now,
            "exp": now + expires_in,
            "email": "user@example.com",
        }
        claims.update(overrides)
        claims = {k: v for k, v in claims.items() if v is not None}
        headers = {"kid": kid} if kid else {}
        return jwt.encode(claims, key or signing_key, algorithm=algorithm, headers=headers)

    return _make


DAILY_STATUS_ROW = {
    "status_date": "2026-11-20",
    "target_kcal": 2759,
    "target_carbs_g": 276,
    "target_fat_g": 92,
    "target_protein_g": 207,
    "macro_carb_pct": 40,
    "macro_fat_pct": 30,
    "macro_protein_pct": 30,
    "consumed_kcal": 1470,
    "consumed_carbs_g": 98.0,
    "consumed_fat_g": 40.0,
    "consumed_protein_g": 34.3,
    "remaining_kcal": 1289,
    "remaining_carbs_g": 178.0,
    "remaining_fat_g": 52.0,
    "remaining_protein_g": 172.7,
    "entry_count": 3,
}
