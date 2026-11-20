"""In-memory form of a catalogue food, independent of where it came from."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class AliasRecord:
    alias: str
    kind: str          # food_aliases.kind
    source: str        # 'indb_name', 'curated', 'open_food_facts'


@dataclass(frozen=True)
class ServingRecord:
    label: str
    grams: float
    is_default: bool
    source: str
    ml: float | None = None


@dataclass
class FoodRecord:
    name: str
    source: str                      # foods.source
    source_ref: str
    # None = let the database derive it from macros (flag kcal_derived).
    kcal_per_100: float | None
    protein_g_per_100: float
    carbs_g_per_100: float
    fat_g_per_100: float
    brand: str | None = None
    food_kind: str = "generic_dish"
    category: str | None = None
    cuisine_tags: list[str] = field(default_factory=list)
    source_version: str | None = None
    basis: str = "g"
    density_g_per_ml: float | None = None
    fiber_g_per_100: float | None = None
    sugars_g_per_100: float | None = None
    saturated_fat_g_per_100: float | None = None
    sodium_g_per_100: float | None = None
    salt_g_per_100: float | None = None
    micronutrients: dict[str, float] = field(default_factory=dict)
    quality_flags: list[str] = field(default_factory=list)
    verification: str = "unverified"
    aliases: list[AliasRecord] = field(default_factory=list)
    servings: list[ServingRecord] = field(default_factory=list)


class RecordError(ValueError):
    """A source row can't become a valid catalogue food. Message is safe to show."""


def check_ranges(rec: FoodRecord) -> None:
    """The same hard limits as the foods table, checked before writing so a bad
    row is reported by name instead of failing the whole batch."""
    if rec.kcal_per_100 is not None and not 0 <= rec.kcal_per_100 <= 1000:
        raise RecordError(f"kcal per 100 out of range: {rec.kcal_per_100}")
    for label, value in (
        ("protein", rec.protein_g_per_100), ("carbs", rec.carbs_g_per_100), ("fat", rec.fat_g_per_100),
        ("fiber", rec.fiber_g_per_100), ("sugars", rec.sugars_g_per_100),
        ("saturated fat", rec.saturated_fat_g_per_100), ("sodium", rec.sodium_g_per_100), ("salt", rec.salt_g_per_100),
    ):
        if value is not None and not 0 <= value <= 100:
            raise RecordError(f"{label} per 100 out of range: {value}")
    total = rec.protein_g_per_100 + rec.carbs_g_per_100 + rec.fat_g_per_100 + (rec.fiber_g_per_100 or 0)
    if total > 105:
        raise RecordError(f"macros sum to {total:.1f} g per 100")
    if rec.sugars_g_per_100 is not None and rec.sugars_g_per_100 > rec.carbs_g_per_100 + 1:
        raise RecordError("sugars exceed carbohydrates")
    if rec.saturated_fat_g_per_100 is not None and rec.saturated_fat_g_per_100 > rec.fat_g_per_100 + 1:
        raise RecordError("saturated fat exceeds fat")
    if not rec.name.strip() or len(rec.name) > 200:
        raise RecordError("name must be 1-200 characters")
