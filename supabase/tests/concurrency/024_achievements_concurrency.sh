#!/usr/bin/env bash
# Concurrency checks for migrations 023 and 024 (local dev database only).
# Commits a fixture (ids prefixed f0240000-), races parallel sessions, checks
# invariants, then deletes the fixture. Never run against a shared database.
#
#   bash supabase/tests/concurrency/024_achievements_concurrency.sh
set -euo pipefail

CONTAINER="${DB_CONTAINER:-supabase_db_calorie-tracker}"
N="${N:-12}"
A="f0240000-0000-0000-0000-0000000000a1"
B="f0240000-0000-0000-0000-0000000000b1"
ERRLOG="$(mktemp -d)"   # one file per session: concurrent appends to one file can be lost
RATELOG="$(mktemp -d)"

psql_() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }
as_user() {  # user, sql, error log
  printf "set role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', false); %s\n" "$1" "$2" \
    | psql_ >/dev/null 2>"$(mktemp -p "$3")"
}
cleanup() { psql_ -c "delete from auth.users where id in ('$A', '$B');" >/dev/null; }
trap 'cleanup; rm -rf "$ERRLOG" "$RATELOG"' EXIT
cleanup

psql_ <<SQL >/dev/null
insert into auth.users (id, email) values ('$A', 'conc24-a@test.local'), ('$B', 'conc24-b@test.local');
insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, username, timezone) values
  ('$A', 30, 170, 70, 'female', 'maintain', 'conc24_a', 'UTC'), ('$B', 30, 170, 70, 'female', 'maintain', 'conc24_b', 'UTC');
insert into public.friendships (requester_id, addressee_id, status) values ('$A', '$B', 'accepted');
insert into public.social_settings (user_id, share_activity) values ('$A', true);
-- Three honest days already (2-4 days ago); two more will arrive in parallel.
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g, created_at)
select '$A', current_date - d, 'lunch', 'conc', 300, 30, 5, 10, (current_date - d)::timestamp at time zone 'utc' + interval '12 hours'
from generate_series(2, 4) d;
select public.record_activity('$A', 'streak_milestone', 'streak:3', '{"days": 3}');
SQL
EV="$(psql_ -c "select id from public.activity_events where actor_id = '$A' and dedupe_key = 'streak:3'")"

fail=0
check() {
  local got; got="$(psql_ -c "$2")"
  if [[ "$got" == "$3" ]]; then echo "ok - $1"; else echo "not ok - $1 (got '$got', want '$3')"; fail=1; fi
}

# 1. The 4th and 5th days arrive from N parallel sessions: first_week unlocks once.
for i in $(seq "$N"); do
  as_user "$A" "insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g) values ('$A', current_date - $(( i % 2 )), 'dinner', 'conc', 300, 30, 5, 10);" "$ERRLOG" &
done
wait
check "first_week unlocked exactly once" \
  "select count(*) from public.user_achievements where user_id = '$A' and code = 'first_week'" "1"
check "one feed announcement for first_week" \
  "select count(*) from public.activity_events where actor_id = '$A' and kind = 'achievement' and dedupe_key = 'first_week'" "1"

# 2. A friend double-taps (N times) a reaction.
for i in $(seq "$N"); do
  r=$([[ $(( i % 2 )) -eq 0 ]] && echo like || echo fire)
  as_user "$B" "select public.set_reaction('$EV', '$r');" "$ERRLOG" &
done
wait
check "one reaction row per person" "select count(*) from public.activity_reactions where event_id = '$EV'" "1"
check "one notification for it" \
  "select count(*) from public.notifications where event_id = '$EV' and kind = 'reaction'" "1"
check "first_encouragement once" \
  "select count(*) from public.user_achievements where user_id = '$B' and code = 'first_encouragement'" "1"

# 3. N parallel comments: the 5-a-minute limit holds under concurrency.
for i in $(seq "$N"); do as_user "$B" "select public.add_comment('$EV', 'Go go go $i');" "$RATELOG" & done
wait
check "rate limit admits exactly 5 comments" "select count(*) from public.activity_comments where event_id = '$EV'" "5"
rejected="$(cat "$RATELOG"/* | grep -c 'Too many requests' || true)"
if [[ "$rejected" == "$(( N - 5 ))" ]]; then echo "ok - the other $rejected were rate-limited"; else
  echo "not ok - expected $(( N - 5 )) rate-limit errors, got $rejected"; cat "$RATELOG"/* | sed 's/^/    /' | head; fail=1; fi

if [[ -n "$(cat "$ERRLOG"/* 2>/dev/null)" ]]; then
  echo "not ok - a parallel session failed:"; cat "$ERRLOG"/* | sed 's/^/    /' | head -20; fail=1
else
  echo "ok - no unexpected errors"
fi
exit $fail
