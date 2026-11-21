"""Meal template review: checks, decisions, serving-weight audit and report
(no database: a fake connection)."""

from __future__ import annotations

import csv
import os
from pathlib import Path
from typing import Any

import pytest

from app.services.catalogue import serving_audit
from app.services.catalogue.templates import (
    Component,
    Decision,
    Priced,
    ReviewStatus,
    Template,
    build_report,
    meal_flags,
    meal_range,
    name_flags,
    read_csv,
    read_decisions,
    read_review_status,
    serving_flags,
    serving_unit,
    suggested_status,
    write_corrections,
)

DATA = Path(__file__).resolve().parents[1] / "data"
NINE = {"BFP044", "ASC144", "BFP148", "ASC146", "BFP046", "BFP144", "ASC115", "ASC022", "ASC001"}


def food(name: str, label: str, grams: float, kcal100: float, *, allergens=(), allergen_status="inferred",
         diet="vegetarian", diet_status="inferred", flags=(), source_ref: str | None = None) -> dict[str, Any]:
    return {"source": "indb", "source_ref": source_ref or name[:6].upper(), "food_id": f"id-{name}", "name": name,
            "is_active": True, "is_matchable": True, "quality_flags": list(flags), "serving_label": label,
            "serving_grams": grams, "diet_class": diet, "diet_status": diet_status, "vegan_compatible": None,
            "jain_compatible": None, "allergens": list(allergens), "allergen_status": allergen_status,
            "kcal100": kcal100}


def comp(pos: int, ref: str, name: str, default: float, lo: float, hi: float, step: float = 0.5,
         optional: bool = False, slot: str = "main") -> Component:
    return Component(position=pos, slot=slot, source_ref=ref, name_check=name, default=default, min=lo, max=hi,
                     step=step, optional=optional)


def priced(c: Component, f: dict[str, Any]) -> Priced:
    grams = f["serving_grams"] * c.default
    return Priced(c, f, grams, round(f["kcal100"] * grams / 100), 1.0, 1.0, 1.0)


# ------------------------------------------------------------------ checks

def test_serving_units_are_read_from_labels() -> None:
    assert serving_unit("1 bowl") == ("bowl", 1)
    assert serving_unit("1 small bowl") == ("small bowl", 1)
    assert serving_unit("1 tea cup") == ("tea cup", 1)
    assert serving_unit("2 pieces") == ("piece", 2)
    assert serving_unit("1 serving") == (None, 1)


def test_serving_weight_flags_carry_the_audit_and_never_demand_a_change() -> None:
    t = Template("t", "T", ["breakfast"], [])
    poha = food("Poha", "1 bowl", 55, 293, source_ref="BFP044")          # audited: suspicious
    tea = food("Hot tea", "1 tea cup", 210, 16, source_ref="ASC001")     # audited: plausible (USDA cup)
    other = food("Upma", "1 bowl", 106, 148, source_ref="BFP039")        # not individually assessed
    ok = food("Sambar", "1 bowl", 257, 97, source_ref="ASC167")
    flags = serving_flags(t, [priced(comp(i, f["source_ref"], f["name"], 1, 1, 2), f)
                              for i, f in enumerate([poha, tea, other, ok], start=1)])
    by = {f.position: f for f in flags}
    assert set(by) == {1, 2, 3}
    assert by[1].severity == "review" and "suspicious" in by[1].message and "no catalogue change" in by[1].message
    assert by[2].severity == "info" and "plausible" in by[2].message and "kept as is" in by[2].message
    assert by[3].severity == "review" and "not individually assessed" in by[3].message
    assert not any(f.severity == "correction" for f in flags)
    assert poha["serving_grams"] == 55                                     # nothing changed


