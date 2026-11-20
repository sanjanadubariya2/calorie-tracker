"""GET /v1/me/daily-status: delegation to get_daily_status(), identity, errors."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from tests.conftest import ANON_KEY, DAILY_STATUS_ROW, FakeSupabase

URL = "/v1/me/daily-status"


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def rpc_ok(fake_supabase: FakeSupabase) -> None:
    fake_supabase.rpc_handler = lambda _req: httpx.Response(200, json=[DAILY_STATUS_ROW])


# ------------------------------------------------------------------ authentication
def test_requires_authentication(client: TestClient, fake_supabase: FakeSupabase, rpc_ok: None) -> None:
    response = client.get(URL)
    assert response.status_code == 401
    assert fake_supabase.rpc_requests == []


# ------------------------------------------------------------------ happy path
def test_returns_typed_status(client: TestClient, make_token: Callable[..., str], rpc_ok: None) -> None:
    response = client.get(f"{URL}?date=2026-11-20", headers=_auth(make_token()))
    assert response.status_code == 200
    assert response.json() == {
        "date": "2026-11-20",
        "targets": {
            "kcal": 2759, "carbs_g": 276, "fat_g": 92, "protein_g": 207,
            "macro_split": {"carb_pct": 40, "fat_pct": 30, "protein_pct": 30},
        },
        "consumed": {"kcal": 1470.0, "carbs_g": 98.0, "fat_g": 40.0, "protein_g": 34.3, "entry_count": 3},
        "remaining": {"kcal": 1289.0, "carbs_g": 178.0, "fat_g": 52.0, "protein_g": 172.7},
    }


def test_forwards_the_callers_token_and_only_the_date(client: TestClient, fake_supabase: FakeSupabase,
                                                      make_token: Callable[..., str], rpc_ok: None) -> None:
    token = make_token()
    client.get(f"{URL}?date=2026-11-20", headers=_auth(token))
    [rpc] = fake_supabase.rpc_requests
    assert rpc.url.path == "/rest/v1/rpc/get_daily_status"
    assert rpc.headers["authorization"] == f"Bearer {token}"
    assert rpc.headers["apikey"] == ANON_KEY
    assert json.loads(rpc.content) == {"p_date": "2026-11-20"}


def test_no_service_role_credentials_are_sent(client: TestClient, fake_supabase: FakeSupabase,
                                              make_token: Callable[..., str], rpc_ok: None) -> None:
    token = make_token()
    client.get(URL, headers=_auth(token))
    [rpc] = fake_supabase.rpc_requests
    # Only the user's own token and the public anon key: nothing that bypasses RLS.
    assert set(k.lower() for k in rpc.headers) >= {"authorization", "apikey"}
    assert rpc.headers["authorization"] == f"Bearer {token}"
    assert "service_role" not in rpc.headers["apikey"]


def test_date_is_optional(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str],
                          rpc_ok: None) -> None:
    assert client.get(URL, headers=_auth(make_token())).status_code == 200
    assert json.loads(fake_supabase.rpc_requests[0].content) == {"p_date": None}


@pytest.mark.parametrize("bad", ["2026-02-30", "20-11-2026", "today", "2026-11-20T00:00:00"])
def test_invalid_date_is_422(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str],
                             rpc_ok: None, bad: str) -> None:
    response = client.get(f"{URL}?date={bad}", headers=_auth(make_token()))
    assert response.status_code == 422
    assert fake_supabase.rpc_requests == []


def test_no_profile_yet_returns_null_targets(client: TestClient, fake_supabase: FakeSupabase,
                                             make_token: Callable[..., str]) -> None:
    row = {**DAILY_STATUS_ROW, **{k: None for k in DAILY_STATUS_ROW if k.startswith(("target_", "macro_", "remaining_"))},
           "consumed_kcal": 0, "consumed_carbs_g": 0, "consumed_fat_g": 0, "consumed_protein_g": 0, "entry_count": 0}
    fake_supabase.rpc_handler = lambda _req: httpx.Response(200, json=[row])
    body = client.get(f"{URL}?date=2026-11-20", headers=_auth(make_token())).json()
    assert body["targets"] is None and body["remaining"] is None
    assert body["consumed"] == {"kcal": 0, "carbs_g": 0, "fat_g": 0, "protein_g": 0, "entry_count": 0}


# ------------------------------------------------------------------ identity can't be overridden
@pytest.mark.parametrize("param", ["user_id", "userId", "sub", "p_user", "uid"])
def test_user_id_query_parameters_are_ignored(client: TestClient, fake_supabase: FakeSupabase,
                                              make_token: Callable[..., str], rpc_ok: None, param: str) -> None:
    caller = str(uuid.uuid4())
    victim = str(uuid.uuid4())
    token = make_token(caller)
    response = client.get(f"{URL}?date=2026-11-20&{param}={victim}", headers=_auth(token))
    assert response.status_code == 200
    [rpc] = fake_supabase.rpc_requests
    assert json.loads(rpc.content) == {"p_date": "2026-11-20"}, "nothing but the date reaches the database"
    assert victim not in rpc.content.decode() and victim not in str(rpc.url)
    assert rpc.headers["authorization"] == f"Bearer {token}"


def test_identity_headers_are_ignored(client: TestClient, fake_supabase: FakeSupabase,
                                      make_token: Callable[..., str], rpc_ok: None) -> None:
    token = make_token()
    client.get(URL, headers={**_auth(token), "X-User-Id": str(uuid.uuid4()), "X-Supabase-User": "admin"})
    [rpc] = fake_supabase.rpc_requests
    assert "x-user-id" not in rpc.headers and "x-supabase-user" not in rpc.headers


# ------------------------------------------------------------------ database errors
def test_missing_timezone_is_a_clear_400(client: TestClient, fake_supabase: FakeSupabase,
                                         make_token: Callable[..., str]) -> None:
    fake_supabase.rpc_handler = lambda _req: httpx.Response(
        400, json={"code": "22023", "message": "p_date is required until the profile has a time zone"})
    response = client.get(URL, headers=_auth(make_token()))
    assert response.status_code == 400
    assert response.json() == {"detail": "A date is required until your profile has a time zone."}


@pytest.mark.parametrize("status_code,body", [
    (500, {"code": "XX000", "message": "relation \"secret_table\" does not exist", "details": "at line 42", "hint": "x"}),
    (400, {"code": "42883", "message": "function public.get_daily_status(text) does not exist"}),
    (503, "<html>upstream gateway error</html>"),
])
def test_database_errors_are_safe(client: TestClient, fake_supabase: FakeSupabase, make_token: Callable[..., str],
                                  status_code: int, body: object) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        if isinstance(body, str):
            return httpx.Response(status_code, text=body)
        return httpx.Response(status_code, json=body)

    fake_supabase.rpc_handler = handler
    response = client.get(f"{URL}?date=2026-11-20", headers=_auth(make_token()))
    assert response.status_code == 502
    assert response.json() == {"detail": "The database could not complete the request."}
    for leak in ("secret_table", "line 42", "get_daily_status", "XX000", "42883", "html", "Traceback"):
        assert leak not in response.text


def test_database_rejecting_the_token_is_401(client: TestClient, fake_supabase: FakeSupabase,
                                             make_token: Callable[..., str]) -> None:
    fake_supabase.rpc_handler = lambda _req: httpx.Response(401, json={"code": "PGRST301", "message": "JWT expired"})
    response = client.get(URL, headers=_auth(make_token()))
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid or expired token"}


def test_database_unreachable_is_503(client: TestClient, fake_supabase: FakeSupabase,
                                     make_token: Callable[..., str]) -> None:
    def down(_req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out")

    fake_supabase.rpc_handler = down
    response = client.get(URL, headers=_auth(make_token()))
    assert response.status_code == 503
    assert response.json() == {"detail": "The database is temporarily unavailable."}


def test_unexpected_payload_is_502(client: TestClient, fake_supabase: FakeSupabase,
                                   make_token: Callable[..., str]) -> None:
    fake_supabase.rpc_handler = lambda _req: httpx.Response(200, json=[])
    assert client.get(URL, headers=_auth(make_token())).status_code == 502


def test_malformed_row_is_safe_500(client: TestClient, fake_supabase: FakeSupabase,
                                   make_token: Callable[..., str]) -> None:
    fake_supabase.rpc_handler = lambda _req: httpx.Response(200, json=[{"status_date": "nonsense"}])
    response = client.get(URL, headers=_auth(make_token()))
    assert response.status_code == 500
    assert response.json() == {"detail": "Internal server error"}
    assert "status_date" not in response.text


# ------------------------------------------------------------------ CORS
def test_cors_allows_configured_origin_only(client: TestClient) -> None:
    ok = client.options(URL, headers={"Origin": "https://app.example.com", "Access-Control-Request-Method": "GET",
                                      "Access-Control-Request-Headers": "authorization"})
    assert ok.headers.get("access-control-allow-origin") == "https://app.example.com"
    bad = client.options(URL, headers={"Origin": "https://evil.example.com", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in bad.headers
