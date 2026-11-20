"""Dietary preferences (migration 011): user-entered, read and written as the
user through PostgREST (RLS: own row only). The assistant reads them; it never
writes them, and nothing is inferred from conversation."""

from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.security import AuthenticatedUser
from app.db.supabase import SupabaseRest

Diet = Literal["omnivore", "eggetarian", "vegetarian", "vegan", "pescatarian", "jain"]
Allergy = Literal["peanut", "tree_nut", "milk", "egg", "wheat_gluten", "soy", "fish", "shellfish", "sesame", "mustard"]

_COLUMNS = "diet,allergies,dislikes,cuisines,meal_preferences,notes,updated_at"


def _clean_list(values: list[str], max_len: int) -> list[str]:
    seen: list[str] = []
    for v in values:
        v = " ".join(v.split())
        if not v:
            continue
        if len(v) > max_len:
            raise ValueError(f"each item must be at most {max_len} characters")
        if v.lower() not in (s.lower() for s in seen):
            seen.append(v)
    return seen


class PreferencesIn(BaseModel):
    """PUT /v1/me/preferences: the full set (replaces what was stored)."""

    model_config = ConfigDict(extra="forbid")

    diet: Diet | None = None
    allergies: list[Allergy] = Field(default_factory=list, max_length=10)
    dislikes: list[str] = Field(default_factory=list, max_length=20)
    cuisines: list[str] = Field(default_factory=list, max_length=10)
    meal_preferences: list[str] = Field(default_factory=list, max_length=10)
    notes: str | None = Field(default=None, max_length=300)

    @field_validator("allergies")
    @classmethod
    def _unique_allergies(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(v))

    @field_validator("dislikes")
    @classmethod
    def _dislikes(cls, v: list[str]) -> list[str]:
        return _clean_list(v, 40)

    @field_validator("cuisines")
    @classmethod
    def _cuisines(cls, v: list[str]) -> list[str]:
        return _clean_list(v, 40)

    @field_validator("meal_preferences")
    @classmethod
    def _meal_prefs(cls, v: list[str]) -> list[str]:
        return _clean_list(v, 80)

    @field_validator("notes")
    @classmethod
    def _notes(cls, v: str | None) -> str | None:
        v = " ".join(v.split()) if v else None
        return v or None


class PreferencesOut(BaseModel):
    diet: Diet | None
    allergies: list[str]
    dislikes: list[str]
    cuisines: list[str]
    meal_preferences: list[str]
    notes: str | None
    updated_at: dt.datetime | None = None
    source: Literal["user_entered"] = "user_entered"


async def get_preferences(db: SupabaseRest, user: AuthenticatedUser) -> PreferencesOut | None:
    rows = await db.select(user, "user_dietary_preferences", {"select": _COLUMNS, "limit": "1"})
    return PreferencesOut.model_validate(rows[0]) if rows else None


async def put_preferences(db: SupabaseRest, user: AuthenticatedUser, prefs: PreferencesIn) -> PreferencesOut:
    row = await db.upsert(user, "user_dietary_preferences", {"user_id": user.user_id, **prefs.model_dump()},
                          on_conflict="user_id", select=_COLUMNS)
    return PreferencesOut.model_validate(row)


async def delete_preferences(db: SupabaseRest, user: AuthenticatedUser) -> bool:
    deleted = await db.delete(user, "user_dietary_preferences", {"user_id": f"eq.{user.user_id}"})
    return bool(deleted)
