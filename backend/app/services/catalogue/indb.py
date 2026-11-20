"""Indian Nutrient Databank (INDB, Anuvaad 2024.11) -> catalogue records.

The workbook has one row per dish/food with values per 100 g, plus the same
values per household serving ("1 bowl", "1 piece"). Observed in 2024.11 and
handled here:
  * kcal is authoritative; `energy_kj` disagrees with kcal/4.184 on many rows,
    so it is ignored.
  * Serving grams are derived from the per-serving and per-100 g energy
    (unit_serving_energy_kcal / energy_kcal * 100); this ratio is consistent
    across nutrients in the source.
  * Names embed synonyms ("Chapati/Roti", "... (Bhindi sabzi/sabji/subji)"),
    which become aliases.
  * Some soups state far less energy than their macros imply; the database
    flags those `energy_mismatch` (they stay, ranked lower).
  * No category column: one is derived from keywords, or left blank.

The dataset itself is not part of this repository: the loader reads a file
path given on the command line.
"""

from __future__ import annotations

import csv
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.services.catalogue.names import categorize, name_variants
from app.services.catalogue.records import (
    AliasRecord,
    FoodRecord,
    RecordError,
    ServingRecord,
    check_ranges,
)

SOURCE = "indb"

REQUIRED_COLUMNS = (
    "food_code", "food_name", "energy_kcal", "carb_g", "protein_g", "fat_g",
    "fibre_g", "freesugar_g", "sfa_mg", "sodium_mg", "servings_unit", "unit_serving_energy_kcal",
)

# Per-100 g micronutrients copied verbatim; the column names already carry the
# unit suffix the foods.micronutrients check expects.
MICRONUTRIENT_COLUMNS = (
    "mufa_mg", "pufa_mg", "cholesterol_mg", "calcium_mg", "phosphorus_mg", "magnesium_mg",
    "potassium_mg", "iron_mg", "copper_mg", "selenium_ug", "chromium_mg", "manganese_mg",
    "molybdenum_mg", "zinc_mg", "vita_ug", "vite_mg", "vitd2_ug", "vitd3_ug", "vitk1_ug", "vitk2_ug",
    "folate_ug", "vitb1_mg", "vitb2_mg", "vitb3_mg", "vitb5_mg", "vitb6_mg", "vitb7_ug", "vitb9_ug",
    "vitc_mg", "carotenoids_ug",
)

# Water-like categories: a "ml" quantity is converted at 1 g/ml (flagged).
_ASSUME_WATER_DENSITY = {"beverage", "soup"}


def _num(row: Mapping[str, Any], column: str, *, required: bool = True) -> float | None:
    value = row.get(column)
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise RecordError(f"missing {column}")
        return None
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise RecordError(f"{column} is not a number") from exc
    if number != number or number < 0:  # NaN or negative
        raise RecordError(f"{column} must be a non-negative number")
    return number


def map_row(row: Mapping[str, Any], source_version: str) -> FoodRecord:
    code = str(row.get("food_code") or "").strip()
    name = " ".join(str(row.get("food_name") or "").split())
    if not code or not name:
        raise RecordError("missing food_code or food_name")

    kcal = _num(row, "energy_kcal")
    assert kcal is not None
    sodium_mg = _num(row, "sodium_mg")
    sfa_mg = _num(row, "sfa_mg")

    variants = name_variants(name)
    category = categorize([name] + [v for v, _ in variants])
    is_liquid_like = category in _ASSUME_WATER_DENSITY

    rec = FoodRecord(
        name=name,
        source=SOURCE,
        source_ref=code,
        source_version=source_version,
        kcal_per_100=round(kcal, 1),
        protein_g_per_100=round(_num(row, "protein_g") or 0, 2),
        carbs_g_per_100=round(_num(row, "carb_g") or 0, 2),
        fat_g_per_100=round(_num(row, "fat_g") or 0, 2),
        fiber_g_per_100=round(_num(row, "fibre_g") or 0, 2),
        sugars_g_per_100=round(_num(row, "freesugar_g") or 0, 2),
        saturated_fat_g_per_100=round((sfa_mg or 0) / 1000, 2),
        sodium_g_per_100=round((sodium_mg or 0) / 1000, 4),
        salt_g_per_100=round((sodium_mg or 0) * 2.5 / 1000, 4),
        food_kind="beverage" if category == "beverage" else "generic_dish",
        category=category,
        cuisine_tags=["indian_databank"],
        basis="g",
        density_g_per_ml=1.0 if is_liquid_like else None,
        quality_flags=["density_assumed"] if is_liquid_like else [],
        verification="curated",
        aliases=[AliasRecord(alias=v, kind=k, source="indb_name") for v, k in variants],
    )

    micros: dict[str, float] = {}
    for column in MICRONUTRIENT_COLUMNS:
        value = _num(row, column, required=False)
        if value is not None:
            micros[column] = round(value, 3)
    rec.micronutrients = micros

    unit = str(row.get("servings_unit") or "").strip()
    serving_kcal = _num(row, "unit_serving_energy_kcal", required=False)
    if unit and serving_kcal and kcal > 0:
        grams = round(serving_kcal / kcal * 100, 1)
        if 1 <= grams <= 5000:
            rec.servings.append(ServingRecord(label=f"1 {unit}", grams=grams, is_default=True, source=SOURCE))

    check_ranges(rec)
    return rec


@dataclass
class LoadReport:
    records: list[FoodRecord] = field(default_factory=list)
    errors: list[tuple[str, str]] = field(default_factory=list)   # (food_code or row#, reason)
    unknown_alias_codes: list[str] = field(default_factory=list)


def map_rows(rows: Iterable[Mapping[str, Any]], source_version: str) -> LoadReport:
    report = LoadReport()
    for index, row in enumerate(rows, start=2):   # spreadsheet row numbers (1 = header)
        try:
            report.records.append(map_row(row, source_version))
        except RecordError as exc:
            report.errors.append((str(row.get("food_code") or f"row {index}"), str(exc)))
    return report


def read_workbook(path: Path) -> list[dict[str, Any]]:
    """Reads the first sheet of an INDB .xlsx as dicts keyed by header."""
    from openpyxl import load_workbook   # tools-only dependency

    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        rows = workbook.worksheets[0].iter_rows(values_only=True)
        header = [str(h).strip() if h is not None else "" for h in next(rows)]
        missing = [c for c in REQUIRED_COLUMNS if c not in header]
        if missing:
            raise RecordError(f"not an INDB workbook: missing columns {missing}")
        return [dict(zip(header, r)) for r in rows if any(v is not None for v in r)]
    finally:
        workbook.close()


def apply_extra_aliases(report: LoadReport, aliases_csv: Path) -> None:
    """Adds hand-curated everyday names (food_code, alias, kind). Names only:
    the file never carries nutrition values."""
    by_code = {r.source_ref: r for r in report.records}
    with aliases_csv.open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            code = (row.get("food_code") or "").strip()
            alias = (row.get("alias") or "").strip()
            kind = (row.get("kind") or "common_name").strip()
            if not code or not alias or code.startswith("#"):
                continue
            target = by_code.get(code)
            if target is None:
                report.unknown_alias_codes.append(code)
                continue
            target.aliases.append(AliasRecord(alias=alias, kind=kind, source="curated"))
