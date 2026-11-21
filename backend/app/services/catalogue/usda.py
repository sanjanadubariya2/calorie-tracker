"""USDA FoodData Central (SR Legacy) staples -> catalogue records.

Only foods listed in data/staples_usda.csv are imported, each referenced by its
FDC id. Nutrition and portion weights are copied from the dataset files; nothing
is estimated. Conventions:
  * kcal: USDA "Energy" (kcal), nutrient 1008.
  * carbs: USDA reports carbohydrate by difference INCLUDING fibre; the catalogue
    (INDB, EU labels) stores carbohydrate EXCLUDING fibre, so fibre is subtracted.
  * servings: USDA's measured household portions ("1 medium" banana = 118 g),
    relabelled for display; the gram weight is never changed.

Dataset: https://fdc.nal.usda.gov/download-datasets (SR Legacy, April 2018, CSV),
public domain (CC0).
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

from app.services.catalogue.records import AliasRecord, FoodRecord, RecordError, ServingRecord, check_ranges

SOURCE = "usda_fdc"
SOURCE_VERSION = "SR Legacy 2018-04"
ALLOWED_FLAGS = {"raw_ingredient"}
NUTRIENTS = {"1008": "kcal", "1003": "protein", "1004": "fat", "1005": "carbs", "1079": "fiber", "2000": "sugars",
             "1258": "satfat", "1093": "sodium_mg"}


@dataclass
class StapleSpec:
    fdc_id: str
    name: str
    aliases: list[str]
    category: str
    food_kind: str
    default_portion: str
    default_label: str
    extra_portions: list[tuple[str, str]]
    flags: list[str] = None  # type: ignore[assignment]


def read_specs(path: Path) -> list[StapleSpec]:
    specs = []
    with path.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            extras = []
            for item in filter(None, row["extra_portions"].split("|")):
                match, _, label = item.partition("=")
                extras.append((match.strip(), label.strip()))
            specs.append(StapleSpec(
                fdc_id=row["fdc_id"].strip(), name=row["name"].strip(),
                aliases=[a.strip() for a in row["aliases"].split("|") if a.strip()],
                category=row["category"].strip(), food_kind=row["food_kind"].strip(),
                default_portion=row["default_portion"].strip(), default_label=row["default_label"].strip(),
                extra_portions=extras,
                flags=[f for f in (row.get("flags") or "").split("|") if f]))
    return specs


def _portion_text(row: dict[str, str], units: dict[str, str]) -> str:
    amount = float(row["amount"] or 1)
    what = row["modifier"] or units.get(row["measure_unit_id"], "")
    return f"{amount:g} {what}".strip()


def load_records(sr_dir: Path, specs: list[StapleSpec]) -> tuple[list[FoodRecord], list[str]]:
    """Builds records for the listed staples. Returns (records, problems)."""
    ids = {s.fdc_id for s in specs}
    foods = {r["fdc_id"]: r["description"] for r in csv.DictReader((sr_dir / "food.csv").open(encoding="utf-8"))
             if r["fdc_id"] in ids}
    values: dict[str, dict[str, float]] = {i: {} for i in ids}
    with (sr_dir / "food_nutrient.csv").open(encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["fdc_id"] in ids and r["nutrient_id"] in NUTRIENTS and r["amount"] not in ("", None):
                values[r["fdc_id"]][NUTRIENTS[r["nutrient_id"]]] = float(r["amount"])
    units = {r["id"]: r["name"] for r in csv.DictReader((sr_dir / "measure_unit.csv").open(encoding="utf-8"))}
    portions: dict[str, list[tuple[str, float]]] = {i: [] for i in ids}
    for r in csv.DictReader((sr_dir / "food_portion.csv").open(encoding="utf-8")):
        if r["fdc_id"] in ids and r["gram_weight"]:
            portions[r["fdc_id"]].append((_portion_text(r, units), float(r["gram_weight"])))

    records: list[FoodRecord] = []
    problems: list[str] = []
    for s in specs:
        if s.fdc_id not in foods:
            problems.append(f"{s.name}: FDC {s.fdc_id} not in the dataset")
            continue
        v = values[s.fdc_id]
        missing = [k for k in ("kcal", "protein", "fat", "carbs") if k not in v]
        if missing:
            problems.append(f"{s.name}: FDC {s.fdc_id} lacks {', '.join(missing)}")
            continue

        def portion(match: str) -> float | None:
            hits = [g for text, g in portions[s.fdc_id] if text.startswith(match)]
            return hits[0] if hits else None

        servings: list[ServingRecord] = []
        grams = portion(s.default_portion)
        if grams is None:
            problems.append(f"{s.name}: no USDA portion starting with {s.default_portion!r} "
                            f"(have: {', '.join(t for t, _ in portions[s.fdc_id]) or 'none'})")
            continue
        servings.append(ServingRecord(label=s.default_label, grams=grams, is_default=True, source=SOURCE))
        for match, label in s.extra_portions:
            g = portion(match)
            if g is None:
                problems.append(f"{s.name}: extra portion {match!r} not found")
                continue
            servings.append(ServingRecord(label=label, grams=g, is_default=False, source=SOURCE))

        fiber = v.get("fiber")
        carbs_available = max(0.0, v["carbs"] - (fiber or 0.0))
        sodium_g = v["sodium_mg"] / 1000 if "sodium_mg" in v else None
        rec = FoodRecord(
            name=s.name, source=SOURCE, source_ref=s.fdc_id, source_version=SOURCE_VERSION,
            kcal_per_100=round(v["kcal"], 1), protein_g_per_100=round(v["protein"], 2),
            carbs_g_per_100=round(carbs_available, 2), fat_g_per_100=round(v["fat"], 2),
            fiber_g_per_100=None if fiber is None else round(fiber, 2),
            sugars_g_per_100=None if "sugars" not in v else round(v["sugars"], 2),
            saturated_fat_g_per_100=None if "satfat" not in v else round(v["satfat"], 2),
            sodium_g_per_100=None if sodium_g is None else round(sodium_g, 4),
            salt_g_per_100=None if sodium_g is None else round(sodium_g * 2.5, 4),
            food_kind=s.food_kind, category=s.category, cuisine_tags=["usda_staple"], basis="g",
            verification="curated",
            # 'raw_ingredient': recipe-only items rank below dishes in search (migration 016).
            quality_flags=[f for f in (s.flags or []) if f in ALLOWED_FLAGS],
            aliases=[AliasRecord(alias=foods[s.fdc_id][:200], kind="name_variant", source=SOURCE)]
            + [AliasRecord(alias=a, kind="common_name", source=SOURCE) for a in s.aliases],
            servings=servings,
        )
        try:
            check_ranges(rec)
        except RecordError as exc:
            problems.append(f"{s.name}: {exc}")
            continue
        records.append(rec)
    return records, problems
