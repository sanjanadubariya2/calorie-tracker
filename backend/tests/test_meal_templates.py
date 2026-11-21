"""Phase 3: the draft meal templates CSV and its validation (no database)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.catalogue.templates import read_csv

DRAFT = Path(__file__).resolve().parents[1] / "data" / "meal_templates_draft.csv"
HEADER = "slug,name,meal_types,regions,position,slot,food_source_ref,food_name_check,default_servings,min_servings,max_servings,servings_step,optional\n"


def test_draft_has_40_valid_templates() -> None:
    templates, problems = read_csv(DRAFT)
    assert problems == []
    assert len(templates) == 40
    assert len({t.slug for t in templates}) == 40
    meals = {m for t in templates for m in t.meal_types}
    assert meals == {"breakfast", "lunch", "dinner", "snack"}
    assert all(any(not c.optional for c in t.components) for t in templates)


def _check(tmp_path: Path, rows: str) -> list[str]:
    p = tmp_path / "t.csv"
    p.write_text(HEADER + rows, encoding="utf-8")
    return read_csv(p)[1]


@pytest.mark.parametrize("rows,expected", [
    ("a,A,brunch,,1,main,X1,X,1,1,2,1,false\n", "invalid meal_types"),
    ("a,A,lunch,mars,1,main,X1,X,1,1,2,1,false\n", "invalid regions"),
    ("a,A,lunch,,1,plate,X1,X,1,1,2,1,false\n", "invalid slot"),
    ("a,A,lunch,,1,main,X1,X,3,1,2,1,false\n", "invalid"),                      # default above max
    ("a,A,lunch,,1,main,X1,X,1,0.5,2,0.3,false\n", "invalid"),                  # odd step
    ("a,A,lunch,,1,main,X1,X,1.25,0.5,2,0.5,false\n", "isn't reachable"),
    ("a,A,lunch,,1,main,X1,X,1,1,2,1,true\n", "every component is optional"),
    ("a,A,lunch,,1,main,X1,X,1,1,2,1,false\na,A,lunch,,1,side,X2,Y,1,1,2,1,false\n", "duplicate positions"),
    ("a,A,lunch,,1,main,X1,X,1,1,2,1,false\na,A,lunch,,2,side,X1,X,1,1,2,1,false\n", "same food appears twice"),
    ("a,A,lunch,,1,main,X1,X,1,1,2,1,false\na,B,lunch,,2,side,X2,Y,1,1,2,1,false\n", "differ between rows"),
])
def test_invalid_drafts_are_reported(tmp_path: Path, rows: str, expected: str) -> None:
    assert any(expected in p for p in _check(tmp_path, rows))
