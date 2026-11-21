"""Expo push delivery for the notification outbox (migration 026).

The database decides what may be pushed (opt-in, kind, preferences, blocks,
20 a day) and queues it in ``push_outbox``. This worker only moves queued
messages to Expo's push service and records what happened:

* tickets: ``ok`` -> sent; ``DeviceNotRegistered`` -> the device token is
  disabled; other errors and transport failures -> retried with backoff by
  the database (up to 5 attempts).
* receipts (checked 15 minutes to 24 hours after sending): a failed receipt
  marks the push failed, and ``DeviceNotRegistered`` disables the token.

It connects as the ``notification_sender`` role, which can call only the
claim/record functions; it can't read any table. Message text is built by the
database and never contains comment text or health data.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

log = logging.getLogger(__name__)

EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send"
EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"
SEND_CHUNK = 100       # Expo's limit per request
RECEIPT_CHUNK = 300    # ditto for receipts


class PushStore(Protocol):
    def claim(self, limit: int) -> list[dict[str, Any]]: ...
    def record_result(self, outbox_id: str, ok: bool, ticket: str | None, error: str | None) -> None: ...
    def pending_receipts(self, limit: int) -> list[dict[str, Any]]: ...
    def record_receipt(self, outbox_id: str, ok: bool, error: str | None) -> None: ...
    def enqueue_reminders(self) -> int: ...


@dataclass
class DeliveryReport:
    sent: int = 0
    failed: int = 0
    retried: int = 0
    receipts_ok: int = 0
    receipts_failed: int = 0
    reminders: int = 0
    errors: dict[str, int] = field(default_factory=dict)

    def count_error(self, code: str) -> None:
        self.errors[code] = self.errors.get(code, 0) + 1


class PostgresPushStore:
    """Calls the 026 worker functions as notification_sender (PUSH_DATABASE_URL)."""

    def __init__(self, url: str) -> None:
        self._url = url

    def _call(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        import psycopg
        from psycopg.rows import dict_row

        with psycopg.connect(self._url, connect_timeout=10, row_factory=dict_row, prepare_threshold=None) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall() if cur.description else []
            conn.commit()
        return [dict(r) for r in rows]

    def claim(self, limit: int) -> list[dict[str, Any]]:
        return self._call("select * from public.claim_push_batch(%s)", (limit,))

    def record_result(self, outbox_id: str, ok: bool, ticket: str | None, error: str | None) -> None:
        self._call("select public.record_push_result(%s, %s, %s, %s)", (outbox_id, ok, ticket, error))

    def pending_receipts(self, limit: int) -> list[dict[str, Any]]:
        return self._call("select * from public.pending_push_receipts(%s)", (limit,))

    def record_receipt(self, outbox_id: str, ok: bool, error: str | None) -> None:
        self._call("select public.record_push_receipt(%s, %s, %s)", (outbox_id, ok, error))

    def enqueue_reminders(self) -> int:
        rows = self._call("select public.enqueue_challenge_reminders() as n")
        return int(rows[0]["n"]) if rows else 0

    def health(self) -> dict[str, Any]:
        rows = self._call("select * from public.push_health()")
        return rows[0] if rows else {}


def purge_social_data(url: str, dry_run: bool) -> list[tuple[str, int]]:
    """Retention (migration 027), as the social_maintainer role."""
    import psycopg

    with psycopg.connect(url, connect_timeout=10, prepare_threshold=None) as conn:
        rows = conn.execute("select item, affected from public.purge_social_data(%s)", (dry_run,)).fetchall()
        conn.commit()
    return [(str(r[0]), int(r[1])) for r in rows]


@dataclass(frozen=True)
class HealthLimits:
    max_pending_minutes: int = 15      # the oldest queued push should go out within this
    max_stuck_sending: int = 0         # claimed but never recorded (a crashed worker)
    max_failed_24h: int = 50
    max_disabled_24h: int = 100        # a spike usually means bad credentials or a broken build


def evaluate_health(h: dict[str, Any], limits: HealthLimits = HealthLimits()) -> list[str]:
    """Problems in a push_health() row; empty when healthy."""
    problems = []
    if int(h.get("oldest_pending_minutes") or 0) > limits.max_pending_minutes:
        problems.append(f"oldest pending push is {h['oldest_pending_minutes']} min old (limit {limits.max_pending_minutes})")
    if int(h.get("stuck_sending") or 0) > limits.max_stuck_sending:
        problems.append(f"{h['stuck_sending']} push(es) stuck in 'sending'")
    if int(h.get("failed_24h") or 0) > limits.max_failed_24h:
        problems.append(f"{h['failed_24h']} failed pushes in 24 h (limit {limits.max_failed_24h})")
    if int(h.get("devices_disabled_24h") or 0) > limits.max_disabled_24h:
        problems.append(f"{h['devices_disabled_24h']} devices disabled in 24 h (limit {limits.max_disabled_24h})")
    return problems


def _headers(access_token: str | None) -> dict[str, str]:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if access_token:   # Expo "enhanced push security"
        headers["Authorization"] = f"Bearer {access_token}"
    return headers


def _error_code(item: dict[str, Any]) -> str:
    details = item.get("details") or {}
    return str(details.get("error") or item.get("message") or "Unknown")[:200]


def deliver(store: PushStore, http: httpx.Client, *, access_token: str | None = None, max_batches: int = 10,
            report: DeliveryReport | None = None) -> DeliveryReport:
    report = report or DeliveryReport()
    for _ in range(max_batches):
        batch = store.claim(SEND_CHUNK)
        if not batch:
            break
        messages = [{"to": r["token"], "title": r["title"], "body": r["body"], "data": r.get("data") or {},
                     "sound": "default", "priority": "default"} for r in batch]
        try:
            response = http.post(EXPO_SEND_URL, json=messages, headers=_headers(access_token))
        except httpx.HTTPError as e:
            log.warning("push send transport error: %s", type(e).__name__)
            for r in batch:
                store.record_result(str(r["outbox_id"]), False, None, "TransportError")
                report.retried += 1
            report.count_error("TransportError")
            continue
        if response.status_code != 200:
            code = f"HTTP_{response.status_code}"
            for r in batch:
                store.record_result(str(r["outbox_id"]), False, None, code)
                report.retried += 1
            report.count_error(code)
            continue
        tickets = (response.json() or {}).get("data") or []
        for i, r in enumerate(batch):
            ticket = tickets[i] if i < len(tickets) and isinstance(tickets[i], dict) else {"status": "error",
                                                                                         "message": "MissingTicket"}
            if ticket.get("status") == "ok":
                store.record_result(str(r["outbox_id"]), True, str(ticket.get("id") or "")[:100] or None, None)
                report.sent += 1
            else:
                code = _error_code(ticket)
                store.record_result(str(r["outbox_id"]), False, None, code)
                report.count_error(code)
                if code == "DeviceNotRegistered":
                    report.failed += 1
                else:
                    report.retried += 1
    return report


def check_receipts(store: PushStore, http: httpx.Client, *, access_token: str | None = None,
                   report: DeliveryReport | None = None) -> DeliveryReport:
    report = report or DeliveryReport()
    pending = store.pending_receipts(1000)
    for start in range(0, len(pending), RECEIPT_CHUNK):
        chunk = pending[start:start + RECEIPT_CHUNK]
        by_ticket = {str(r["ticket_id"]): str(r["outbox_id"]) for r in chunk}
        try:
            response = http.post(EXPO_RECEIPTS_URL, json={"ids": list(by_ticket)}, headers=_headers(access_token))
        except httpx.HTTPError as e:
            log.warning("push receipts transport error: %s", type(e).__name__)
            report.count_error("TransportError")
            continue
        if response.status_code != 200:
            report.count_error(f"HTTP_{response.status_code}")
            continue
        receipts = (response.json() or {}).get("data") or {}
        for ticket_id, outbox_id in by_ticket.items():
            receipt = receipts.get(ticket_id)
            if receipt is None:
                continue                      # not ready yet; tried again next run
            if receipt.get("status") == "ok":
                store.record_receipt(outbox_id, True, None)
                report.receipts_ok += 1
            else:
                code = _error_code(receipt)
                store.record_receipt(outbox_id, False, code)
                report.receipts_failed += 1
                report.count_error(code)
    return report
