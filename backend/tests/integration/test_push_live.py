"""Push worker against the REAL local database, as the notification_sender
role (Expo's API is mocked, so nothing leaves the machine).

    alter role notification_sender password '<local only>';      -- local stack
    SUPABASE_INTEGRATION=1 \\
    PUSH_DATABASE_URL=postgresql://notification_sender:<pw>@127.0.0.1:54322/postgres \\
    ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \\
    pytest -m integration tests/integration/test_push_live.py
"""

from __future__ import annotations

import json
import os
import uuid

import httpx
import pytest

from app.services import push

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(os.getenv("SUPABASE_INTEGRATION") != "1" or not os.getenv("PUSH_DATABASE_URL"),
                       reason="set SUPABASE_INTEGRATION=1, PUSH_DATABASE_URL and ADMIN_DATABASE_URL (local) to run"),
]


def _admin(sql: str, *params: object) -> list[tuple]:
    import psycopg

    url = os.environ["ADMIN_DATABASE_URL"]
    assert "127.0.0.1" in url or "localhost" in url, "local database only"
    with psycopg.connect(url) as conn:
        cur = conn.execute(sql, params)
        rows = cur.fetchall() if cur.description else []
        conn.commit()
    return rows


def test_worker_delivers_retries_and_disables_dead_devices() -> None:
    assert "127.0.0.1" in os.environ["PUSH_DATABASE_URL"] or "localhost" in os.environ["PUSH_DATABASE_URL"]
    a, b = uuid.uuid4(), uuid.uuid4()
    tok_ok, tok_dead = f"ExponentPushToken[ok{a.hex[:12]}]", f"ExponentPushToken[dead{a.hex[:12]}]"
    try:
        _admin("insert into auth.users (id, email) values (%s, %s), (%s, %s)", a, f"{a}@t.local", b, f"{b}@t.local")
        _admin("insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, username) values "
               "(%s, 30, 170, 70, 'female', 'maintain', %s), (%s, 30, 170, 70, 'female', 'maintain', %s)",
               a, f"pw_{a.hex[:8]}", b, f"pw_{b.hex[:8]}")
        _admin("insert into public.notification_preferences (user_id, push_enabled) values (%s, true)", b)
        _admin("insert into public.push_tokens (user_id, token, platform) values (%s, %s, 'ios'), (%s, %s, 'android')",
               b, tok_ok, b, tok_dead)
        _admin("insert into public.friendships (requester_id, addressee_id) values (%s, %s)", a, b)

        sent: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            messages = json.loads(request.content)
            sent.extend(messages)
            return httpx.Response(200, json={"data": [
                {"status": "ok", "id": f"ticket-{i}"} if m["to"] == tok_ok
                else {"status": "error", "message": "gone", "details": {"error": "DeviceNotRegistered"}}
                for i, m in enumerate(messages)]})

        store = push.PostgresPushStore(os.environ["PUSH_DATABASE_URL"])
        with httpx.Client(transport=httpx.MockTransport(handler)) as http:
            report = push.deliver(store, http)
        mine = [m for m in sent if m["to"] in (tok_ok, tok_dead)]
        assert len(mine) == 2
        assert all(m["title"] == "New friend request" and f"@pw_{a.hex[:8]} wants to be friends." == m["body"] for m in mine)
        assert all(m["data"]["kind"] == "friend_request" for m in mine)
        assert report.sent >= 1 and report.failed >= 1
        statuses = dict(_admin("select t.token, o.status from public.push_outbox o join public.push_tokens t on t.id = o.token_id "
                               "where o.user_id = %s", b))
        assert statuses == {tok_ok: "sent", tok_dead: "failed"}
        [(disabled,)] = _admin("select disabled_reason from public.push_tokens where token = %s", tok_dead)
        assert disabled == "DeviceNotRegistered"

        # Nothing left to send: a second run sends nothing for this user.
        with httpx.Client(transport=httpx.MockTransport(handler)) as http:
            sent.clear()
            push.deliver(store, http)
        assert not [m for m in sent if m["to"] in (tok_ok, tok_dead)]
    finally:
        _admin("delete from auth.users where id in (%s, %s)", a, b)
