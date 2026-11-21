"""Phase 4 end-to-end against a REAL local Supabase stack: real Auth JWTs,
PostgREST and RLS, exercising the same calls the app makes.

Skipped unless SUPABASE_INTEGRATION=1 (see test_live_supabase.py for setup).
Never point this at production: it signs up throwaway users.
"""

from __future__ import annotations

import datetime as dt
import os
import uuid
from typing import Any

import httpx
import pytest

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(os.getenv("SUPABASE_INTEGRATION") != "1", reason="set SUPABASE_INTEGRATION=1 to run"),
]


@pytest.fixture(scope="module")
def live() -> dict[str, str]:
    url = os.environ["SUPABASE_URL"].rstrip("/")
    assert "127.0.0.1" in url or "localhost" in url, "integration tests only run against a local stack"
    return {"url": url, "anon": os.environ["SUPABASE_ANON_KEY"]}


class User:
    def __init__(self, live: dict[str, str]) -> None:
        self.live = live
        name = f"p4_{uuid.uuid4().hex[:8]}"
        r = httpx.post(f"{live['url']}/auth/v1/signup", headers={"apikey": live["anon"]},
                       json={"email": f"{name}@test.local", "password": "password-123456"})
        r.raise_for_status()
        self.token, self.id, self.username = r.json()["access_token"], r.json()["user"]["id"], name
        assert self.rest("POST", "profiles", json={
            "user_id": self.id, "age": 30, "height_cm": 170, "weight_kg": 70, "gender": "female", "goal": "maintain",
            "activity_level": "moderate", "daily_target_kcal": 1, "username": name}).status_code == 201

    def rest(self, method: str, path: str, **kw: Any) -> httpx.Response:
        headers = {"apikey": self.live["anon"], "Authorization": f"Bearer {self.token}",
                   "Prefer": "return=representation", **kw.pop("headers", {})}
        return httpx.request(method, f"{self.live['url']}/rest/v1/{path}", headers=headers, **kw)

    def rpc(self, fn: str, **args: Any) -> Any:
        r = self.rest("POST", f"rpc/{fn}", json=args)
        assert r.status_code in (200, 204), f"{fn}: {r.status_code} {r.text}"
        return r.json() if r.content else None

    def rpc_error(self, fn: str, **args: Any) -> str:
        r = self.rest("POST", f"rpc/{fn}", json=args)
        assert r.status_code >= 400, f"{fn} unexpectedly succeeded"
        return r.json().get("code", "")

    def notifications(self) -> list[dict[str, Any]]:
        return self.rpc("get_notifications", p_limit=50)


