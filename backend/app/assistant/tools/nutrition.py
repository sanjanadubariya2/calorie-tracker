"""Nutrition tools: daily status, targets, recent logs, history aggregates.

All numbers come from the database (get_daily_status / get_daily_totals /
food_logs as the user). Nothing here estimates or fills in values.
"""

from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.assistant.preferences import PreferencesOut, get_preferences
from app.assistant.tools.base import Tool, ToolArgumentError, ToolContext, clean_text
from app.schemas.daily_status import DailyStatusResponse
from app.services.daily_status import DailyStatusError, get_daily_status

MealType = Literal["breakfast", "lunch", "dinner", "morning_snack", "afternoon_snack", "evening_snack"]

MAX_LOOKBACK_DAYS = 400
MAX_LOG_RANGE_DAYS = 31
MAX_HISTORY_RANGE_DAYS = 90
MAX_DAILY_PERIODS = 31


def _r1(v: float | None) -> float | None:
    return None if v is None else round(float(v), 1)


def _check_date(ctx: ToolContext, d: dt.date, label: str) -> None:
    if d > ctx.today + dt.timedelta(days=1):
        raise ToolArgumentError(f"{label} can't be in the future.")
    if d < ctx.today - dt.timedelta(days=MAX_LOOKBACK_DAYS):
        raise ToolArgumentError(f"{label} must be within the last {MAX_LOOKBACK_DAYS} days.")


def _range(ctx: ToolContext, start: dt.date | None, end: dt.date | None, default_days: int, max_days: int) -> tuple[dt.date, dt.date]:
    end = end or ctx.today
    start = start or end - dt.timedelta(days=default_days - 1)
    _check_date(ctx, start, "start_date")
    _check_date(ctx, end, "end_date")
    if start > end:
        raise ToolArgumentError("start_date must be on or before end_date.")
    if (end - start).days + 1 > max_days:
        raise ToolArgumentError(f"The date range can be at most {max_days} days.")
    return start, end


async def _status(ctx: ToolContext, date: dt.date | None) -> DailyStatusResponse:
    """A specific date, else "today": the app's local date, else the profile's
    time zone (database), else UTC."""
    target = date or ctx.local_date
    try:
        return await get_daily_status(ctx.db, ctx.user, target)
    except DailyStatusError:
        return await get_daily_status(ctx.db, ctx.user, ctx.today)


# ============================================================================ get_daily_status

class DailyStatusArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: dt.date | None = Field(default=None, description="YYYY-MM-DD. Omit for today.")


class NutrientStatus(BaseModel):
    consumed: float
    target: float | None
    remaining: float | None


class DailyStatusResult(BaseModel):
    date: dt.date
    has_targets: bool
    calories_kcal: NutrientStatus
    protein_g: NutrientStatus
    carbs_g: NutrientStatus
    fat_g: NutrientStatus
    entries_logged: int
    data_source: Literal["food_log"] = "food_log"


async def run_daily_status(ctx: ToolContext, args: DailyStatusArgs) -> DailyStatusResult:
    if args.date is not None:
        _check_date(ctx, args.date, "date")
    s = await _status(ctx, args.date)
    t, c, r = s.targets, s.consumed, s.remaining

    def n(consumed: float, target: float | None, remaining: float | None) -> NutrientStatus:
        return NutrientStatus(consumed=_r1(consumed) or 0.0, target=_r1(target), remaining=_r1(remaining))

    return DailyStatusResult(
        date=s.date, has_targets=t is not None,
        calories_kcal=n(c.kcal, t.kcal if t else None, r.kcal if r else None),
        protein_g=n(c.protein_g, t.protein_g if t else None, r.protein_g if r else None),
        carbs_g=n(c.carbs_g, t.carbs_g if t else None, r.carbs_g if r else None),
        fat_g=n(c.fat_g, t.fat_g if t else None, r.fat_g if r else None),
        entries_logged=c.entry_count,
    )


GET_DAILY_STATUS = Tool(
    name="get_daily_status",
    description=("Calories, protein, carbs and fat the signed-in user has logged on a day (today by default), "
                 "with their daily targets and what remains. Use for any question about today's or a specific "
                 "day's intake or what's left."),
    args=DailyStatusArgs, result=DailyStatusResult, run=run_daily_status, supports=("nutrition_summary",),
)


# ============================================================================ get_user_targets

class UserTargetsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Targets(BaseModel):
    calories_kcal: int
    protein_g: int
    carbs_g: int
    fat_g: int
    carb_pct: int
    fat_pct: int
    protein_pct: int


class UserTargetsResult(BaseModel):
    has_targets: bool
    daily_targets: Targets | None
    goal: Literal["lose", "maintain", "gain"] | None
    activity_level: str | None
    preferences: PreferencesOut | None
    notes: list[str]