def test_calorie_ranges_are_soft_notes_and_never_propose_portion_changes() -> None:
    t = Template("poha", "Poha", ["breakfast", "snack"], [])
    c = comp(1, "P", "Poha", 1, 1, 2)
    flags, props = meal_flags(t, [priced(c, food("Poha", "1 bowl", 55, 293))])
    assert props == []
    [f] = flags
    assert (f.check, f.severity) == ("meal_energy", "info")
    assert "Soft target only" in f.message and "default servings are kept" in f.message
    assert c.default == 1
    assert suggested_status(flags) == "no_automated_issues"               # a calorie range is not a defect


def test_meal_types_that_cannot_share_a_size_still_need_correction() -> None:
    assert meal_range(["snack", "lunch"]) is None
    flags, props = meal_flags(Template("x", "X", ["snack", "lunch"], []),
                              [priced(comp(1, "A", "A", 1, 1, 2), food("A", "1 bowl", 200, 100))])
    assert flags[0].severity == "correction" and props == []
    assert suggested_status(flags) == "needs_correction"


def test_names_that_mention_optional_components_are_flagged() -> None:
    t = Template("poha-with-tea", "Poha with tea", ["breakfast"], [])
    poha = priced(comp(1, "P", "Poha", 1, 1, 2), food("Poha", "1 bowl", 120, 150))
    tea = priced(comp(2, "T", "Hot tea (Garam Chai)", 1, 1, 1, 1, optional=True, slot="drink"),
                 food("Hot tea (Garam Chai)", "1 tea cup", 150, 16))
    [flag] = name_flags(t, [poha, tea])
    assert (flag.check, flag.severity, flag.position) == ("name_mentions_optional", "review", 2)
    assert name_flags(Template("poha-with-tea", "Poha", ["breakfast"], []), [poha, tea]) == []


# ------------------------------------------------------------------ the reviewed draft and its decisions

def test_reviewed_draft_names_match_their_base_meals() -> None:
    templates, problems = read_csv(DATA / "meal_templates_draft.csv")
    assert problems == [] and len(templates) == 40
    for t in templates:
        ps = [priced(c, food(c.name_check, "1 serving", 100, 100)) for c in t.components]
        assert name_flags(t, ps) == [], t.slug


def test_decisions_are_recorded_and_reflected_in_the_draft() -> None:
    decisions = read_decisions(DATA / "meal_templates_decisions.csv")
    assert len(decisions) == 30
    templates = {t.slug: t for t in read_csv(DATA / "meal_templates_draft.csv")[0]}
    rejected = [d for d in decisions if d.status == "rejected"]
    applied = [d for d in decisions if d.status == "applied"]
    assert len(rejected) == 16 and {d.change for d in rejected} == {"default_servings"}
    assert len(applied) == 14 and {d.change for d in applied} == {"name"}
    for d in rejected:                         # calorie-only proposals: the original servings were kept
        c = next(c for c in templates[d.slug].components if str(c.position) == d.position)
        assert f"{c.default:g}" == d.original and "calorie range" in d.reason
    for d in applied:                          # renames: name changed; the component stays optional
        t = templates[d.slug]
        assert t.name == d.proposed and "unchanged" in d.reason
        assert any(c.optional and d.component.split()[0].lower() in c.name_check.lower() for c in t.components)
    assert all(d.decided_by for d in decisions)


def test_all_templates_are_provisionally_approved_and_none_is_verified() -> None:
    templates, _ = read_csv(DATA / "meal_templates_draft.csv")
    statuses, problems = read_review_status(DATA / "meal_templates_review_status.csv", [t.slug for t in templates])
    assert problems == [] and len(statuses) == 40
    assert {s.status for s in statuses.values()} == {"approved_provisional"}        # never plain "approved"
    for s in statuses.values():
        assert s.reviewer and s.reviewed_at.endswith("Z") and "NOT individually verified" in s.notes


