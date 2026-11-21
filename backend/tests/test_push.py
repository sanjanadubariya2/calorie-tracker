"""Push delivery worker: tickets, receipts, failures (Expo mocked; DB side in 026 pgTAP)."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from app.services import push


class FakeStore:
    def __init__(self, batches: list[list[dict[str, Any]]], receipts: list[dict[str, Any]] | None = None) -> None:
        self.batches = batches
        self.results: list[tuple[str, bool, str | None, str | None]] = []
        self.receipt_rows = receipts or []
        self.receipts: list[tuple[str, bool, str | None]] = []

    def claim(self, limit: int) -> list[dict[str, Any]]:
        assert limit == push.SEND_CHUNK
        return self.batches.pop(0) if self.batches else []

    def record_result(self, outbox_id: str, ok: bool, ticket: str | None, error: str | None) -> None:
        self.results.append((outbox_id, ok, ticket, error))

    def pending_receipts(self, limit: int) -> list[dict[str, Any]]:
        return self.receipt_rows

    def record_receipt(self, outbox_id: str, ok: bool, error: str | None) -> None:
        self.receipts.append((outbox_id, ok, error))

    def enqueue_reminders(self) -> int:
        return 0


def row(i: int) -> dict[str, Any]:
    return {"outbox_id": f"o{i}", "token": f"ExponentPushToken[tok{i:08d}]", "title": "New friend request",
            "body": "@a wants to be friends.", "data": {"kind": "friend_request", "notification_id": f"n{i}"}}


def client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_sends_tickets_and_records_each_outcome() -> None:
    sent: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == push.EXPO_SEND_URL
        assert request.headers["authorization"] == "Bearer secret"
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"data": [
            {"status": "ok", "id": "t1"},
            {"status": "error", "message": "gone", "details": {"error": "DeviceNotRegistered"}},
            {"status": "error", "message": "slow down", "details": {"error": "MessageRateExceeded"}},
        ]})

    store = FakeStore([[row(1), row(2), row(3)]])
    report = push.deliver(store, client(handler), access_token="secret")
    assert sent[0][0] == {"to": "ExponentPushToken[tok00000001]", "title": "New friend request",
                          "body": "@a wants to be friends.", "data": {"kind": "friend_request", "notification_id": "n1"},
                          "sound": "default", "priority": "default"}
    assert store.results == [("o1", True, "t1", None), ("o2", False, None, "DeviceNotRegistered"),
                             ("o3", False, None, "MessageRateExceeded")]
    assert (report.sent, report.failed, report.retried) == (1, 1, 1)


@pytest.mark.parametrize("status", [429, 500, 503])
def test_http_errors_are_recorded_for_retry(status: int) -> None:
    store = FakeStore([[row(1), row(2)]])
    report = push.deliver(store, client(lambda r: httpx.Response(status)))
    assert store.results == [("o1", False, None, f"HTTP_{status}"), ("o2", False, None, f"HTTP_{status}")]
    assert report.retried == 2 and report.sent == 0


def test_transport_failure_does_not_crash_and_is_retried() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    store = FakeStore([[row(1)]])
    report = push.deliver(store, client(handler))
    assert store.results == [("o1", False, None, "TransportError")]
    assert report.errors == {"TransportError": 1}


def test_missing_tickets_are_treated_as_errors() -> None:
    store = FakeStore([[row(1), row(2)]])
    push.deliver(store, client(lambda r: httpx.Response(200, json={"data": [{"status": "ok", "id": "t1"}]})))
    assert store.results[1] == ("o2", False, None, "MissingTicket")


def test_stops_when_the_queue_is_empty_and_caps_batches() -> None:
    store = FakeStore([[row(i)] for i in range(20)])
    calls = []
    push.deliver(store, client(lambda r: calls.append(1) or httpx.Response(200, json={"data": [{"status": "ok", "id": "t"}]})),
                 max_batches=3)
    assert len(calls) == 3
    assert push.deliver(FakeStore([]), client(lambda r: pytest.fail("no request expected"))).sent == 0


def test_receipts_disable_dead_devices_and_skip_unready_tickets() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == push.EXPO_RECEIPTS_URL
        assert json.loads(request.content) == {"ids": ["t1", "t2", "t3"]}
        return httpx.Response(200, json={"data": {
            "t1": {"status": "ok"},
            "t2": {"status": "error", "message": "x", "details": {"error": "DeviceNotRegistered"}},
        }})

    store = FakeStore([], receipts=[{"outbox_id": "o1", "ticket_id": "t1"}, {"outbox_id": "o2", "ticket_id": "t2"},
                                    {"outbox_id": "o3", "ticket_id": "t3"}])
    report = push.check_receipts(store, client(handler))
    assert store.receipts == [("o1", True, None), ("o2", False, "DeviceNotRegistered")]
    assert (report.receipts_ok, report.receipts_failed) == (1, 1)


def test_no_authorization_header_without_an_access_token() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "authorization" not in request.headers
        return httpx.Response(200, json={"data": [{"status": "ok", "id": "t"}]})

    push.deliver(FakeStore([[row(1)]]), client(handler))


def test_health_is_ok_when_quiet_and_flags_each_problem() -> None:
    quiet = {"pending": 0, "oldest_pending_minutes": 0, "stuck_sending": 0, "failed_24h": 0, "devices_disabled_24h": 0}
    assert push.evaluate_health(quiet) == []
    bad = {**quiet, "oldest_pending_minutes": 40, "stuck_sending": 2, "failed_24h": 51, "devices_disabled_24h": 101}
    problems = push.evaluate_health(bad)
    assert len(problems) == 4 and "40 min" in problems[0] and "stuck" in problems[1]
    assert push.evaluate_health(bad, push.HealthLimits(max_pending_minutes=60, max_stuck_sending=5, max_failed_24h=100,
                                                       max_disabled_24h=500)) == []
