"""USDA staples loader: values copied from the dataset, never estimated."""

from __future__ import annotations

from pathlib import Path

from app.services.catalogue.usda import StapleSpec, load_records, read_specs

DATA = Path(__file__).resolve().parents[1] / "data" / "staples_usda.csv"


def _write(d: Path, name: str, rows: list[str]) -> None:
    (d / name).write_text("\n".join(rows) + "\n", encoding="utf-8")


def _dataset(d: Path, nutrients: dict[str, float], portions: list[str]) -> None:
    _write(d, "food.csv", ["fdc_id,data_type,description,food_category_id,publication_date",
                           "1,sr_legacy_food,\"Bananas, raw\",9,2019-04-01"])
    _write(d, "food_nutrient.csv", ["id,fdc_id,nutrient_id,amount"] +
           [f"{i},1,{nid},{amt}" for i, (nid, amt) in enumerate(nutrients.items())])
    _write(d, "measure_unit.csv", ["id,name", "1000,cup"])
    _write(d, "food_portion.csv", ["id,fdc_id,seq_num,amount,measure_unit_id,portion_description,modifier,gram_weight"] + portions)


BANANA = {"1008": 89, "1003": 1.09, "1004": 0.33, "1005": 22.84, "1079": 2.6, "2000": 12.23, "1258": 0.112, "1093": 1}
SPEC = StapleSpec(fdc_id="1", name="Banana", aliases=["kela"], category="fruit", food_kind="ingredient",
                  default_portion="1 medium", default_label="1 medium banana (118 g)",
                  extra_portions=[("1 cup", "1 cup sliced (150 g)")])


def test_values_come_from_the_dataset(tmp_path: Path) -> None:
    _dataset(tmp_path, BANANA, ['1,1,1,1,9999,,"medium (7"" to 7-7/8"" long)",118', "2,1,2,1,1000,,,150"])
    [rec], problems = load_records(tmp_path, [SPEC])
    assert problems == []
    assert (rec.source, rec.source_ref, rec.kcal_per_100) == ("usda_fdc", "1", 89)
    assert rec.carbs_g_per_100 == 20.24              # 22.84 by difference - 2.6 fibre (catalogue convention)
    assert rec.fiber_g_per_100 == 2.6 and rec.sodium_g_per_100 == 0.001
    assert [(s.label, s.grams, s.is_default) for s in rec.servings] == [
        ("1 medium banana (118 g)", 118, True), ("1 cup sliced (150 g)", 150, False)]
    assert {a.alias for a in rec.aliases} == {"Bananas, raw", "kela"}


def test_missing_portion_or_nutrient_is_reported_not_guessed(tmp_path: Path) -> None:
    _dataset(tmp_path, BANANA, ["2,1,2,1,1000,,,150"])                      # no "medium" portion
    records, problems = load_records(tmp_path, [SPEC])
    assert records == [] and "no USDA portion" in problems[0]
    _dataset(tmp_path, {k: v for k, v in BANANA.items() if k != "1008"}, ['1,1,1,1,9999,,medium,118'])
    records, problems = load_records(tmp_path, [SPEC])
    assert records == [] and "lacks kcal" in problems[0]


def test_impossible_values_are_rejected(tmp_path: Path) -> None:
    _dataset(tmp_path, {**BANANA, "2000": 40.0}, ['1,1,1,1,9999,,medium,118', "2,1,2,1,1000,,,150"])  # sugars > carbs
    records, problems = load_records(tmp_path, [SPEC])
    assert records == [] and "sugars exceed carbohydrates" in problems[0]


def test_staples_list_is_well_formed() -> None:
    specs = read_specs(DATA)
    assert len(specs) == 73 and len({s.fdc_id for s in specs}) == 73
    assert {s.category for s in specs} <= {"dairy", "fruit", "nuts_seeds", "vegetable", "legume", "grain", "bread",
                                            "beverage", "egg_dish", "other"}
    aliases = [a.lower() for s in specs for a in s.aliases]
    assert "boiled egg" not in aliases and "chole" not in aliases and "2% milk" not in aliases


def test_recipe_only_ingredients_are_flagged() -> None:
    specs = {s.name: s for s in read_specs(DATA)}
    for raw in ("Toor dal (raw)", "White rice (raw)", "Potato (raw)", "Chicken thigh (raw skinless)", "Turmeric powder"):
        assert specs[raw].flags == ["raw_ingredient"]
    for loggable in ("Salt", "Sugar", "Ghee", "Sunflower oil", "Banana", "Curd (plain yogurt)", "Onion"):
        assert not specs[loggable].flags
