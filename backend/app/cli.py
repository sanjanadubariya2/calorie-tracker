"""Operational commands. Run from backend/:

  python -m app.cli load-indb PATH.xlsx [--aliases data/indb_aliases_extra.csv]
                                        [--source-version 2024.11] [--dry-run]
      Loads the Indian Nutrient Databank into the food catalogue.
      Needs CATALOGUE_DATABASE_URL (the catalogue_writer role, migration 008).

  python -m app.cli purge-meal-images [--dry-run]
  python -m app.cli load-staples <SR Legacy CSV dir> [--dry-run]   (CATALOGUE_DATABASE_URL)
  python -m app.cli classify-foods --out data/food_attributes_review.csv [--apply]   (CATALOGUE_DATABASE_URL)
  python -m app.cli purge-assistant-conversations   (needs ASSISTANT_DATABASE_URL)
      Deletes expired meal photos (object first, then row).
      Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. The service-role key is
      used ONLY by this command, in its own environment; the API server never
      reads it. Run it from a trusted machine or scheduled job.

Neither command prints secrets.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import httpx

DEFAULT_ALIASES = Path(__file__).resolve().parent.parent / "data" / "indb_aliases_extra.csv"


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"error: {name} is not set")
    return value


def cmd_load_indb(args: argparse.Namespace) -> int:
    from app.services.catalogue import indb, writer

    path = Path(args.path)
    if not path.is_file():
        sys.exit(f"error: {path} not found")
    rows = indb.read_workbook(path)
    report = indb.map_rows(rows, args.source_version)
    if args.aliases:
        indb.apply_extra_aliases(report, Path(args.aliases))

    aliases = sum(len(r.aliases) for r in report.records)
    servings = sum(len(r.servings) for r in report.records)
    categorized = sum(1 for r in report.records if r.category)
    print(f"rows read:        {len(rows)}")
    print(f"valid foods:      {len(report.records)}  (categorised: {categorized})")
    print(f"aliases:          {aliases}")
    print(f"default servings: {servings}")
    print(f"rejected rows:    {len(report.errors)}")
    for code, reason in report.errors[:20]:
        print(f"  - {code}: {reason}")
    if report.unknown_alias_codes:
        print(f"alias file codes not in this INDB version: {sorted(set(report.unknown_alias_codes))}")

    if args.dry_run:
        print("dry run: nothing written")
        return 0
    inserted, updated = writer.write_records(_require_env("CATALOGUE_DATABASE_URL"), report.records)
    print(f"written: {inserted} inserted, {updated} updated")
    return 0


def cmd_purge_meal_images(args: argparse.Namespace) -> int:
    base = _require_env("SUPABASE_URL").rstrip("/")
    key = _require_env("SUPABASE_SERVICE_ROLE_KEY")
    bucket = os.environ.get("MEAL_IMAGES_BUCKET", "meal-images")
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}

    with httpx.Client(timeout=30) as http:
        response = http.get(
            f"{base}/rest/v1/meal_images",
            params={"select": "id,storage_path", "expires_at": "lt.now()", "limit": "1000"},
            headers=headers,
        )
        response.raise_for_status()
        expired = response.json()
        print(f"expired images: {len(expired)}")
        if args.dry_run:
            print("dry run: nothing deleted")
            return 0
        deleted = 0
        for row in expired:
            object_response = http.delete(f"{base}/storage/v1/object/{bucket}/{row['storage_path']}", headers=headers)
            if object_response.status_code not in (200, 204, 400, 404):
                print(f"  could not delete object for {row['id']}: HTTP {object_response.status_code}")
                continue
            http.delete(f"{base}/rest/v1/meal_images", params={"id": f"eq.{row['id']}"}, headers=headers).raise_for_status()
            deleted += 1
        print(f"deleted: {deleted}")
    return 0


def cmd_purge_assistant(args: argparse.Namespace) -> int:
    """Deletes conversations past their retention date (messages and tool
    records go with them). Uses assistant_writer, which can delete ONLY
    expired conversations (migration 011 policy)."""
    from app.assistant.store import AssistantWriter

    writer = AssistantWriter(_require_env("ASSISTANT_DATABASE_URL"), retention_days=90)
    deleted = writer._run_sync(writer.purge_expired)
    print(f"deleted {deleted} expired conversation(s)")
    return 0


def cmd_tools_doc(args: argparse.Namespace) -> int:
    from app.assistant.tools.registry import tools_markdown

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(tools_markdown())
    print(f"wrote {args.out}")
    return 0


def cmd_classify_foods(args: argparse.Namespace) -> int:
    """Infers food attributes and writes a review CSV. With --apply, stores the
    INFERRED attributes in a LOCAL database (never production, never over a
    reviewed row). Reviewed values only come from a person, via a later import."""
    import csv
    import urllib.parse

    import psycopg
    from psycopg.rows import dict_row

    from app.services.catalogue.attributes import CLASSIFIER_VERSION, FoodInput, classify

    url = _require_env("CATALOGUE_DATABASE_URL")
    host = urllib.parse.urlsplit(url).hostname or ""
    if args.apply and host not in ("127.0.0.1", "localhost"):
        print("refusing --apply against a non-local database; attributes are applied only after review")
        return 2
    with psycopg.connect(url, row_factory=dict_row, prepare_threshold=None) as conn:
        foods = conn.execute("""
            select f.id::text, f.source_ref, f.name, f.category,
                   (select s.label from public.food_servings s where s.food_id = f.id and s.is_default limit 1) as serving,
                   coalesce((select array_agg(a.alias) from public.food_aliases a where a.food_id = f.id), '{}') as aliases
            from public.foods f where f.is_active order by f.name""").fetchall()
        results = [(f, classify(FoodInput(food_id=f["id"], source_ref=f["source_ref"], name=f["name"],
                                          category=f["category"], aliases=list(f["aliases"]), serving_label=f["serving"])))
                   for f in foods]
        if args.apply:
            with conn.transaction():
                for f, a in results:
                    conn.execute("""
                        insert into public.food_attributes (food_id, diet_class, diet_status, vegan_compatible, jain_compatible,
                          allergens, allergen_status, regions, meal_types, countable, source, classifier_version, reasons)
                        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'classifier', %s, %s)
                        on conflict (food_id) do update set
                          diet_class = excluded.diet_class, diet_status = excluded.diet_status,
                          vegan_compatible = excluded.vegan_compatible, jain_compatible = excluded.jain_compatible,
                          allergens = excluded.allergens, allergen_status = excluded.allergen_status,
                          regions = excluded.regions, meal_types = excluded.meal_types, countable = excluded.countable,
                          classifier_version = excluded.classifier_version, reasons = excluded.reasons
                        where public.food_attributes.source = 'classifier'""",
                        (f["id"], a.diet_class, a.diet_status, a.vegan_compatible, a.jain_compatible, a.allergens,
                         a.allergen_status, a.regions, a.meal_types, a.countable, CLASSIFIER_VERSION, a.reasons))

    order = {"high": 0, "medium": 1, "low": 2}
    results.sort(key=lambda r: (order[r[1].review_priority], r[0]["name"].lower()))
    yn = lambda v: "" if v is None else ("yes" if v else "no")  # noqa: E731
    with open(args.out, "w", encoding="utf-8", newline="") as out:
        w = csv.writer(out)
        w.writerow(["review_priority", "source_ref", "name", "category", "default_serving",
                    "diet_class", "diet_status", "vegan_compatible", "jain_compatible", "allergens_detected",
                    "allergen_status", "regions", "meal_types", "countable", "reasons",
                    "REVIEW_diet_class", "REVIEW_vegan_compatible", "REVIEW_jain_compatible",
                    "REVIEW_allergens_present", "REVIEW_allergen_list_complete", "REVIEW_notes"])
        for f, a in results:
            w.writerow([a.review_priority, f["source_ref"], f["name"], f["category"] or "", f["serving"] or "",
                        a.diet_class, a.diet_status, yn(a.vegan_compatible), yn(a.jain_compatible),
                        "|".join(a.allergens), a.allergen_status, "|".join(a.regions), "|".join(a.meal_types),
                        yn(a.countable), "; ".join(a.reasons), "", "", "", "", "", ""])
    counts: dict[str, int] = {}
    for _, a in results:
        counts[f"{a.diet_class}/{a.diet_status}"] = counts.get(f"{a.diet_class}/{a.diet_status}", 0) + 1
    print(f"classified {len(results)} foods -> {args.out}" + (" (applied locally as 'inferred')" if args.apply else ""))
    print("diet:", ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    print("review priority:", ", ".join(f"{p}={sum(1 for _, a in results if a.review_priority == p)}" for p in order))
    print("allergen status:", ", ".join(f"{s_}={sum(1 for _, a in results if a.allergen_status == s_)}" for s_ in ("inferred", "unknown")))
    return 0


def cmd_meal_templates_report(args: argparse.Namespace) -> int:
    """Validates the draft meal templates against the catalogue and writes a
    review report. Read-only: it never loads or approves templates."""
    import psycopg
    from psycopg.rows import dict_row

    from app.services.catalogue.serving_audit import build_audit, write_audit
    from app.services.catalogue.templates import (
        build_report,
        read_csv,
        read_decisions,
        read_review_status,
        write_corrections,
        write_review_status,
    )

    templates, problems = read_csv(Path(args.csv))
    status_path = Path(args.review_status)
    review, review_problems = read_review_status(status_path, [t.slug for t in templates])
    if not status_path.exists():               # every template starts unreviewed; only a person changes this
        write_review_status(status_path, review)
    decisions = read_decisions(Path(args.decisions))
    url = os.environ.get("REPORT_DATABASE_URL") or _require_env("CATALOGUE_DATABASE_URL")
    with psycopg.connect(url, row_factory=dict_row, prepare_threshold=None) as conn:
        conn.read_only = True
        report, blocking, proposals, flags = build_report(conn, templates, problems, review, review_problems,
                                                          decisions)
        used_by: dict[str, list[str]] = {}
        for t in templates:
            for c in t.components:
                used_by.setdefault(c.source_ref, []).append(t.slug)
        generic = {}
        for f in flags:
            if f.check == "serving_weight":
                comp = next(c for t in templates if t.slug == f.slug for c in t.components if c.position == f.position)
                generic[comp.source_ref] = f.message.split(" Serving-weight audit:")[0]
        indb = Path(args.indb) if args.indb else None
        audit = build_audit(conn, used_by, generic, indb)
    Path(args.out).write_text(report, encoding="utf-8")
    write_corrections(Path(args.corrections), proposals, flags, decisions)
    write_audit(Path(args.audit_csv), Path(args.audit_md), audit)
    by = {s: sum(1 for f in flags if f.severity == s) for s in ("correction", "review", "info")}
    print(f"{len(templates)} templates, {sum(len(t.components) for t in templates)} components -> {args.out}; "
          f"blocking problems: {blocking}; flags: {len(flags)} ({by['correction']} correction, {by['review']} review, "
          f"{by['info']} info); proposals: {len(proposals)}; decisions: {len(decisions)} -> {args.corrections}; "
          f"serving-weight audit: {len(audit)} foods -> {args.audit_md}")
    return 1 if blocking else 0


def cmd_load_staples(args: argparse.Namespace) -> int:
    """Imports the staples listed in data/staples_usda.csv from a USDA SR Legacy
    CSV download. Aliases that would collide with another source's food are
    dropped (so existing matches don't become ambiguous); a colliding NAME stops
    the import. Writes only to a local database unless --allow-remote is given."""
    import urllib.parse

    import psycopg

    from app.services.catalogue.usda import load_records, read_specs
    from app.services.catalogue.writer import write_records

    specs = read_specs(Path(args.staples))
    records, problems = load_records(Path(args.sr_dir), specs)
    url = _require_env("CATALOGUE_DATABASE_URL")
    host = urllib.parse.urlsplit(url).hostname or ""
    collisions: list[str] = []
    with psycopg.connect(url, prepare_threshold=None) as conn:
        def owner(text: str) -> str | None:
            row = conn.execute("""
                select f.name from public.foods f
                where f.is_active and f.source <> 'usda_fdc'
                  and (f.normalized_name = public.normalize_food_name(%s)
                       or exists (select 1 from public.food_aliases a where a.food_id = f.id
                                  and a.normalized_alias = public.normalize_food_name(%s)))
                limit 1""", (text, text)).fetchone()
            return row[0] if row else None

        # Two staples must not normalise to the same text either ("2% milk" -> "milk").
        seen: dict[str, str] = {}
        for rec in records:
            for text in [rec.name, *(a.alias for a in rec.aliases)]:
                norm = conn.execute("select public.normalize_food_name(%s)", (text,)).fetchone()[0]
                if norm in seen and seen[norm] != rec.name:
                    problems.append(f"{rec.name}: {text!r} normalises to {norm!r}, same as {seen[norm]!r}")
                seen.setdefault(norm, rec.name)

        for rec in records:
            clash = owner(rec.name)
            if clash:
                problems.append(f"{rec.name}: name collides with existing food {clash!r}; rename it")
            kept = []
            for alias in rec.aliases:
                other = owner(alias.alias)
                if other:
                    collisions.append(f"{rec.name}: alias {alias.alias!r} dropped (matches {other!r})")
                else:
                    kept.append(alias)
            rec.aliases = kept

    print(f"{len(records)} staples read from SR Legacy; {len(problems)} problem(s), {len(collisions)} alias collision(s)")
    for line in problems + collisions:
        print("  -", line)
    for rec in records:
        default = next(s for s in rec.servings if s.is_default)
        print(f"  {rec.source_ref:>7} {rec.name:<34} {rec.category:<11} {rec.kcal_per_100:>6} kcal/100 g  "
              f"P {rec.protein_g_per_100:<5} C {rec.carbs_g_per_100:<5} F {rec.fat_g_per_100:<5}  default: {default.label}")
    if problems:
        print("not written: fix the problems above")
        return 1
    if args.dry_run:
        print("dry run: nothing written")
        return 0
    if host not in ("127.0.0.1", "localhost") and not args.allow_remote:
        print("refusing to write to a non-local database without --allow-remote")
        return 2
    inserted, updated = write_records(url, records)
    print(f"written: {inserted} inserted, {updated} updated")
    return 0


def cmd_recipes(args: argparse.Namespace) -> int:
    """Validates the draft recipes, loads them as DRAFTS (local database only,
    unless --allow-remote), and writes a review report with database-computed
    nutrition. --dry-run validates and reports without writing."""
    import urllib.parse

    import psycopg
    from psycopg.rows import dict_row

    from app.services.catalogue.recipes import build_report, load_drafts, read_drafts, resolve_foods

    recipes, problems = read_drafts(Path(args.recipes), Path(args.ingredients))
    url = _require_env("CATALOGUE_DATABASE_URL")
    host = urllib.parse.urlsplit(url).hostname or ""
    notes: list[str] = []
    with psycopg.connect(url, row_factory=dict_row, prepare_threshold=None) as conn:
        foods, ref_problems = resolve_foods(conn, recipes)
        problems += ref_problems
        if not problems and not args.dry_run:
            if host not in ("127.0.0.1", "localhost") and not args.allow_remote:
                print("refusing to write to a non-local database without --allow-remote")
                return 2
            notes = load_drafts(conn, recipes, foods, args.source_name)
        report = build_report(conn, recipes, foods, problems, notes)
    Path(args.out).write_text(report, encoding="utf-8")
    loaded = "validated only" if args.dry_run or problems else "loaded as drafts"
    print(f"{len(recipes)} recipes, {sum(len(r.ingredients) for r in recipes)} ingredients: {loaded}; "
          f"{len(problems)} blocking problem(s) -> {args.out}")
    for p in problems + notes:
        print("  -", p)
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    load = sub.add_parser("load-indb", help="load the Indian Nutrient Databank workbook")
    load.add_argument("path")
    load.add_argument("--aliases", default=str(DEFAULT_ALIASES), help="extra everyday-name aliases CSV ('' to skip)")
    load.add_argument("--source-version", default="2024.11")
    load.add_argument("--dry-run", action="store_true")
    load.set_defaults(func=cmd_load_indb)

    purge = sub.add_parser("purge-meal-images", help="delete expired meal photos")
    purge.add_argument("--dry-run", action="store_true")
    purge.set_defaults(func=cmd_purge_meal_images)

    purge_chats = sub.add_parser("purge-assistant-conversations", help="delete expired assistant conversations")
    purge_chats.set_defaults(func=cmd_purge_assistant)

    st = sub.add_parser("load-staples", help="import USDA staples listed in data/staples_usda.csv")
    st.add_argument("sr_dir", help="folder of the USDA SR Legacy CSV download")
    st.add_argument("--staples", default="data/staples_usda.csv")
    st.add_argument("--dry-run", action="store_true")
    st.add_argument("--allow-remote", action="store_true", help="allow writing to a non-local database")
    st.set_defaults(func=cmd_load_staples)

    cls = sub.add_parser("classify-foods", help="infer food attributes and write a review CSV")
    cls.add_argument("--out", default="data/food_attributes_review.csv")
    cls.add_argument("--apply", action="store_true", help="store inferred attributes (local database only)")
    cls.set_defaults(func=cmd_classify_foods)

    rec = sub.add_parser("load-recipes", help="validate draft recipes, load them as drafts, write a review report")
    rec.add_argument("--recipes", default="data/recipes_draft.csv")
    rec.add_argument("--ingredients", default="data/recipe_ingredients_draft.csv")
    rec.add_argument("--out", default="data/recipes_review.md")
    rec.add_argument("--source-name", default="Curated draft (needs review)")
    rec.add_argument("--dry-run", action="store_true")
    rec.add_argument("--allow-remote", action="store_true", help="allow writing to a non-local database")
    rec.set_defaults(func=cmd_recipes)

    rep_ = sub.add_parser("meal-templates-report", help="validate draft meal templates and write a review report")
    rep_.add_argument("--csv", default="data/meal_templates_draft.csv")
    rep_.add_argument("--out", default="data/meal_templates_review.md")
    rep_.add_argument("--review-status", default="data/meal_templates_review_status.csv",
                      help="human review decisions (created with every template 'pending' if missing)")
    rep_.add_argument("--corrections", default="data/meal_templates_corrections.csv")
    rep_.add_argument("--decisions", default="data/meal_templates_decisions.csv",
                      help="human decisions applied or rejected (read-only here)")
    rep_.add_argument("--audit-csv", default="data/serving_weight_audit.csv")
    rep_.add_argument("--audit-md", default="data/serving_weight_audit.md")
    rep_.add_argument("--indb", default=os.environ.get("INDB_XLSX") or (
        "../Anuvaad_INDB_2024.11.xlsx" if Path("../Anuvaad_INDB_2024.11.xlsx").exists() else None),
        help="INDB workbook, to re-check that every nutrient implies the same serving weight")
    rep_.set_defaults(func=cmd_meal_templates_report)

    doc = sub.add_parser("assistant-tools-doc", help="write the assistant tool reference (Markdown)")
    doc.add_argument("--out", default="docs/assistant-tools.md")
    doc.set_defaults(func=cmd_tools_doc)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
