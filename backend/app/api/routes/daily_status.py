import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.deps import get_db
from app.core.security import AuthenticatedUser, get_current_user
from app.db.supabase import SupabaseRest
from app.schemas.daily_status import DailyStatusResponse
from app.services import daily_status as service

router = APIRouter(prefix="/v1/me", tags=["me"])


@router.get(
    "/daily-status",
    response_model=DailyStatusResponse,
    summary="The signed-in user's nutrition status for one day",
    responses={
        400: {"description": "No date given and the profile has no time zone yet"},
        401: {"description": "Missing, invalid or expired Supabase access token"},
        502: {"description": "The database returned an error"},
        503: {"description": "The database could not be reached"},
    },
)
async def read_daily_status(
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
    date: str | None = Query(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
        description="Local calendar date (YYYY-MM-DD). Defaults to today in the profile's time zone.",
        examples=["2026-11-20"],
    ),
) -> DailyStatusResponse:
    """The user is always the token's subject. There is deliberately no
    user-id parameter: any extra query parameter is ignored."""
    # A plain calendar date only: no time or offset, which would blur the
    # local-date semantics the database uses.
    try:
        local_date = dt.date.fromisoformat(date) if date else None
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="date must be a real YYYY-MM-DD date") from None
    try:
        return await service.get_daily_status(db, user, local_date)
    except service.DailyStatusError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=exc.message) from None
