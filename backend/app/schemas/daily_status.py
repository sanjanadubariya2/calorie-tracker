"""Response schema for GET /v1/me/daily-status.

Mirrors get_daily_status() (supabase/migrations/005_nutrition_targets.sql).
All arithmetic happens in Postgres; this layer only reshapes the row.
"""

from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict, Field


class MacroSplit(BaseModel):
    carb_pct: int = Field(ge=10, le=70)
    fat_pct: int = Field(ge=10, le=70)
    protein_pct: int = Field(ge=10, le=70)


class Targets(BaseModel):
    kcal: int
    carbs_g: int
    fat_g: int
    protein_g: int
    macro_split: MacroSplit


class Consumed(BaseModel):
    kcal: float
    carbs_g: float
    fat_g: float
    protein_g: float
    entry_count: int = Field(ge=0)


class Remaining(BaseModel):
    """Target minus consumed. Negative values mean over target."""

    kcal: float
    carbs_g: float
    fat_g: float
    protein_g: float


class DailyStatusResponse(BaseModel):
    model_config = ConfigDict(json_schema_extra={
        "example": {
            "date": "2026-11-20",
            "targets": {"kcal": 2759, "carbs_g": 276, "fat_g": 92, "protein_g": 207,
                        "macro_split": {"carb_pct": 40, "fat_pct": 30, "protein_pct": 30}},
            "consumed": {"kcal": 1470, "carbs_g": 98.0, "fat_g": 40.0, "protein_g": 34.3, "entry_count": 3},
            "remaining": {"kcal": 1289, "carbs_g": 178.0, "fat_g": 52.0, "protein_g": 172.7},
        }
    })

    date: dt.date
    targets: Targets | None = Field(description="Null until the user has created a profile.")
    consumed: Consumed
    remaining: Remaining | None = Field(description="Null when there are no targets.")
