"""Open Food Facts import orchestration for the API.

Rate-limited per user (in-process sliding window: per server instance, which
is enough to stop casual abuse; a shared limiter belongs with the future
deployment's gateway).
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

import httpx
from starlette.concurrency import run_in_threadpool

from app.core.config import Settings
from app.core.security import AuthenticatedUser
from app.schemas.foods import ImportResult
from app.services.catalogue import off, writer


class ImportDisabled(Exception):
    pass


class RateLimited(Exception):
    pass


class _SlidingWindow:
    def __init__(self, limit: int, seconds: float) -> None:
        self.limit = limit
        self.seconds = seconds
        self._events: dict[str, deque[float]] = defaultdict(deque)

    def hit(self, key: str) -> bool:
        now = time.monotonic()
        events = self._events[key]
        while events and now - events[0] > self.seconds:
            events.popleft()
        if len(events) >= self.limit:
            return False
        events.append(now)
        return True


class OffImporter:
    def __init__(self, settings: Settings, http: httpx.AsyncClient) -> None:
        self._settings = settings
        self._http = http
        self._limiter = _SlidingWindow(settings.off_imports_per_user_per_hour, 3600)

    @property
    def enabled(self) -> bool:
        return self._settings.catalogue_database_url is not None

    async def import_barcode(self, user: AuthenticatedUser, barcode: str) -> ImportResult:
        if not self.enabled:
            raise ImportDisabled()
        if not off.BARCODE.match(barcode):
            raise off.RecordError("barcode must be 6-14 digits")
        if not self._limiter.hit(user.user_id):
            raise RateLimited()
        product = await off.fetch_product(
            self._http, self._settings.off_api_url, barcode, self._settings.upstream_timeout_seconds
        )
        record = off.map_product(product, barcode)
        url = self._settings.catalogue_database_url.get_secret_value()  # type: ignore[union-attr]
        food_id, created = await run_in_threadpool(_write_one, url, record)
        return ImportResult(food_id=food_id, name=record.name, brand=record.brand, created=created)


def _write_one(url: str, record: off.FoodRecord) -> tuple[str, bool]:
    import psycopg

    with psycopg.connect(url, autocommit=False) as conn:
        with conn.cursor() as cur:
            result = writer.upsert_food(cur, record)
        conn.commit()
    return result
