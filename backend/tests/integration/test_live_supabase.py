"""End-to-end against a REAL Supabase stack: real Auth tokens (real signing
keys, real JWKS), real PostgREST, real RLS and get_daily_status().

Skipped unless SUPABASE_INTEGRATION=1. Against the local stack:

    npm run db:start                         # from the repo root
    # grant legacy table privileges if your local stack needs them (see the
    # note in supabase/tests/003_social_security.test.sql)
    SUPABASE_INTEGRATION=1 \\
    SUPABASE_URL=http://127.0.0.1:54321 \\
    SUPABASE_ANON_KEY=<ANON_KEY from `supabase status -o json`> \\
    pytest -m integration

Never point this at production: it signs up throwaway users.
"""

from __future__ import annotations

import datetime as dt
import os
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import Environment, Settings
from app.main import create_app

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(os.getenv("SUPABASE_INTEGRATION") != "1", reason="set SUPABASE_INTEGRATION=1 to run"),
]


@pytest.fixture(scope="module")
def live() -> dict[str, str]:
    url = os.environ["SUPABASE_URL"].rstrip("/")
    anon = os.environ["SUPABASE_ANON_KEY"]
    assert "127.0.0.1" in url or "localhost" in url, "integration tests only run against a local stack"
    return {"url": url, "anon": anon}


def _sign_up(live: dict[str, str]) -> tuple[str, str]:
    r = httpx.post(
        f"{live['url']}/auth/v1/signup",
        headers={"apikey": live["anon"]},
        json={"email": f"api-{uuid.uuid4().hex[:10]}@test.local", "password": "password-123456"},
    )
    r.raise_for_status()
    body = r.json()
    return body["access_token"], body["user"]["id"]


def _rest(live: dict[str, str], token: str, method: str, path: str, **kw: object) -> httpx.Response:
    return httpx.request(method, f"{live['url']}/rest/v1/{path}",
                         headers={"apikey": live["anon"], "Authorization": f"Bearer {token}"}, **kw)


@pytest.fixture(scope="module")
def api(live: dict[str, str]) -> TestClient:
    settings = Settings(environment=Environment.development, supabase_url=live["url"], supabase_anon_key=live["anon"])
    with TestClient(create_app(settings)) as client:
        yield client


def test_real_token_and_rls(live: dict[str, str], api: TestClient) -> None:
    token_a, user_a = _sign_up(live)
    token_b, _ = _sign_up(live)
    today = dt.date.today().isoformat()

    # A creates a profile and logs food directly through Supabase, like the app.
    assert _rest(live, token_a, "POST", "profiles", json={
        "user_id": user_a, "age": 30, "height_cm": 180, "weight_kg": 80, "gender": "male",
        "goal": "maintain", "activity_level": "moderate", "daily_target_kcal": 1}).status_code == 201
    assert _rest(live, token_a, "POST", "food_logs", json={
        "user_id": user_a, "logged_date": today, "meal_type": "lunch", "food_name": "x",
        "calories": 500, "carbs_g": 50, "fat_g": 10, "protein_g": 30}).status_code == 201

    a = api.get(f"/v1/me/daily-status?date={today}", headers={"Authorization": f"Bearer {token_a}"})
    assert a.status_code == 200, a.text
    body = a.json()
    assert body["targets"]["kcal"] == 2759           # computed by the database, not the client's 1
    assert body["consumed"]["kcal"] == 500
    assert body["remaining"]["kcal"] == 2259

    # B asks with A's id in the query: still gets B's own (empty) status.
    b = api.get(f"/v1/me/daily-status?date={today}&user_id={user_a}", headers={"Authorization": f"Bearer {token_b}"})
    assert b.status_code == 200
    assert b.json()["consumed"]["kcal"] == 0
    assert b.json()["targets"] is None


def test_real_token_with_tampered_signature_is_rejected(live: dict[str, str], api: TestClient) -> None:
    token, _ = _sign_up(live)
    head, payload, sig = token.split(".")
    bad = f"{head}.{payload}.{sig[:-4]}AAAA"
    assert api.get("/v1/me/daily-status", headers={"Authorization": f"Bearer {bad}"}).status_code == 401


def test_anon_key_is_not_a_user_token(live: dict[str, str], api: TestClient) -> None:
    response = api.get("/v1/me/daily-status", headers={"Authorization": f"Bearer {live['anon']}"})
    assert response.status_code == 401
