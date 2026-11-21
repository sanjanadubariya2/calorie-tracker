"""Phase 3 Task 2: recipe draft CSV validation (no database)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.catalogue.recipes import read_drafts

DATA = Path(__file__).resolve().parents[1] / "data"
R_HEADER = "slug,name,variant,servings,serving_label,categories,prep_minutes,cook_minutes,description,instructions\n"
I_HEADER = "slug,position,food_ref,food_name_check,quantity,unit,grams,preparation,optional\n"


def test_drafts_are_valid() -> None:
    recipes, problems = read_drafts(DATA / "recipes_draft.csv", DATA / "recipe_ingredients_draft.csv")
    assert problems == []
    assert len(recipes) == 22
    slugs = {r.slug for r in recipes}
    for must in ("phulka", "dal-tadka", "steamed-rice", "idli", "plain-dosa", "besan-chilla", "moong-dal-khichdi",
                 "curd-rice", "chicken-curry", "egg-curry", "aloo-gobi", "rajma-masala"):
        assert must in slugs
    assert all(r.instructions and any(not i.optional for i in r.ingredients) for r in recipes)
    # Regional variants are explicit, not assumed.
    assert {r.variant for r in recipes if r.slug in ("rajma-masala", "chole-masala")} == {"Punjabi style"}


def _check(tmp_path: Path, recipes: str, ingredients: str) -> list[str]:
    (tmp_path / "r.csv").write_text(R_HEADER + recipes, encoding="utf-8")
    (tmp_path / "i.csv").write_text(I_HEADER + ingredients, encoding="utf-8")
    return read_drafts(tmp_path / "r.csv", tmp_path / "i.csv")[1]


OK_RECIPE = "dal,Dal,,4,1 katori,dal|lunch,5,20,A dal.,Cook it.\n"
OK_ING = "dal,1,usda_fdc:1,Toor,150,g,,,false\n"


@pytest.mark.parametrize("recipes,ingredients,expected", [
    (OK_RECIPE, "dal,1,usda_fdc:1,Toor,150,g,140,,false\n", "inconsistent units"),
    (OK_RECIPE, "dal,1,usda_fdc:1,Toor,1,tbsp,,,false\n", "needs a weight in grams"),
    (OK_RECIPE, "dal,1,usda_fdc:1,Toor,0,g,,,false\n", "out of range"),
    (OK_RECIPE, "dal,1,usda_fdc:1,Toor,1,handful,10,,false\n", "unknown unit"),
    (OK_RECIPE, "dal,1,usda_fdc:1,Toor,10,g,,,true\n", "no required ingredients"),
    (OK_RECIPE, OK_ING + "dal,1,usda_fdc:2,Salt,5,g,,,false\n", "duplicate ingredient positions"),
    (OK_RECIPE + "dal-2,Dal,,2,1 bowl,dal,5,20,Same.,Cook.\n", OK_ING + "dal-2,1,usda_fdc:1,Toor,50,g,,,false\n",
     "duplicate of dal"),
    (OK_RECIPE + "dal,Other,,2,1 bowl,dal,5,20,X.,Y.\n", OK_ING, "duplicate slug"),
    ("dal,Dal,,0,1 katori,dal,5,20,A dal.,Cook it.\n", OK_ING, "servings must be"),
    ("dal,Dal,,4,1 katori,dal|dessert,5,20,A dal.,Cook it.\n", OK_ING, "unknown categories"),
    (OK_RECIPE, "khichdi,1,usda_fdc:1,Toor,150,g,,,false\n" + OK_ING, "unknown recipe"),
])
def test_invalid_drafts_are_reported(tmp_path: Path, recipes: str, ingredients: str, expected: str) -> None:
    assert any(expected in p for p in _check(tmp_path, recipes, ingredients))


def test_a_variant_is_not_a_duplicate(tmp_path: Path) -> None:
    problems = _check(tmp_path, OK_RECIPE + "dal-tadka,Dal,Tadka,2,1 bowl,dal,5,20,X.,Y.\n",
                      OK_ING + "dal-tadka,1,usda_fdc:1,Toor,50,g,,,false\n")
    assert problems == []


def test_equipment_is_parsed_and_validated(tmp_path: Path) -> None:
    recipes, problems = read_drafts(DATA / "recipes_draft.csv", DATA / "recipe_ingredients_draft.csv")
    by_slug = {r.slug: r for r in recipes}
    assert by_slug["idli"].equipment == ["stove", "blender", "steamer"]
    assert by_slug["cucumber-raita"].equipment == []          # "none": needs no equipment
    assert all(r.equipment is not None for r in recipes)       # every draft records it
    header = R_HEADER.replace("cook_minutes,", "cook_minutes,equipment,")
    (tmp_path / "r.csv").write_text(header + "dal,Dal,,4,1 katori,dal|lunch,5,20,stove|spaceship,A dal.,Cook it.\n",
                                    encoding="utf-8")
    (tmp_path / "i.csv").write_text(I_HEADER + OK_ING, encoding="utf-8")
    assert any("unknown equipment ['spaceship']" in p for p in read_drafts(tmp_path / "r.csv", tmp_path / "i.csv")[1])