def test_social_wellness_end_to_end(live: dict[str, str]) -> None:
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    a, b, stranger = User(live), User(live), User(live)

    # Friend request -> notification -> accept -> notification.
    assert a.rest("POST", "friendships", json={"requester_id": a.id, "addressee_id": b.id}).status_code == 201
    [req] = [n for n in b.notifications() if n["kind"] == "friend_request"]
    assert req["actor_username"] == a.username and b.rpc("get_unread_notification_count") >= 1
    b.rpc("respond_to_friend_request", p_request_id=req["friendship_id"], p_accept=True)
    assert [n["kind"] for n in a.notifications()] == ["friend_accepted"]

    # Friends see no calories; the streak only when shared.
    [summary] = b.rpc("get_friend_list")
    assert set(summary) == {"user_id", "username", "avatar_url", "current_streak"}
    assert summary["current_streak"] is None
    # Builds from before Phase 4 are refused rather than shown fake zero calories.
    assert b.rpc_error("get_friend_summaries", p_today=today) == "P0426"

    # Logging: created_at is the server's; the first meal unlocks an achievement (in-app notification).
    r = a.rest("POST", "food_logs", json={"user_id": a.id, "logged_date": today, "meal_type": "lunch", "food_name": "Dal",
                                          "calories": 300, "carbs_g": 30, "fat_g": 5, "protein_g": 10,
                                          "created_at": "2020-01-01T00:00:00Z"})
    assert r.status_code == 201 and not r.json()[0]["created_at"].startswith("2020")
    unlocked = {x["code"] for x in a.rpc("get_my_achievements") if x["unlocked_at"]}
    assert "first_day_logged" in unlocked
    assert any(n["kind"] == "achievement_unlocked" for n in a.notifications())
    assert a.rest("POST", "user_achievements", json={"user_id": a.id, "code": "logged_100"}).status_code in (401, 403)

    # Private by default: B's feed has nothing of A's until A opts in.
    assert all(e["actor_id"] != a.id for e in b.rpc("get_activity_feed"))
    assert a.rest("POST", "social_settings", json={"share_activity": True},
                  headers={"Prefer": "resolution=merge-duplicates,return=representation"}).status_code in (200, 201)
    events = [e for e in b.rpc("get_activity_feed") if e["actor_id"] == a.id]
    assert events and all(set(e["payload"]) <= {"code", "title", "days", "challenge_id", "target_days"} for e in events)
    ev = events[0]["id"]

    # Reactions and comments, with notifications; no reacting to yourself; strangers locked out.
    b.rpc("set_reaction", p_event=ev, p_reaction="celebrate")
    b.rpc("set_reaction", p_event=ev, p_reaction="celebrate")
    [counts] = a.rpc("get_activity_interactions", p_events=[ev])
    assert counts["celebrate_count"] == 1
    assert a.rpc_error("set_reaction", p_event=ev, p_reaction="like") == "22023"
    comment = b.rpc("add_comment", p_event=ev, p_body="Well done!")
    kinds = [n["kind"] for n in a.notifications()]
    assert "reaction" in kinds and "comment" in kinds
    assert stranger.rpc_error("get_comments", p_event=ev) == "P0002"
    assert stranger.rpc_error("set_reaction", p_event=ev, p_reaction="like") == "P0002"
    assert stranger.rest("GET", f"activity_events?id=eq.{ev}").json() == []
    assert stranger.rpc_error("delete_comment", p_comment=comment) == "P0002"
    a.rpc("delete_comment", p_comment=comment)                       # the event owner may moderate

    # A challenge with a friend: invitation, joining, start reminder.
    tomorrow = (dt.date.fromisoformat(today) + dt.timedelta(days=1)).isoformat()
    challenge = a.rpc("start_challenge", p_template="walk-5-days", p_starts_on=tomorrow, p_invite=[b.id])
    assert stranger.rpc_error("start_challenge", p_template="walk-5-days", p_invite=[a.id]) == "22023"
    b.rpc("join_challenge", p_challenge=challenge)
    b_kinds = {n["kind"]: n for n in b.notifications()}
    assert b_kinds["challenge_invite"]["is_read"] is True and "challenge_starting" in b_kinds
    assert b.rest("PATCH", f"challenge_participants?challenge_id=eq.{challenge}",
                  json={"progress_days": 5}).status_code in (401, 403)

    # Preferences, read state, push registration; nothing readable that isn't yours.
    assert b.rest("POST", "notification_preferences", json={"reactions": False}).status_code == 201
    b.rpc("mark_notifications_read")
    assert b.rpc("get_unread_notification_count") == 0
    b.rpc("register_push_token", p_token="ExponentPushToken[p4" + uuid.uuid4().hex[:12] + "]", p_platform="android")
    assert len(b.rest("GET", "push_tokens?select=id").json()) == 1
    assert b.rest("GET", "push_outbox?select=id").status_code in (401, 403)
    assert stranger.rest("GET", "notifications?select=id").json() == []

    # Signed out: nothing.
    anon = httpx.post(f"{live['url']}/rest/v1/rpc/get_notifications", headers={"apikey": live["anon"]}, json={})
    assert anon.status_code in (401, 403)
