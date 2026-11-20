"""Writes catalogue records as the `catalogue_writer` role (migration 008).

Synchronous psycopg on purpose: it is used by the CLI and, from the API, via a
thread pool, which also avoids psycopg's async limitations on Windows event
loops. Every write goes through the foods table's constraints and quality
trigger, so the database remains the final validator.
"""

from __future__ import annotations

import json
from collections.abc import Iterable

import psycopg

from app.services.catalogue.records import FoodRecord

_FOOD_COLUMNS = (
    "name", "brand", "food_kind", "category", "cuisine_tags", "source", "source_ref", "source_version",
    "basis", "density_g_per_ml", "kcal_per_100", "protein_g_per_100", "carbs_g_per_100", "fat_g_per_100",
    "fiber_g_per_100", "sugars_g_per_100", "saturated_fat_g_per_100", "sodium_g_per_100", "salt_g_per_100",
    "micronutrients", "quality_flags", "verification",
)

_UPSERT_FOOD = f"""
insert into public.foods ({", ".join(_FOOD_COLUMNS)}, source_retrieved_at, is_active)
values ({", ".join(["%s"] * len(_FOOD_COLUMNS))}, now(), true)
on conflict (source, source_ref) where source_ref is not null do update set
  {", ".join(f"{c} = excluded.{c}" for c in _FOOD_COLUMNS if c not in ("source", "source_ref"))},
  source_retrieved_at = now(),
  is_active = true
returning id, (xmax = 0) as inserted
"""


def _food_params(rec: FoodRecord) -> tuple[object, ...]:
    return (
        rec.name, rec.brand, rec.food_kind, rec.category, rec.cuisine_tags, rec.source, rec.source_ref,
        rec.source_version, rec.basis, rec.density_g_per_ml, rec.kcal_per_100, rec.protein_g_per_100,
        rec.carbs_g_per_100, rec.fat_g_per_100, rec.fiber_g_per_100, rec.sugars_g_per_100,
        rec.saturated_fat_g_per_100, rec.sodium_g_per_100, rec.salt_g_per_100,
        json.dumps(rec.micronutrients) if rec.micronutrients else None,
        rec.quality_flags, rec.verification,
    )


def upsert_food(cur: psycopg.Cursor, rec: FoodRecord) -> tuple[str, bool]:
    """Inserts or refreshes one food with its aliases and servings.
    Returns (food_id, inserted)."""
    cur.execute(_UPSERT_FOOD, _food_params(rec))
    food_id, inserted = cur.fetchone()  # type: ignore[misc]

    # Re-sync this source's aliases and servings; others (e.g. curated) stay.
    alias_sources = sorted({a.source for a in rec.aliases} | {"indb_name", rec.source})
    cur.execute(
        "delete from public.food_aliases where food_id = %s and source = any(%s)",
        (food_id, alias_sources),
    )
    for alias in rec.aliases:
        cur.execute(
            "insert into public.food_aliases (food_id, alias, kind, source) values (%s, %s, %s, %s) "
            "on conflict (food_id, normalized_alias) do nothing",
            (food_id, alias.alias, alias.kind, alias.source),
        )

    cur.execute("delete from public.food_servings where food_id = %s and source = %s", (food_id, rec.source))
    for serving in rec.servings:
        cur.execute(
            "insert into public.food_servings (food_id, label, grams, ml, is_default, source) "
            "values (%s, %s, %s, %s, %s, %s) on conflict (food_id, label) do nothing",
            (food_id, serving.label, serving.grams, serving.ml, serving.is_default, serving.source),
        )
    return str(food_id), bool(inserted)


def write_records(database_url: str, records: Iterable[FoodRecord]) -> tuple[int, int]:
    """Upserts all records in one transaction. Returns (inserted, updated)."""
    inserted = updated = 0
    with psycopg.connect(database_url, autocommit=False) as conn:
        with conn.cursor() as cur:
            for rec in records:
                _, was_inserted = upsert_food(cur, rec)
                if was_inserted:
                    inserted += 1
                else:
                    updated += 1
        conn.commit()
    return inserted, updated
