"""Daily status: delegates to get_daily_status() in Postgres.

No nutrition maths here. Targets, sums and remaining amounts are computed by
the database function (one implementation shared with the app), which runs as
the calling user (SECURITY INVOKER + RLS).
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from app.core.security import AuthenticatedUser
from app.db.supabase import DatabaseError, SupabaseRest
from app.schemas.daily_status import Consumed, DailyStatusResponse, MacroSplit, Remaining, Targets


class DailyStatusError(Exception):
    """A request the database rejected as invalid (e.g. no date and no time zone)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _to_response(row: dict[str, Any]) -> DailyStatusResponse:
    has_targets = row.get("target_kcal") is not None
    return DailyStatusResponse(
        date=row["status_date"],
        targets=Targets(
            kcal=row["target_kcal"],
            carbs_g=row["target_carbs_g"],
            fat_g=row["target_fat_g"],
            protein_g=row["target_protein_g"],
            macro_split=MacroSplit(
                carb_pct=row["macro_carb_pct"],
                fat_pct=row["macro_fat_pct"],
                protein_pct=row["macro_protein_pct"],
            ),
        )
        if has_targets
        else None,
        consumed=Consumed(
            kcal=row["consumed_kcal"],
            carbs_g=row["consumed_carbs_g"],
            fat_g=row["consumed_fat_g"],
            protein_g=row["consumed_protein_g"],
            entry_count=row["entry_count"],
        ),
        remaining=Remaining(
            kcal=row["remaining_kcal"],
            carbs_g=row["remaining_carbs_g"],
            fat_g=row["remaining_fat_g"],
            protein_g=row["remaining_protein_g"],
        )
        if has_targets
        else None,
    )


async def get_daily_status(
    db: SupabaseRest, user: AuthenticatedUser, date: dt.date | None
) -> DailyStatusResponse:
    """`date` is the user's local calendar date. When omitted, the database uses
    "today" in the time zone stored on the user's profile."""
    params = {"p_date": date.isoformat() if date else None}
    try:
        rows = await db.rpc(user, "get_daily_status", params)
    except DatabaseError as exc:
        if exc.code == "22023":
            # The function's own, user-facing validation message.
            raise DailyStatusError("A date is required until your profile has a time zone.") from exc
        raise
    if not isinstance(rows, list) or len(rows) != 1:
        raise DatabaseError(502, None, "get_daily_status returned an unexpected shape")
    return _to_response(rows[0])
