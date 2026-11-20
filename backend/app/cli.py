"""Operational commands. Run from backend/:

  python -m app.cli load-indb PATH.xlsx [--aliases data/indb_aliases_extra.csv]
                                        [--source-version 2024.11] [--dry-run]
      Loads the Indian Nutrient Databank into the food catalogue.
      Needs CATALOGUE_DATABASE_URL (the catalogue_writer role, migration 008).

  python -m app.cli purge-meal-images [--dry-run]
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

    doc = sub.add_parser("assistant-tools-doc", help="write the assistant tool reference (Markdown)")
    doc.add_argument("--out", default="docs/assistant-tools.md")
    doc.set_defaults(func=cmd_tools_doc)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