def test_review_status_file_is_validated(tmp_path: Path) -> None:
    path = tmp_path / "status.csv"
    path.write_text("slug,review_status,reviewer,reviewed_at,notes\n"
                    "a,approved,,,\n"
                    "b,needs_correction,Reviewer,2026-11-21,\n"
                    "c,rejected,R,2026-11-21,Not a meal\n"
                    "a,great,R,2026-11-21,\n", encoding="utf-8")
    _, problems = read_review_status(path, ["a", "b"])
    assert any("a: approved needs a reviewer and a date" in p for p in problems)
    assert any("b: needs_correction needs notes" in p for p in problems)
    assert any("unknown template 'c'" in p for p in problems)
    assert any("'great' is not one of pending, approved_provisional, approved, needs_correction, rejected" in p
               for p in problems)
    path.write_text("slug,review_status,reviewer,reviewed_at,notes\na,approved_provisional,R,2026-11-21T05:24:07Z,\n",
                    encoding="utf-8")
    assert any("approved_provisional needs notes" in p for p in read_review_status(path, ["a"])[1])


# ------------------------------------------------------------------ serving-weight audit

def test_the_audit_assesses_the_nine_foods_and_proposes_nothing_without_a_source() -> None:
    assert NINE <= set(serving_audit.EVIDENCE)
    for ref, e in serving_audit.EVIDENCE.items():
        assert e.assessment in ("suspicious", "plausible") and e.why
        assert e.proposed_grams is None or e.proposed_source, ref       # never a number without a source
        for key in e.references:
            assert key in serving_audit.USDA
    assert serving_audit.EVIDENCE["ASC001"].assessment == "plausible"  # tea: USDA 6-8 fl oz = 178-237 g


class FakeConn:
    def __init__(self, foods: list[dict[str, Any]]) -> None:
        self.foods = {f["food_id"]: f for f in foods}
        self._rows: Any = None

    def execute(self, sql: str, params: Any) -> FakeConn:
        if "from public.foods" in sql:
            self._rows = [{**f, "source_version": "2024.11", "kcal_per_100": f["kcal100"], "label": f["serving_label"],
                           "grams": f["serving_grams"], "serving_source": "indb"} for f in self.foods.values()]
        else:
            f = self.foods[params[0]]
            g = float(params[1])
            self._rows = [{"calories": round(f["kcal100"] * g / 100), "protein_g": 1.0, "carbs_g": 1.0, "fat_g": 1.0}]
        return self

    def fetchall(self) -> list[dict[str, Any]]:
        return self._rows

    def fetchone(self) -> dict[str, Any] | None:
        return self._rows[0] if self._rows else None


def test_audit_rows_record_source_derivation_and_status(tmp_path: Path) -> None:
    conn = FakeConn([food("Poha", "1 bowl", 54.6, 294.5, source_ref="BFP044"),
                     food("Hot tea", "1 tea cup", 210.5, 16.1, source_ref="ASC001")])
    rows = serving_audit.build_audit(conn, {"BFP044": ["poha-with-tea"]}, {"BFP044": "generic: light bowl"})
    out = {r.source_ref: r.as_csv() for r in rows}
    assert out["BFP044"]["serving_grams"] == "54.6" and out["BFP044"]["original_source"] == "indb 2024.11"
    assert "per-serving energy / per-100 g energy" in out["BFP044"]["derivation"]
    assert out["BFP044"]["proposed_grams"] == "" and out["BFP044"]["catalogue_changed"] == "no"
    assert out["BFP044"]["used_by_templates"] == "poha-with-tea"
    assert "USDA SR Legacy 173227" in out["ASC001"]["reference_data"]
    serving_audit.write_audit(tmp_path / "a.csv", tmp_path / "a.md", rows)
    header = (tmp_path / "a.csv").read_text(encoding="utf-8").splitlines()[0].split(",")
    assert header == serving_audit.CSV_FIELDS
    assert "no catalogue value was changed" in (tmp_path / "a.md").read_text(encoding="utf-8")