async def run_user_targets(ctx: ToolContext, _: UserTargetsArgs) -> UserTargetsResult:
    s = await _status(ctx, None)
    profile = await ctx.db.select(ctx.user, "profiles", {"select": "goal,activity_level", "limit": "1"})
    prefs = await get_preferences(ctx.db, ctx.user)
    t = s.targets
    notes = []
    if t is None:
        notes.append("No profile targets are set yet.")
    if prefs is None:
        notes.append("The user hasn't entered dietary preferences.")
    return UserTargetsResult(
        has_targets=t is not None,
        daily_targets=Targets(
            calories_kcal=t.kcal, protein_g=t.protein_g, carbs_g=t.carbs_g, fat_g=t.fat_g,
            carb_pct=t.macro_split.carb_pct, fat_pct=t.macro_split.fat_pct, protein_pct=t.macro_split.protein_pct,
        ) if t else None,
        goal=profile[0].get("goal") if profile else None,
        activity_level=profile[0].get("activity_level") if profile else None,
        preferences=prefs, notes=notes,
    )


GET_USER_TARGETS = Tool(
    name="get_user_targets",
    description=("The user's configured daily calorie and macro targets, goal, activity level and the dietary "
                 "preferences they entered themselves (diet, allergies, dislikes, cuisines)."),
    args=UserTargetsArgs, result=UserTargetsResult, run=run_user_targets, supports=("nutrition_summary",),
)


# ============================================================================ get_recent_food_logs

class RecentLogsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_date: dt.date | None = Field(default=None, description="YYYY-MM-DD. Default: 7 days before end_date.")
    end_date: dt.date | None = Field(default=None, description="YYYY-MM-DD. Default: today.")
    meal_type: MealType | None = None
    limit: int = Field(default=20, ge=1, le=50)


class LogEntry(BaseModel):
    date: dt.date
    meal_type: str
    food_name: str
    calories_kcal: float
    protein_g: float
    carbs_g: float
    fat_g: float
    serving_g: float | None
    source: str | None


class RecentLogsResult(BaseModel):
    start_date: dt.date
    end_date: dt.date
    meal_type: str | None
    entries: list[LogEntry]
    returned: int
    more_available: bool


async def run_recent_logs(ctx: ToolContext, args: RecentLogsArgs) -> RecentLogsResult:
    start, end = _range(ctx, args.start_date, args.end_date, default_days=7, max_days=MAX_LOG_RANGE_DAYS)
    params = {
        "select": "logged_date,meal_type,food_name,calories,protein_g,carbs_g,fat_g,serving_g,source",
        # RLS already limits rows to the caller; the explicit filter is defence in depth.
        "user_id": f"eq.{ctx.user.user_id}",
        "and": f"(logged_date.gte.{start.isoformat()},logged_date.lte.{end.isoformat()})",
        "order": "logged_date.desc,created_at.desc",
        "limit": str(args.limit + 1),
    }
    if args.meal_type:
        params["meal_type"] = f"eq.{args.meal_type}"
    rows = await ctx.db.select(ctx.user, "food_logs", params)
    entries = [
        LogEntry(
            date=r["logged_date"], meal_type=r["meal_type"], food_name=clean_text(r["food_name"]) or "",
            calories_kcal=_r1(r["calories"]) or 0.0, protein_g=_r1(r["protein_g"]) or 0.0,
            carbs_g=_r1(r["carbs_g"]) or 0.0, fat_g=_r1(r["fat_g"]) or 0.0,
            serving_g=_r1(r.get("serving_g")), source=r.get("source"),
        )
        for r in rows[: args.limit]
    ]
    return RecentLogsResult(start_date=start, end_date=end, meal_type=args.meal_type, entries=entries,
                            returned=len(entries), more_available=len(rows) > args.limit)


GET_RECENT_FOOD_LOGS = Tool(
    name="get_recent_food_logs",
    description=("Individual foods the user logged in a date range (at most 31 days, default the last 7 days), "
                 "newest first, optionally for one meal type. Use only when specific foods matter; for totals "
                 "and trends use get_nutrition_history."),
    args=RecentLogsArgs, result=RecentLogsResult, run=run_recent_logs,
)


# ============================================================================ get_nutrition_history

class HistoryArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start_date: dt.date | None = Field(default=None, description="YYYY-MM-DD. Default: 7 days before end_date.")
    end_date: dt.date | None = Field(default=None, description="YYYY-MM-DD. Default: today.")
    group_by: Literal["day", "week"] = "day"


class Period(BaseModel):
    start: dt.date
    end: dt.date
    days: int
    days_logged: int
    entries: int
    total_kcal: float
    avg_kcal_per_logged_day: float | None
    avg_protein_g: float | None
    avg_carbs_g: float | None
    avg_fat_g: float | None


class DayPoint(BaseModel):
    date: dt.date
    kcal: float


