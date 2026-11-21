"""Phase 3 Task 6: the deterministic recommendation evaluation must stay clean.

Hard dietary constraint violations must be zero (independently re-checked),
nutrition must equal the sum of its parts, and ranking must be consistent.
"""

from __future__ import annotations

import json

from evals.run_recommendation_eval import CASES, build_catalogue, run_cases


def test_evaluation_dataset_is_clean() -> None:
    spec = json.loads(CASES.read_text(encoding="utf-8"))
    report = run_cases(build_catalogue(spec["catalogue"]), spec["cases"], "fixture")
    failures = {r["id"]: r["failures"] + r["violations"] + r["nutrition_errors"] for r in report["rows"]
                if r["failures"] or r["violations"] or r["nutrition_errors"]}
    assert failures == {}
    m = report["metrics"]
    assert m["hard_constraint_violation_rate"] == 0.0 and m["items_checked"] > 100
    assert m["nutrition_errors"] == 0 and m["ranking_inconsistencies"] == 0
    categories = {c["category"] for c in spec["cases"]}
    assert categories == {"high_protein", "low_budget", "vegetarian", "exclusions", "meal_types", "repeated",
                          "missing_catalogue", "no_suitable", "macro_distribution", "diversity"}