INDB = Path(os.environ.get("INDB_XLSX", Path(__file__).resolve().parents[2] / "Anuvaad_INDB_2024.11.xlsx"))


@pytest.mark.skipif(not INDB.exists(), reason="INDB workbook not available")
def test_indb_weights_for_the_nine_foods_are_internally_consistent() -> None:
    result = serving_audit.indb_consistency(INDB, NINE)
    assert set(result) == NINE
    assert all(v.startswith("consistent") for v in result.values()), result


# ------------------------------------------------------------------ report

def _report(decisions: list[Decision] | None = None) -> tuple[str, int, list[Any], list[Any]]:
    poha = food("Poha", "1 bowl", 55, 293, source_ref="BFP044")
    tea = food("Hot tea", "1 tea cup", 210, 16, allergens=["milk"], flags=["density_assumed"], source_ref="ASC001")
    t = Template("poha-with-tea", "Poha", ["breakfast", "snack"], ["west_indian"],
                 [comp(1, "BFP044", "Poha", 1, 1, 2), comp(2, "ASC001", "Hot tea", 1, 1, 1, 1, optional=True, slot="drink")])
    return build_report(FakeConn([poha, tea]), [t], [], {"poha-with-tea": ReviewStatus()}, None, decisions)


def test_report_separates_base_meal_and_optional_add_ons() -> None:
    md, blocking, props, _ = _report()
    assert blocking == 0 and props == []
    assert "**Base meal (required components)**" in md
    assert "**Optional add-ons (not in the base meal; the user chooses)**" in md
    assert "Base meal at default servings: 161 kcal" in md
    assert "With all optional add-ons at default servings: 195 kcal" in md
    assert "Proposed corrections" not in md


def test_report_never_calls_anything_allergen_free_and_keeps_statuses_and_warnings() -> None:
    md, *_ = _report()
    assert "allergen-free" not in md.replace("NOT an allergen-free check", "").replace("never means allergen-free", "")
    assert "Allergens: none detected — detected from names only; NOT an allergen-free check" in md
    assert "Add-ons bring in: milk." in md and "| milk (inferred) |" in md
    assert "Hot tea: Volume converted assuming water-like density. (optional add-on)" in md


def test_report_shows_decisions_and_the_corrections_file_lists_them(tmp_path: Path) -> None:
    d = [Decision("poha-with-tea", "1", "Poha", "default_servings", "1", "2", "rejected", "calorie range only", "reviewer"),
         Decision("poha-with-tea", "", "Hot tea", "name", "Poha with tea", "Poha", "applied", "optional", "reviewer")]
    md, _, props, flags = _report(d)
    assert "**Decisions**" in md and "| default_servings | Poha | 1 | 2 | rejected (reviewer) |" in md
    out = tmp_path / "c.csv"
    write_corrections(out, props, flags, d)
    rows = list(csv.DictReader(out.open(encoding="utf-8")))
    assert {r["status"] for r in rows} == {"rejected", "applied", "open"}
    assert not any(r["kind"] == "proposal" for r in rows)


@pytest.mark.parametrize("status,label", [
    ("approved", "approved (verified)"), ("rejected", "rejected"), ("needs_correction", "needs correction"),
    ("approved_provisional", "approved (provisional, not individually verified)")])
def test_human_review_status_is_shown_as_entered(status: str, label: str) -> None:
    poha = food("Poha", "1 bowl", 55, 293, source_ref="BFP044")
    t = Template("p", "Poha", ["breakfast"], [], [comp(1, "BFP044", "Poha", 1, 1, 2)])
    md, *_ = build_report(FakeConn([poha]), [t], [], {"p": ReviewStatus(status, "Reviewer", "2026-11-21", "notes")})
    assert f"**Review status: {label}** (Reviewer, 2026-11-21)" in md
    assert ("without individual human verification" in md) == (status == "approved_provisional")
    assert "[review]" in md                                   # the serving-weight warning is kept either way
