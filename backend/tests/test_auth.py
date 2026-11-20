"""JWT verification through the real dependency, via /v1/me/daily-status."""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import Callable

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from tests.conftest import DAILY_STATUS_ROW, FakeSupabase

ENDPOINT = "/v1/me/daily-status?date=2026-11-20"


@pytest.fixture(autouse=True)
def _rpc_ok(fake_supabase: FakeSupabase) -> None:
    fake_supabase.rpc_handler = lambda _req: httpx.Response(200, json=[DAILY_STATUS_ROW])


def _get(client: TestClient, token: str | None = None, scheme: str = "Bearer") -> httpx.Response:
    headers = {"Authorization": f"{scheme} {token}"} if token is not None else {}
    return client.get(ENDPOINT, headers=headers)


def _assert_rejected(response: httpx.Response, fake: FakeSupabase) -> None:
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.json()["detail"] in ("Not authenticated", "Invalid or expired token")
    assert fake.rpc_requests == [], "a rejected token must never reach the database"


# ------------------------------------------------------------------ missing / malformed
def test_missing_authorization_header(client: TestClient, fake_supabase: FakeSupabase) -> None:
    response = _get(client)
    _assert_rejected(response, fake_supabase)
    assert response.json()["detail"] == "Not authenticated"


@pytest.mark.parametrize("value", ["", "Bearer", "Bearer ", "Basic dXNlcjpwYXNz", "Token abc", "bearer"])
def test_malformed_authorization_header(client: TestClient, fake_supabase: FakeSupabase, value: str) -> None:
    response = client.get(ENDPOINT, headers={"Authorization": value})
    _assert_rejected(response, fake_supabase)


@pytest.mark.parametrize("token", ["not-a-jwt", "a.b.c", "eyJhbGciOiJFUzI1NiJ9.e30.", "...."])
def test_garbage_token(client: TestClient, fake_supabase: FakeSupabase, token: str) -> None:
    _assert_rejected(_get(client, token), fake_supabase)


# ------------------------------------------------------------------ signature
def test_signed_by_unknown_key(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str],
                               other_key: ec.EllipticCurvePrivateKey) -> None:
    _assert_rejected(_get(client, make_token(key=other_key)), fake_supabase)


def test_unknown_kid(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str]) -> None:
    _assert_rejected(_get(client, make_token(kid="rotated-away")), fake_supabase)


def test_missing_kid(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str]) -> None:
    _assert_rejected(_get(client, make_token(kid=None)), fake_supabase)


def test_tampered_payload(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str]) -> None:
    header, payload, signature = make_token().split(".")
    claims = json.loads(base64.urlsafe_b64decode(payload + "=="))
    claims["sub"] = str(uuid.uuid4())  # try to become someone else
    forged = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    _assert_rejected(_get(client, f"{header}.{forged}.{signature}"), fake_supabase)


def test_alg_none_rejected(client: TestClient, fake_supabase: FakeSupabase) -> None:
    token = jwt.encode({"sub": str(uuid.uuid4()), "role": "authenticated"}, key=None, algorithm="none")
    _assert_rejected(_get(client, token), fake_supabase)


def test_hs256_algorithm_confusion_rejected(client: TestClient, fake_supabase: FakeSupabase,
                                            signing_key: ec.EllipticCurvePrivateKey, make_token: Callable[..., str]) -> None:
    """Classic attack: sign with HS256 using the *public* key as the HMAC secret."""
    public_pem = signing_key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    import hmac, hashlib  # noqa: E401 - local to the attack construction

    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT", "kid": "test-key-1"}).encode()).rstrip(b"=")
    good_claims = make_token().split(".")[1].encode()
    signing_input = header + b"." + good_claims
    sig = base64.urlsafe_b64encode(hmac.new(public_pem, signing_input, hashlib.sha256).digest()).rstrip(b"=")
    _assert_rejected(_get(client, (signing_input + b"." + sig).decode()), fake_supabase)


# ------------------------------------------------------------------ claims
def test_expired_token(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str]) -> None:
    _assert_rejected(_get(client, make_token(expires_in=-120)), fake_supabase)


def test_expiry_within_leeway_is_accepted(client: TestClient, make_token: Callable[..., str]) -> None:
    assert _get(client, make_token(expires_in=-5)).status_code == 200


def test_wrong_issuer(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str]) -> None:
    token = make_token(iss="https://evil-project.supabase.co/auth/v1")
    _assert_rejected(_get(client, token), fake_supabase)


@pytest.mark.parametrize("aud", ["anon", "service_role", "something-else", ["other"]])
def test_wrong_audience(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str], aud: object) -> None:
    _assert_rejected(_get(client, make_token(aud=aud)), fake_supabase)


@pytest.mark.parametrize("role", ["anon", "service_role", None])
def test_non_user_roles_rejected(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str],
                                 role: str | None) -> None:
    _assert_rejected(_get(client, make_token(role=role)), fake_supabase)


@pytest.mark.parametrize("claim", ["exp", "iat", "sub", "iss", "aud"])
def test_required_claims(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str], claim: str) -> None:
    _assert_rejected(_get(client, make_token(**{claim: None})), fake_supabase)


def test_sub_must_be_a_uuid(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str]) -> None:
    _assert_rejected(_get(client, make_token(sub="admin")), fake_supabase)


# ------------------------------------------------------------------ identity
def test_identity_comes_from_verified_sub(client: TestClient, fake_supabase: FakeSupabase,
                                          make_token: Callable[..., str]) -> None:
    user_id = str(uuid.uuid4())
    token = make_token(user_id)
    assert _get(client, token).status_code == 200
    forwarded = fake_supabase.rpc_requests[0]
    # The database sees exactly this user's token, so auth.uid() = user_id.
    assert forwarded.headers["authorization"] == f"Bearer {token}"
    assert jwt.decode(token, options={"verify_signature": False})["sub"] == user_id


@pytest.mark.anyio
async def test_verifier_extracts_user_id(settings, fake_supabase: FakeSupabase, make_token: Callable[..., str]) -> None:
    from app.core.security import JwksCache, TokenVerifier

    async with httpx.AsyncClient(transport=httpx.MockTransport(fake_supabase.handle)) as http:
        verifier = TokenVerifier(settings, JwksCache(settings.jwks_url, http, 600))
        user_id = str(uuid.uuid4())
        user = await verifier.verify(make_token(user_id))
    assert user.user_id == user_id
    assert user.claims["role"] == "authenticated"
    assert "access_token" not in repr(user), "tokens must not appear in reprs/logs"


def test_jwks_is_cached(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str]) -> None:
    for _ in range(5):
        assert _get(client, make_token()).status_code == 200
    assert fake_supabase.jwks_fetches == 1


def test_unknown_kid_refetch_is_rate_limited(client: TestClient, fake_supabase: FakeSupabase,
                                             make_token: Callable[..., str]) -> None:
    assert _get(client, make_token()).status_code == 200  # initial fetch
    for i in range(10):
        _get(client, make_token(kid=f"random-{i}"))
    assert fake_supabase.jwks_fetches <= 2, "random kids must not trigger a JWKS fetch each"


def test_jwks_unavailable_is_401_not_500(settings, make_token: Callable[..., str]) -> None:
    from app.main import create_app

    def down(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("unreachable")

    with TestClient(create_app(settings, transport=httpx.MockTransport(down)), raise_server_exceptions=False) as c:
        response = c.get(ENDPOINT, headers={"Authorization": f"Bearer {make_token()}"})
    assert response.status_code == 401
