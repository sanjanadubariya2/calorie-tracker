"""Deterministic recommendation evaluation (Phase 3, Task 6).

    python -m evals.run_recommendation_eval            # fixture catalogue (evals/recommendation_cases.json)
    python -m evals.run_recommendation_eval --local    # also the real LOCAL catalogue (read-only) + interaction rates

No model, no network (except --local, which reads the local database only).
Every case is checked against its own expectations AND against invariants
computed independently of the engine:

  hard constraint violations   diet / allergies / excluded ingredients / equipment / "never" / max_kcal,
                               re-checked here with separate logic (must be 0)
  nutrition correctness        item nutrition == sum of part per-serving values x servings; servings allowed
  ranking consistency          identical results on re-run and on shuffled input
  diversity                    <= 2 per main ingredient, 1 per group, distinct main ingredients reported
  latency                      engine time per case (ms)

Writes evals/results/recommendations_<timestamp>.json (gitignored). Exit code
1 if any expectation fails or any hard constraint is violated.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import statistics
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from app.recommendations import engine
from app.recommendations.models import Candidate, Nutrition, Part, Request, UserContext, normalize

CASES = Path(__file__).with_name("recommendation_cases.json")
RESULTS = Path(__file__).with_name("results")
DAY = Nutrition(2000, 100, 250, 67)
DIVISIBLE = (0.5, 1.0, 1.5, 2.0)
COUNTABLE = (1.0, 2.0, 3.0, 4.0)

# Independent re-statement of the rules (deliberately not imported from the engine).
ALLOWED = {"vegetarian": {"vegan", "vegetarian"}, "eggetarian": {"vegan", "vegetarian", "egg"},
           "pescatarian": {"vegan", "vegetarian", "egg", "fish"}, "vegan": {"vegan"}, "jain": {"vegan", "vegetarian"}}
SYNONYMS = {"onion": ["pyaz", "pyaaz", "kanda"], "potato": ["aloo", "batata"], "paneer": ["cottage cheese"],
            "garlic": ["lahsun"], "tomato": ["tamatar"]}


def _id(name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"rec-eval/{name}"))


def _nut(n: list[float] | None) -> Nutrition | None:
    return Nutrition(*map(float, n)) if n else None


def build_catalogue(specs: list[dict[str, Any]]) -> list[Candidate]:
    out = []
    for s in specs:
        kind, name = s["kind"], s["name"]
        cid = _id(name)
        common = dict(
            name=name, complete=True, meal_types=frozenset(s.get("meals", [])), regions=frozenset(s.get("regions", [])),
            dish_type=s.get("dish"), main_ingredient=s.get("main"), prep_style=engine.prep_style(name),
            diet_classes=frozenset(s.get("diet", ["unknown"])), diet_status=s.get("diet_status", "inferred"),
            vegan=s.get("vegan"), jain=s.get("jain"), allergens=frozenset(s.get("allergens", [])),
            allergen_status=s.get("allergen_status", "inferred"), quality_flags=frozenset(s.get("flags", [])),
            source="fixture", verification=s.get("verification", "curated"),
            quantities_estimated=bool(s.get("estimated")))
        if kind == "meal":
            parts = tuple(Part("food", _id(c["name"]), c["name"], c["label"], _nut(c["n"]),  # type: ignore[arg-type]
                               engine.range_options(c["min"], c["max"], c["step"]), default=float(c["default"]),
                               serving_grams=float(c["grams"]), slot=None) for c in s["components"])
            out.append(Candidate(kind="meal", key=f"meal:{cid}", group=f"meal:{cid}", parts=parts,
                                 terms=(name, *(c["name"] for c in s["components"])),
                                 dish_names=frozenset(normalize(c["name"]) for c in s["components"]),
                                 dish_food_ids=frozenset(_id(c["name"]) for c in s["components"]),
                                 history_keys=(f"meal:{cid}",), feedback_keys=(f"meal:{cid}",), template_id=cid,
                                 **common))
            continue
        per = _nut(s.get("n"))
        options = COUNTABLE if s.get("countable") or engine.is_countable_label(s["label"]) and kind == "recipe" else DIVISIBLE
        if kind == "food":
            options = COUNTABLE if s.get("countable") else DIVISIBLE
        parts = () if per is None else (Part(kind if kind == "recipe" else "food", cid, name, s["label"], per, options,
                                             serving_grams=float(s["grams"]) if kind == "food" else None,
                                             yields=float(s.get("yields", 1)),
                                             ingredients=tuple({"food_name": i} for i in s.get("ingredients", []))),)
        if kind == "recipe":
            out.append(Candidate(kind="recipe", key=f"recipe:{cid}", group=f"family:{cid}", parts=parts,
                                 terms=(name, *s.get("ingredients", [])), dish_names=frozenset({normalize(name)}),
                                 history_keys=(f"recipe:{cid}",), feedback_keys=(f"family:{cid}",), recipe_id=cid,
                                 family_id=cid, total_minutes=s.get("minutes"),
                                 equipment=frozenset(s["equipment"]) if "equipment" in s else None,
                                 **{**common, "complete": per is not None}))
        else:
            out.append(Candidate(kind="food", key=f"food:{cid}", group=f"food:{cid}", parts=parts,
                                 terms=tuple(s.get("terms", [name])), dish_names=frozenset({normalize(name)}),
                                 dish_food_ids=frozenset({cid}), history_keys=(f"food:{cid}",),
                                 feedback_keys=(f"food:{cid}",), food_id=cid,
                                 **{**common, "complete": per is not None}))
    return out


def build_context(spec: dict[str, Any]) -> UserContext:
    targets = spec.get("targets", "default")
    remaining = spec.get("remaining", "default")
    return UserContext(
        local_date=dt.date(2026, 11, 21), goal=spec.get("goal", "maintain"),
        targets=DAY if targets == "default" else _nut(targets),
        remaining=DAY if remaining == "default" else _nut(remaining),
        has_preferences=True, diet=spec.get("diet"), allergies=frozenset(spec.get("allergies", [])),
        dislikes=tuple(spec.get("dislikes", [])), cuisines=tuple(spec.get("cuisines", [])),
        excluded_ingredients=tuple(spec.get("excluded_ingredients", [])),
        equipment=frozenset(spec["equipment"]) if "equipment" in spec else None,
        feedback=spec.get("feedback", {}), shows={k: tuple(v) for k, v in spec.get("shows", {}).items()})


def build_request(spec: dict[str, Any]) -> Request:
    return Request(meal_type=spec["meal_type"], count=spec.get("count", 5), mode=spec.get("mode", "both"),
                   tolerance=spec.get("tolerance", "standard"), max_kcal=spec.get("max_kcal"),
                   protein=spec.get("protein", "normal"), cuisine=spec.get("cuisine"))


# ------------------------------------------------------------------ independent invariants

def _mentions(term: str, texts: list[str]) -> bool:
    import re
    words = [normalize(term)] + SYNONYMS.get(normalize(term), [])
    return any(re.search(rf"\b{re.escape(w)}(e?s)?\b", t) for w in words for t in texts)


def violations(result: engine.EngineResult, ctx: UserContext, req: Request) -> list[str]:
    out = []
    for r in result.items:
        c = r.candidate
        if ctx.diet in ALLOWED:
            if not c.diet_classes <= ALLOWED[ctx.diet]:
                out.append(f"{c.name}: diet {sorted(c.diet_classes)} not allowed for {ctx.diet}")
            if ctx.diet == "vegan" and c.vegan is not True:
                out.append(f"{c.name}: not reviewed vegan")
            if ctx.diet == "jain" and c.jain is not True:
                out.append(f"{c.name}: not reviewed Jain")
        if ctx.allergies:
            if ctx.allergies & c.allergens:
                out.append(f"{c.name}: contains a declared allergen")
            if c.allergen_status != "reviewed":
                out.append(f"{c.name}: allergens not reviewed for an allergic user")
        texts = [normalize(t) for t in c.terms]
        for term in ctx.excluded_ingredients:
            if _mentions(term, texts):
                out.append(f"{c.name}: contains excluded {term}")
        if ctx.equipment is not None and c.equipment is not None and not c.equipment <= ctx.equipment:
            out.append(f"{c.name}: needs {sorted(c.equipment - ctx.equipment)}")
        if any(ctx.feedback.get(k) == "never" for k in c.feedback_keys):
            out.append(f"{c.name}: marked never")
        if req.max_kcal is not None and r.nutrition.kcal > req.max_kcal + 1e-9:
            out.append(f"{c.name}: {r.nutrition.kcal} kcal over max {req.max_kcal}")
        if not c.complete or c.quality_flags & {"energy_mismatch"}:
            out.append(f"{c.name}: unreliable or incomplete nutrition recommended")
    return out


def nutrition_errors(result: engine.EngineResult) -> list[str]:
    out = []
    for r in result.items:
        expected = Nutrition(0, 0, 0, 0)
        for p, s in zip(r.candidate.parts, r.servings, strict=True):
            if s not in p.options:
                out.append(f"{r.candidate.name}: {s} servings not allowed")
            expected = expected + p.per_serving.scaled(s)
        for field in ("kcal", "protein_g", "carbs_g", "fat_g"):
            if abs(getattr(expected, field) - getattr(r.nutrition, field)) > 1e-6:
                out.append(f"{r.candidate.name}: {field} {getattr(r.nutrition, field)} != {getattr(expected, field)}")
    return out


def diversity(result: engine.EngineResult) -> dict[str, Any]:
    mains = [r.candidate.main_ingredient for r in result.items if r.candidate.main_ingredient]
    groups = [r.candidate.group for r in result.items]
    over = [m for m in set(mains) if mains.count(m) > 2]
    return {"items": len(result.items), "distinct_main": len(set(mains)), "max_same_main": max(map(mains.count, mains), default=0),
            "duplicate_groups": len(groups) - len(set(groups)), "violations": over}


def signature(result: engine.EngineResult) -> list[tuple]:
    return [(r.candidate.key, r.servings, round(r.score, 9)) for r in result.items]


# ------------------------------------------------------------------ expectations

def check_expect(exp: dict[str, Any], result: engine.EngineResult, run: Any) -> list[str]:
    fails: list[str] = []
    names = [r.candidate.name for r in result.items]
    items = result.items
    top = items[0] if items else None

    def need(cond: bool, msg: str) -> None:
        if not cond:
            fails.append(msg)

    if "status" in exp:
        need(result.status == exp["status"], f"status {result.status} != {exp['status']}")
    if "status_in" in exp:
        need(result.status in exp["status_in"], f"status {result.status} not in {exp['status_in']}")
    if "min_items" in exp:
        need(len(items) >= exp["min_items"], f"{len(items)} items < {exp['min_items']}")
    if "max_items" in exp:
        need(len(items) <= exp["max_items"], f"{len(items)} items > {exp['max_items']}")
    for n in exp.get("exclude", []):
        need(n not in names, f"{n} recommended")
    for n in exp.get("exclude_kinds_with", []):
        need(not any(n in x for x in names), f"something containing {n} recommended")
    if "include_any" in exp:
        need(bool(set(exp["include_any"]) & set(names)), f"none of {exp['include_any']} in {names}")
    if "only" in exp:
        need(set(names) <= set(exp["only"]), f"{names} not within {exp['only']}")
    if "min_protein_share" in exp:
        for r in items:
            need(r.nutrition.protein_g * 4 / r.nutrition.kcal >= exp["min_protein_share"] - 1e-9,
                 f"{r.candidate.name} protein share too low")
    if "max_item_kcal" in exp:
        for r in items:
            need(r.nutrition.kcal <= exp["max_item_kcal"], f"{r.candidate.name} {r.nutrition.kcal} kcal")
    if "budget_mode" in exp:
        need(result.budget.mode == exp["budget_mode"], f"budget mode {result.budget.mode}")
    if "basis" in exp:
        need(result.budget.basis == exp["basis"], f"basis {result.budget.basis}")
    if "note_contains" in exp:
        need(any(exp["note_contains"] in n for n in result.notes), f"no note with {exp['note_contains']!r}")
    if "kinds" in exp:
        need(all(r.candidate.kind in exp["kinds"] for r in items), "unexpected kind")
    if top is not None:
        if "top_min_protein_g" in exp:
            need(top.nutrition.protein_g >= exp["top_min_protein_g"], f"top protein {top.nutrition.protein_g}")
        if "top_max_carbs_g" in exp:
            need(top.nutrition.carbs_g <= exp["top_max_carbs_g"], f"top carbs {top.nutrition.carbs_g}")
        if "top_max_fat_g" in exp:
            need(top.nutrition.fat_g <= exp["top_max_fat_g"], f"top fat {top.nutrition.fat_g}")
        if "top_meal_type" in exp:
            need(exp["top_meal_type"] in top.candidate.meal_types, f"top {top.candidate.name} not a {exp['top_meal_type']}")
        if "top_region" in exp:
            need(exp["top_region"] in top.candidate.regions, f"top {top.candidate.name} not {exp['top_region']}")
    if "all_meal_type" in exp:
        for r in items:
            need(not r.candidate.meal_types or exp["all_meal_type"] in r.candidate.meal_types,
                 f"{r.candidate.name} is not a {exp['all_meal_type']} dish")
    if "include_region" in exp:
        need(any(exp["include_region"] in r.candidate.regions for r in items), f"no {exp['include_region']} item")
    if "min_distinct_main" in exp:
        need(diversity(result)["distinct_main"] >= exp["min_distinct_main"], "too few distinct main ingredients")
    if exp.get("repeat") and top is not None:
        key = top.candidate.history_keys[0]
        shown = run({"shows": {key: [0.0, 0.0, 0.0]}})
        need(bool(shown.items) and shown.items[0].candidate.key != top.candidate.key, "top did not rotate after repeats")
        later = run({"shows": {key: [8.0, 8.0, 8.0]}})
        need(bool(later.items) and later.items[0].candidate.key == top.candidate.key,
             "repeats penalised beyond the novelty window")
    if "feedback_top" in exp and top is not None:
        fb = run({"feedback": {k: exp["feedback_top"] for k in top.candidate.feedback_keys}})
        keys = [r.candidate.key for r in fb.items]
        need(not keys or keys[0] != top.candidate.key, f"{exp['feedback_top']}: top unchanged")
        if exp["feedback_top"] == "never":
            need(top.candidate.key not in keys, "never: still recommended")
    return fails


# ------------------------------------------------------------------ runner

def run_cases(catalogue: list[Candidate], cases: list[dict[str, Any]], label: str,
              use_expectations: bool = True) -> dict[str, Any]:
    by_name = {c.name: c for c in catalogue}
    rows, times, all_viol, all_nut, inconsistent = [], [], [], [], 0
    for case in cases:
        cands = [by_name[n] for n in case["catalogue_names"]] if "catalogue_names" in case and use_expectations \
            else catalogue
        base_ctx = case.get("context", {})
        req = build_request(case["request"])

        def run(extra: dict[str, Any] | None = None, shuffled: int | None = None,
                cands=cands, base_ctx=base_ctx, req=req) -> engine.EngineResult:
            pool = list(cands)
            if shuffled is not None:
                random.Random(shuffled).shuffle(pool)
            return engine.recommend(pool, build_context({**base_ctx, **(extra or {})}), req)

        t = time.perf_counter()
        result = run()
        times.append((time.perf_counter() - t) * 1000)
        consistent = all(signature(run(shuffled=s)) == signature(result) for s in range(3)) and \
            signature(run()) == signature(result)
        inconsistent += not consistent
        ctx = build_context(base_ctx)
        viol = violations(result, ctx, req)
        nut = nutrition_errors(result)
        div = diversity(result)
        fails = check_expect(case.get("expect", {}), result, run) if use_expectations else []
        if div["violations"] or div["duplicate_groups"]:
            fails.append(f"diversity caps broken: {div}")
        if not consistent:
            fails.append("ranking not consistent across runs / input order")
        all_viol += viol
        all_nut += nut
        rows.append({"id": case["id"], "category": case["category"], "status": result.status,
                     "items": [f"{r.candidate.name} x{'+'.join(f'{s:g}' for s in r.servings)} "
                               f"{r.nutrition.kcal:.0f} kcal ({r.score:.2f})" for r in result.items],
                     "violations": viol, "nutrition_errors": nut, "diversity": div, "failures": fails,
                     "ms": round(times[-1], 2)})
    n_items = sum(len(r["items"]) for r in rows)
    return {
        "catalogue": label, "candidates": len(catalogue), "cases": len(rows),
        "passed": sum(1 for r in rows if not r["failures"] and not r["violations"] and not r["nutrition_errors"]),
        "metrics": {
            "hard_constraint_violation_rate": (len(all_viol) / n_items) if n_items else 0.0,
            "hard_constraint_violations": len(all_viol),
            "items_checked": n_items,
            "nutrition_errors": len(all_nut),
            "ranking_inconsistencies": inconsistent,
            "mean_distinct_main_ratio": round(statistics.mean(
                [r["diversity"]["distinct_main"] / r["diversity"]["items"] for r in rows if r["diversity"]["items"]] or [1]), 3),
            "latency_ms_p50": round(statistics.median(times), 2),
            "latency_ms_max": round(max(times), 2),
        },
        "rows": rows,
    }


def local_catalogue() -> list[Candidate]:
    """The real local candidates (read-only), mapped exactly as the API does."""
    from decimal import Decimal

    import psycopg
    from psycopg.rows import dict_row

    from app.recommendations.repository import food_candidate, recipe_candidate, template_candidate

    def clean(v: Any) -> Any:
        if isinstance(v, Decimal):
            return float(v)
        if isinstance(v, list):
            return [clean(x) for x in v]
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items()}
        if isinstance(v, uuid.UUID):
            return str(v)
        return v

    dsn = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        foods = [food_candidate(clean(r)) for r in conn.execute("select * from recommendation_food_candidates()")]
        recipes = [recipe_candidate(clean(r)) for r in conn.execute("select * from recommendation_recipe_candidates()")]
        templates = [template_candidate(clean(r)) for r in conn.execute("select * from recommendation_template_candidates()")]
    return foods + recipes + templates


def interaction_rates() -> dict[str, Any]:
    """Selection / rejection rates from real interaction data (local database)."""
    import psycopg
    dsn = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    # Real users only: throwaway accounts created by the test suites are excluded.
    real = "join auth.users u on u.id = x.user_id where u.email not like '%%@test.local'"
    with psycopg.connect(dsn) as conn:
        shown = conn.execute(f"select count(*) from public.recommendation_items x {real}").fetchone()[0]
        counts = dict(conn.execute(f"select event, count(distinct (set_id, rank)) from public.recommendation_events x "
                                   f"{real} group by event").fetchall())
    if shown < 200:
        return {"shown": shown, "events": counts,
                "note": "Too few real interactions for meaningful rates (needs >= 200 shown recommendations)."}
    return {"shown": shown, "events": counts,
            "selection_rate": round(counts.get("selected", 0) / shown, 4),
            "rejection_rate": round(counts.get("rejected", 0) / shown, 4),
            "logged_rate": round(counts.get("logged", 0) / shown, 4)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", action="store_true", help="also evaluate the real local catalogue (read-only)")
    args = ap.parse_args(argv)
    spec = json.loads(CASES.read_text(encoding="utf-8"))
    reports = [run_cases(build_catalogue(spec["catalogue"]), spec["cases"], "fixture")]
    extra: dict[str, Any] = {}
    if args.local:
        reports.append(run_cases(local_catalogue(), [c for c in spec["cases"] if "catalogue_names" not in c],
                                 "local", use_expectations=False))
        extra["interactions"] = interaction_rates()
    ok = True
    for rep in reports:
        m = rep["metrics"]
        print(f"\n[{rep['catalogue']}] {rep['passed']}/{rep['cases']} cases clean, {rep['candidates']} candidates")
        for k, v in m.items():
            print(f"  {k}: {v}")
        for row in rep["rows"]:
            problems = row["failures"] + row["violations"] + row["nutrition_errors"]
            if problems:
                ok = False
                print(f"  FAIL {row['id']}: {problems}")
        if m["hard_constraint_violations"] or m["nutrition_errors"] or m["ranking_inconsistencies"]:
            ok = False
    if extra:
        print(f"\n[interactions] {extra['interactions']}")
    RESULTS.mkdir(exist_ok=True)
    out = RESULTS / f"recommendations_{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps({"reports": reports, **extra}, indent=2, default=str), encoding="utf-8")
    print(f"\nwrote {out}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
