#!/usr/bin/env bash
# Concurrency checks for migration 022 (local dev database only).
#
# pgTAP runs inside one transaction, so races need real parallel sessions.
# This script commits a small fixture (users prefixed f0220000-), fires
# parallel sessions at the same rows, checks the invariants, and deletes the
# fixture again. Never point it at a shared or production database.
#
#   bash supabase/tests/concurrency/022_challenges_concurrency.sh
set -euo pipefail

CONTAINER="${DB_CONTAINER:-supabase_db_calorie-tracker}"
N="${N:-12}"
A="f0220000-0000-0000-0000-0000000000a1"
APP_CH="f0220000-0000-0000-0000-00000000c001"
LOG_CH="f0220000-0000-0000-0000-00000000c002"
CHK_CH="f0220000-0000-0000-0000-00000000c003"

psql_() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }
# Parallel sessions log errors here: every racing call must succeed, not just leave valid data.
ERRLOG="$(mktemp -d)"   # one file per session: concurrent appends to one file can be lost
as_a() {
  printf "set role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', false); %s\n" "$A" "$1" | psql_ >/dev/null 2>"$(mktemp -p "$ERRLOG")"
}

cleanup() {
  psql_ <<SQL >/dev/null
delete from public.challenges where id in ('$APP_CH', '$LOG_CH', '$CHK_CH');
delete from auth.users where id = '$A';
SQL
}
trap cleanup EXIT
cleanup

psql_ <<SQL >/dev/null
insert into auth.users (id, email) values ('$A', 'concurrency-a@test.local');
insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, username)
values ('$A', 30, 170, 70, 'female', 'maintain', 'conc_a');
-- An open app challenge, a log challenge 4 days in, and a check-in challenge 4 days in (target 5).
insert into public.challenges (id, template_code, kind, creator_id, starts_on, ends_on) values
  ('$APP_CH', 'breakfast-5-days', 'app', null, current_date - 2, current_date + 4),
  ('$LOG_CH', 'log-5-days', 'individual', '$A', current_date - 6, current_date),
  ('$CHK_CH', 'walk-5-days', 'individual', '$A', current_date - 6, current_date);
insert into public.challenge_participants (challenge_id, user_id, status, joined_at) values
  ('$LOG_CH', '$A', 'active', now()), ('$CHK_CH', '$A', 'active', now());
-- Entered on their own days (only on-time days count, migration 027).
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g, created_at)
select '$A', current_date - d, 'lunch', 'conc', 300, 30, 5, 10, (current_date - d) + time '12:00' from generate_series(2, 5) d;
insert into public.challenge_checkins (challenge_id, user_id, day)
select '$CHK_CH', '$A', current_date - d from generate_series(2, 5) d;
select public.refresh_challenge_participant('$LOG_CH', '$A');
select public.refresh_challenge_participant('$CHK_CH', '$A');
SQL

fail=0
check() {  # name, sql, expected
  local got
  got="$(psql_ -c "$2")"
  if [[ "$got" == "$3" ]]; then echo "ok - $1"; else echo "not ok - $1 (got '$got', want '$3')"; fail=1; fi
}

# 1. The same user joins the same app challenge from N sessions at once.
for _ in $(seq "$N"); do as_a "select public.join_challenge('$APP_CH');" & done
wait
check "parallel joins leave one participation" \
  "select count(*) from public.challenge_participants where challenge_id = '$APP_CH' and user_id = '$A'" "1"
check "parallel joins announce once" \
  "select count(*) from public.activity_events where actor_id = '$A' and kind = 'challenge_joined' and dedupe_key = 'challenge:$APP_CH'" "1"

# 2. The fifth day arrives from N parallel inserts (meal logs for yesterday and today).
for i in $(seq "$N"); do
  d=$(( i % 2 ))
  printf "insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g) values ('%s', current_date - %s, 'dinner', 'conc', 300, 30, 5, 10);\n" "$A" "$d" | psql_ >/dev/null 2>"$(mktemp -p "$ERRLOG")" &
done
wait
check "log challenge completes exactly once" \
  "select status || ':' || (completed_at is not null) from public.challenge_participants where challenge_id = '$LOG_CH'" "completed:true"
check "one completion event for the log challenge" \
  "select count(*) from public.activity_events where actor_id = '$A' and kind = 'challenge_completed' and dedupe_key = 'challenge:$LOG_CH'" "1"

# 3. N parallel check-ins for today: counted once, completes once.
for _ in $(seq "$N"); do as_a "select public.check_in_challenge('$CHK_CH');" & done
wait
check "parallel check-ins count today once" \
  "select count(*) from public.challenge_checkins where challenge_id = '$CHK_CH' and day = current_date" "1"
check "check-in challenge progress is 5 and completed" \
  "select progress_days || ':' || status from public.challenge_participants where challenge_id = '$CHK_CH'" "5:completed"
check "one completion event for the check-in challenge" \
  "select count(*) from public.activity_events where actor_id = '$A' and kind = 'challenge_completed' and dedupe_key = 'challenge:$CHK_CH'" "1"
check "first-challenge achievement once" \
  "select count(*) from public.activity_events where actor_id = '$A' and kind = 'achievement' and dedupe_key = 'first_challenge'" "1"

# 4. Leave races with a refresh: the participation ends either left or completed, never both or duplicated.
check "no duplicate participations anywhere" \
  "select count(*) from (select challenge_id, user_id from public.challenge_participants where user_id = '$A' group by 1, 2 having count(*) > 1) x" "0"

if [[ -n "$(cat "$ERRLOG"/* 2>/dev/null)" ]]; then
  echo "not ok - a parallel session failed:"; cat "$ERRLOG"/* | sed 's/^/    /' | head -20; fail=1
else
  echo "ok - no parallel session raised an error"
fi
rm -rf "$ERRLOG"
exit $fail
