"""INDB and Open Food Facts mapping, alias extraction, categorisation."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.services.catalogue import indb, off
from app.services.catalogue.names import categorize, expand_slashes, name_variants
from app.services.catalogue.records import RecordError

# ------------------------------------------------------------------ alias extraction


@pytest.mark.parametrize("segment,expected", [
    ("Chapati/Roti", ["Chapati", "Roti"]),
    ("Plain parantha/paratha", ["Plain parantha", "Plain paratha"]),
    ("Suji/Rava idli", ["Rava idli", "Suji idli"]),
    ("Ghiya/Lauki ka raita", ["Lauki ka raita", "Ghiya ka raita"]),
    ("Bhindi sabzi/sabji/subji", ["Bhindi sabzi", "Bhindi sabji", "Bhindi subji"]),
    ("Dahi bhaat/Dahi chawal/ Perugu annam/Daddojanam", ["Dahi bhaat", "Dahi chawal", "Perugu annam", "Daddojanam"]),
    ("Mutton biryani/biriyani", ["Mutton biryani", "Mutton biriyani"]),
    ("Poha", ["Poha"]),
])
def test_expand_slashes(segment: str, expected: list[str]) -> None:
    assert expand_slashes(segment) == expected


def test_name_variants_from_parentheses_and_commas() -> None:
    variants = name_variants("Lemon rice (Pulihora, Elumichai sadam, Chitranna)")
    assert ("Pulihora", "regional") in variants
    assert ("Elumichai sadam", "regional") in variants
    assert ("Chitranna", "regional") in variants
    assert all(v != "Lemon rice (Pulihora, Elumichai sadam, Chitranna)" for v, _ in variants)


def test_name_variants_dedupe_and_skip_the_name_itself() -> None:
    variants = name_variants("Poha")
    assert variants == []   # only the name itself: nothing to add
    v = name_variants("Potato parantha/paratha (Aloo ka parantha/paratha)")
    names = [a for a, _ in v]
    assert names == ["Potato parantha", "Potato paratha", "Aloo ka parantha", "Aloo ka paratha"]


@pytest.mark.parametrize("name,category", [
    ("Hot tea (Garam Chai)", "beverage"),
    ("Masala dosa", "south_indian"),
    ("Paneer parantha/paratha", "bread"),
    ("Mutton biryani/biriyani", "rice_dish"),
    ("Scrambled egg (Ande ki bhurji)", "egg_dish"),
    ("Chicken curry", "non_veg"),
    ("Dal makhani", "dal"),
    ("Spinach paneer (Palak paneer)", "paneer_dish"),
    ("Potato samosa (Aloo ka samosa)", "snack"),
    ("Cucumber raita (Kheere ka raita)", "side"),
    ("Potato cauliflower (Aloo gobhi)", "sabzi"),
    ("Spinach soup (Palak ka soup)", "soup"),
    ("Rice kheer (Chawal ki kheer)", "sweet"),
    ("Quinoa thing", None),
])
def test_categorize(name: str, category: str | None) -> None:
    assert categorize([name] + [v for v, _ in name_variants(name)]) == category


# ------------------------------------------------------------------ INDB rows

def _row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "food_code": "ASC096", "food_name": "Chapati/Roti", "primarysource": "asc_manual",
        "energy_kj": 999.0, "energy_kcal": 297.4567, "carb_g": 46.31, "protein_g": 9.81, "fat_g": 7.52,
        "freesugar_g": 0.45, "fibre_g": 6.4, "sfa_mg": 1234.5, "sodium_mg": 271.0,
        "servings_unit": "piece", "unit_serving_energy_kcal": 118.98, "calcium_mg": 30.5, "iron_mg": 2.1,
        "vitc_mg": None,
    }
    row.update(overrides)
    return row


def test_indb_row_maps_units_and_ignores_kj() -> None:
    rec = indb.map_row(_row(), "2024.11")
    assert (rec.source, rec.source_ref, rec.source_version, rec.verification) == ("indb", "ASC096", "2024.11", "curated")
    assert rec.kcal_per_100 == 297.5                      # from kcal, not the inconsistent kJ
    assert rec.saturated_fat_g_per_100 == 1.23            # mg -> g
    assert rec.sodium_g_per_100 == 0.271
    assert rec.salt_g_per_100 == 0.6775                  # 2.5 x sodium
    assert rec.micronutrients == {"calcium_mg": 30.5, "iron_mg": 2.1}   # missing values omitted
    assert rec.category == "bread" and rec.food_kind == "generic_dish" and rec.basis == "g"
    assert [(a.alias, a.source) for a in rec.aliases] == [("Chapati", "indb_name"), ("Roti", "indb_name")]


def test_indb_serving_grams_derived_from_energy_ratio() -> None:
    rec = indb.map_row(_row(), "2024.11")
    assert [(s.label, s.grams, s.is_default) for s in rec.servings] == [("1 piece", 40.0, True)]
    assert indb.map_row(_row(servings_unit=""), "x").servings == []


def test_indb_beverages_get_assumed_density() -> None:
    rec = indb.map_row(_row(food_code="ASC001", food_name="Hot tea (Garam Chai)", energy_kcal=16.1,
                            carb_g=2.6, protein_g=0.4, fat_g=0.5, fibre_g=0, freesugar_g=2.5), "x")
    assert (rec.food_kind, rec.density_g_per_ml, rec.quality_flags) == ("beverage", 1.0, ["density_assumed"])


@pytest.mark.parametrize("overrides,reason", [
    ({"energy_kcal": None}, "missing energy_kcal"),
    ({"protein_g": "abc"}, "not a number"),
    ({"fat_g": -1}, "non-negative"),
    ({"energy_kcal": 1500}, "out of range"),
    ({"carb_g": 80, "protein_g": 20, "fat_g": 10}, "macros sum"),
    ({"food_code": ""}, "missing food_code"),
])
def test_indb_bad_rows_are_rejected_with_a_reason(overrides: dict[str, object], reason: str) -> None:
    report = indb.map_rows([_row(**overrides), _row(food_code="OK1")], "x")
    assert [r.source_ref for r in report.records] == ["OK1"]
    assert reason in report.errors[0][1]


def test_extra_aliases_attach_by_code_and_report_unknown_codes(tmp_path: Path) -> None:
    csv_file = tmp_path / "aliases.csv"
    csv_file.write_text("food_code,alias,kind\nASC096,phulka,synonym\nNOPE1,ghost,common_name\n", encoding="utf-8")
    report = indb.map_rows([_row()], "x")
    indb.apply_extra_aliases(report, csv_file)
    assert ("phulka", "curated") in [(a.alias, a.source) for a in report.records[0].aliases]
    assert report.unknown_alias_codes == ["NOPE1"]


def test_repo_alias_file_only_has_names() -> None:
    path = Path(__file__).resolve().parents[1] / "data" / "indb_aliases_extra.csv"
    header = path.read_text(encoding="utf-8").splitlines()[0]
    assert header == "food_code,alias,kind", "the alias file must never carry nutrition values"


INDB_XLSX = os.environ.get("INDB_XLSX")


@pytest.mark.skipif(not INDB_XLSX, reason="set INDB_XLSX to the Anuvaad INDB workbook to run")
def test_real_workbook_loads_cleanly() -> None:
    rows = indb.read_workbook(Path(INDB_XLSX))  # type: ignore[arg-type]
    report = indb.map_rows(rows, "2024.11")
    indb.apply_extra_aliases(report, Path(__file__).resolve().parents[1] / "data" / "indb_aliases_extra.csv")
    assert len(report.records) == len(rows) and not report.errors
    assert not report.unknown_alias_codes


# ------------------------------------------------------------------ Open Food Facts

def _product(**nutriments: object) -> dict[str, object]:
    base = {"energy-kcal_100g": 589, "proteins_100g": 11, "carbohydrates_100g": 41, "fat_100g": 41,
            "fiber_100g": 5, "sugars_100g": 2, "saturated-fat_100g": 9.5, "sodium_100g": 0.95}
    base.update(nutriments)
    return {"product_name": "Aloo Bhujia", "brands": "Haldiram's, Haldiram", "categories_tags": ["en:snacks"],
            "nutriments": {k: v for k, v in base.items() if v is not None},
            "serving_size": "30 g", "serving_quantity": 30}


def test_off_product_maps_to_packaged_food() -> None:
    rec = off.map_product(_product(), "8904004400262")
    assert (rec.source, rec.source_ref, rec.brand, rec.food_kind, rec.basis) == (
        "open_food_facts", "8904004400262", "Haldiram's", "packaged", "g")
    assert rec.salt_g_per_100 == 2.375                     # derived from sodium
    assert rec.verification == "auto_checked"
    assert [(s.label, s.grams) for s in rec.servings] == [("1 serving (30 g)", 30.0)]


def test_off_kj_only_is_converted() -> None:
    rec = off.map_product(_product(**{"energy-kcal_100g": None, "energy-kj_100g": 2464}), "123456")
    assert rec.kcal_per_100 == 588.9 and "kcal_from_kj" in rec.quality_flags


def test_off_missing_energy_left_for_the_database_to_derive() -> None:
    rec = off.map_product(_product(**{"energy-kcal_100g": None}), "123456")
    assert rec.kcal_per_100 is None   # the foods trigger derives it and flags kcal_derived


@pytest.mark.parametrize("missing", ["proteins_100g", "carbohydrates_100g", "fat_100g"])
def test_off_missing_core_macro_is_refused(missing: str) -> None:
    with pytest.raises(RecordError, match="lacks"):
        off.map_product(_product(**{missing: None}), "123456")


def test_off_beverage_is_per_100_ml_with_assumed_density() -> None:
    p = _product(**{"energy-kcal_100g": 63, "proteins_100g": 0, "carbohydrates_100g": 15.6, "fat_100g": 0,
                    "fiber_100g": None, "sugars_100g": 15, "saturated-fat_100g": 0})
    p["categories_tags"] = ["en:beverages", "en:juices"]
    rec = off.map_product(p, "8901764012273")
    assert (rec.basis, rec.food_kind, rec.density_g_per_ml) == ("ml", "beverage", 1.0)
    assert "density_assumed" in rec.quality_flags


def test_off_impossible_values_refused() -> None:
    with pytest.raises(RecordError):
        off.map_product(_product(**{"carbohydrates_100g": 90, "fat_100g": 40}), "123456")
