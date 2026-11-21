"""Dietary preferences (migrations 011 and 018): user-entered, read and written
as the user through PostgREST (RLS: own row only). The assistant and the
recommendation engine read them; neither writes them, and nothing (allergies,
diet, medical conditions or anything else) is inferred from behaviour or
conversation.

Hard (filters): diet, allergies, excluded_ingredients, equipment.
Soft (ranking): dislikes, cuisines, preferred_meal_styles, max_prep_minutes.
Stored only: budget (the catalogue has no cost data), meal_preferences, notes."""

from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.security import AuthenticatedUser
from app.db.supabase import SupabaseRest

Diet = Literal["omnivore", "eggetarian", "vegetarian", "vegan", "pescatarian", "jain"]
Allergy = Literal["peanut", "tree_nut", "milk", "egg", "wheat_gluten", "soy", "fish", "shellfish", "sesame", "mustard"]
MealStyle = Literal["dal_rice", "roti_sabzi", "curry", "one_pot", "tiffin", "egg", "salad", "soup", "snack", "thali"]
Equipment = Literal["stove", "pressure_cooker", "tawa", "kadai", "oven", "microwave", "blender", "steamer", "air_fryer"]
Budget = Literal["low", "medium", "high"]

_COLUMNS = ("diet,allergies,dislikes,excluded_ingredients,cuisines,meal_preferences,preferred_meal_styles,"
            "max_prep_minutes,budget,equipment,notes,updated_at")


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
    dislikes: list[str] = Field(default_factory=list, max_length=20,
                                description="Ranked lower, not removed.")
    excluded_ingredients: list[str] = Field(default_factory=list, max_length=20,
                                            description="Never recommended (matched against names and ingredients).")
    cuisines: list[str] = Field(default_factory=list, max_length=10)
    meal_preferences: list[str] = Field(default_factory=list, max_length=10)
    preferred_meal_styles: list[MealStyle] = Field(default_factory=list, max_length=10)
    max_prep_minutes: int | None = Field(default=None, ge=5, le=240,
                                         description="Recipes taking longer rank lower.")
    budget: Budget | None = Field(default=None, description="Stored; not used for ranking (no cost data).")
    equipment: list[Equipment] | None = Field(
        default=None, description="null: not provided. A list: recipes needing anything else are not recommended.")
    notes: str | None = Field(default=None, max_length=300)

    @field_validator("preferred_meal_styles")
    @classmethod
    def _unique_styles(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(v))

    @field_validator("equipment")
    @classmethod
    def _unique_equipment(cls, v: list[str] | None) -> list[str] | None:
        return None if v is None else list(dict.fromkeys(v))

    @field_validator("excluded_ingredients")
    @classmethod
    def _excluded(cls, v: list[str]) -> list[str]:
        return _clean_list(v, 40)

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
    excluded_ingredients: list[str] = Field(default_factory=list)
    cuisines: list[str]
    meal_preferences: list[str]
    preferred_meal_styles: list[str] = Field(default_factory=list)
    max_prep_minutes: int | None = None
    budget: str | None = None
    equipment: list[str] | None = None
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


async def patch_preferences(db: SupabaseRest, user: AuthenticatedUser, changes: dict) -> PreferencesOut:
    """Partial update: only the given fields change (null clears an optional
    field, [] empties a list). Validated as a whole before saving."""
    current = await get_preferences(db, user)
    base = current.model_dump(include=set(PreferencesIn.model_fields)) if current else {}
    merged = PreferencesIn.model_validate({**base, **changes})
    return await put_preferences(db, user, merged)


async def delete_preferences(db: SupabaseRest, user: AuthenticatedUser) -> bool:
    deleted = await db.delete(user, "user_dietary_preferences", {"user_id": f"eq.{user.user_id}"})
    return bool(deleted)