class HistoryOverall(BaseModel):
    days_in_range: int
    days_logged: int
    avg_kcal_per_logged_day: float | None
    avg_protein_g: float | None
    avg_carbs_g: float | None
    avg_fat_g: float | None
    current_target_kcal: int | None
    logged_days_within_10pct_of_target: int | None
    highest_day: DayPoint | None
    lowest_day: DayPoint | None


class HistoryResult(BaseModel):
    start_date: dt.date
    end_date: dt.date
    group_by: Literal["day", "week"]
    periods: list[Period]
    overall: HistoryOverall
    notes: list[str]


def _avg(total: float, n: int) -> float | None:
    return round(total / n, 1) if n else None


def _period(start: dt.date, end: dt.date, days: dict[dt.date, dict[str, float]]) -> Period:
    inside = [v for d, v in days.items() if start <= d <= end]
    n = len(inside)
    total = sum(v["kcal"] for v in inside)
    return Period(
        start=start, end=end, days=(end - start).days + 1, days_logged=n, entries=int(sum(v["entries"] for v in inside)),
        total_kcal=round(total, 1), avg_kcal_per_logged_day=_avg(total, n),
        avg_protein_g=_avg(sum(v["protein"] for v in inside), n), avg_carbs_g=_avg(sum(v["carbs"] for v in inside), n),
        avg_fat_g=_avg(sum(v["fat"] for v in inside), n),
    )


async def run_history(ctx: ToolContext, args: HistoryArgs) -> HistoryResult:
    start, end = _range(ctx, args.start_date, args.end_date, default_days=7, max_days=MAX_HISTORY_RANGE_DAYS)
    rows = await ctx.db.rpc(ctx.user, "get_daily_totals", {"p_start": start.isoformat(), "p_end": end.isoformat()})
    days: dict[dt.date, dict[str, float]] = {}
    for r in rows or []:
        d = dt.date.fromisoformat(str(r["logged_date"]))
        acc = days.setdefault(d, {"kcal": 0.0, "protein": 0.0, "carbs": 0.0, "fat": 0.0, "entries": 0.0})
        acc["kcal"] += float(r["calories"] or 0)
        acc["protein"] += float(r["protein_g"] or 0)
        acc["carbs"] += float(r["carbs_g"] or 0)
        acc["fat"] += float(r["fat_g"] or 0)
        acc["entries"] += float(r["entry_count"] or 0)

    notes = ["Averages are over days with at least one log entry."]
    group_by = args.group_by
    if group_by == "day" and (end - start).days + 1 > MAX_DAILY_PERIODS:
        group_by = "week"
        notes.append(f"Grouped by week because the range is longer than {MAX_DAILY_PERIODS} days.")

    periods: list[Period] = []
    cursor = start
    step = dt.timedelta(days=1 if group_by == "day" else 7)
    while cursor <= end:
        p_end = min(end, cursor + step - dt.timedelta(days=1))
        periods.append(_period(cursor, p_end, days))
        cursor = p_end + dt.timedelta(days=1)

    status = await _status(ctx, None)
    target = status.targets.kcal if status.targets else None
    within = None
    if target:
        within = sum(1 for v in days.values() if abs(v["kcal"] - target) <= 0.1 * target)
        notes.append("The target comparison uses the current target; past targets may have differed.")
    n = len(days)
    hi = max(days.items(), key=lambda kv: (kv[1]["kcal"], kv[0])) if days else None
    lo = min(days.items(), key=lambda kv: (kv[1]["kcal"], kv[0])) if days else None
    overall = HistoryOverall(
        days_in_range=(end - start).days + 1, days_logged=n,
        avg_kcal_per_logged_day=_avg(sum(v["kcal"] for v in days.values()), n),
        avg_protein_g=_avg(sum(v["protein"] for v in days.values()), n),
        avg_carbs_g=_avg(sum(v["carbs"] for v in days.values()), n),
        avg_fat_g=_avg(sum(v["fat"] for v in days.values()), n),
        current_target_kcal=target, logged_days_within_10pct_of_target=within,
        highest_day=DayPoint(date=hi[0], kcal=round(hi[1]["kcal"], 1)) if hi else None,
        lowest_day=DayPoint(date=lo[0], kcal=round(lo[1]["kcal"], 1)) if lo else None,
    )
    return HistoryResult(start_date=start, end_date=end, group_by=group_by, periods=periods, overall=overall, notes=notes)


GET_NUTRITION_HISTORY = Tool(
    name="get_nutrition_history",
    description=("Aggregated calories and macros over a period (at most 90 days, default the last 7 days), "
                 "per day or per week, with averages, days logged and how many days were near the target. "
                 "Use for trends and 'how have I been doing' questions."),
    args=HistoryArgs, result=HistoryResult, run=run_history, supports=("nutrition_summary",),
)
