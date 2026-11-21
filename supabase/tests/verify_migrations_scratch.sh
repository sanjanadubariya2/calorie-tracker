#!/usr/bin/env bash
# Verifies the migration sequence from an EMPTY database, the way the hosted
# project will run it, without touching the local dev database:
#   1. creates scratch_migrations in the local Supabase container,
#   2. adds the Supabase-provided pieces (extensions, auth and storage schemas)
#      and HOSTED-style default privileges (new tables granted to anon and
#      authenticated, which each migration must revoke explicitly),
#   3. applies supabase/migrations/0*.sql in order as postgres, stopping at the first error,
#   4. re-applies 019..latest (a retried deployment must not fail),
#   5. runs every pgTAP file against it, and drops the database.
#
#   bash supabase/tests/verify_migrations_scratch.sh
set -uo pipefail

C="${DB_CONTAINER:-supabase_db_calorie-tracker}"
DB=scratch_migrations
D=(docker exec -i "$C")
TMPD="$(mktemp -d)"
trap '"${D[@]}" psql -U supabase_admin -d postgres -qtA -c "drop database if exists $DB" >/dev/null 2>&1; rm -rf "$TMPD"' EXIT

admin() { "${D[@]}" psql -U supabase_admin -d "$1" -v ON_ERROR_STOP=1 -qtA "${@:2}"; }

admin postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null || exit 1
admin "$DB" >/dev/null <<SQL || exit 1
create schema extensions;
grant usage on schema extensions to public;
create extension pgcrypto schema extensions;
create extension pg_trgm schema extensions;
create extension unaccent schema extensions;
create extension "uuid-ossp" schema extensions;
create extension pgtap schema extensions;
alter database $DB set search_path = "\$user", public, extensions;
alter schema public owner to postgres;
grant all on schema extensions to postgres;
grant create on database $DB to postgres;
-- Hosted Supabase defaults for objects created by postgres.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
SQL
"${D[@]}" pg_dump -U supabase_admin -d postgres -s -n auth -n storage --no-owner > "$TMPD/base.sql" 2>/dev/null
admin "$DB" < "$TMPD/base.sql" >/dev/null 2>&1
admin "$DB" -c "grant usage on schema auth, storage to anon, authenticated, service_role;
                grant all on all tables in schema storage to anon, authenticated, service_role;
                grant execute on all functions in schema auth to anon, authenticated, service_role;" >/dev/null

fail=0
apply() {  # file, label
  local out
  out="$("${D[@]}" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q < "$1" 2>&1)"
  if echo "$out" | grep -q ERROR; then
    echo "not ok - $2 $(basename "$1")"; echo "$out" | grep -m3 -A2 ERROR | sed 's/^/    /'; fail=1; return 1
  fi
  echo "ok - $2 $(basename "$1")"
}

for f in supabase/migrations/0*.sql; do apply "$f" "apply" || break; done
if [[ $fail -eq 0 ]]; then
  for f in supabase/migrations/019*.sql supabase/migrations/02*.sql; do apply "$f" "re-apply"; done
fi

if [[ $fail -eq 0 ]]; then
  total=0
  for f in supabase/tests/0*.sql; do
    out="$("${D[@]}" psql -U postgres -d "$DB" -X -q < "$f" 2>&1)"
    n=$(echo "$out" | grep -cE '^\s*ok [0-9]+')
    total=$((total + n))
    if echo "$out" | grep -qE '^\s*not ok [0-9]+|ERROR|Looks like'; then
      echo "not ok - tests $(basename "$f")"; echo "$out" | grep -E 'not ok|ERROR|Looks like|#' | head -6 | sed 's/^/    /'; fail=1
    fi
  done
  echo "pgTAP on the scratch database: $total assertions passed"
fi
exit $fail
