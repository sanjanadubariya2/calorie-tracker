-- Database-level tests for supabase/migrations/004_server_streaks.sql.
--
--   supabase start
--   supabase test db
--
-- Statements under test run as `authenticated` with a JWT `sub` claim, so the
-- trigger, RLS, grants and function privileges behave as they do through
-- PostgREST. True multi-session concurrency can't be expressed in a single
-- pgTAP transaction; it is covered by a multi-row statement here and by the
-- parallel-session script in the Task 2 report.

begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(48);

-- Production-equivalent grants on the 001 tables that 004 does not manage
-- (see 003_social_security.test.sql for why). user_streaks is deliberately
-- NOT granted here: its privileges are set by 004 and are under test.
grant select, insert, update, delete on public.profiles, public.food_logs to anon, authenticated;

-- ------------------------------------------------------------------
-- Fixtures
--   A: Asia/Kolkata (UTC+5:30) — main streak scenarios
--   B: UTC — lapsed streak, friend view, account deletion
--   C: no time zone stored — fallback bounds
-- ------------------------------------------------------------------
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'streak_a@test.local'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'streak_b@test.local'),
  ('cccccccc-0000-0000-0000-00000000000c', 'streak_c@test.local');

insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, username, timezone) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 30, 170, 70, 'female', 'lose', 'streak_a', 'Asia/Kolkata'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 30, 170, 70, 'male', 'lose', 'streak_b', 'UTC'),
  ('cccccccc-0000-0000-0000-00000000000c', 30, 170, 70, 'male', 'lose', 'streak_c', null);

-- Each user's "today" as the server defines it.
select set_config('t.a', ((now() at time zone 'Asia/Kolkata')::date)::text, true);
select set_config('t.b', ((now() at time zone 'utc')::date)::text, true);
select set_config('t.c_min', (((now() at time zone 'utc') - interval '12 hours')::date)::text, true);

select set_config('t.claims_a', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select set_config('t.claims_b', '{"sub":"bbbbbbbb-0000-0000-0000-00000000000b","role":"authenticated"}', true);
select set_config('t.claims_c', '{"sub":"cccccccc-0000-0000-0000-00000000000c","role":"authenticated"}', true);

create schema test_helpers;  -- rolled back with the transaction
grant usage on schema test_helpers to authenticated;

-- Inserts a food log for the current JWT user as if it had been entered ON
-- p_day (noon in the user's zone): since 027 only on-time entries build a
-- streak. SECURITY DEFINER so the test can set created_at (clients can't).
create function test_helpers.log_food(p_day date, p_name text default 'Food')
returns void language sql security definer set search_path = '' as $$
  insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, created_at)
  select auth.uid(), p_day, 'lunch', p_name, 100,
         (p_day + time '12:00') at time zone coalesce(
           (select p.timezone from public.profiles p where p.user_id = auth.uid()), 'utc');
$$;
-- A late entry: made now, for an earlier day (as the app would do it).
create function test_helpers.log_late(p_day date, p_name text default 'Late')
returns void language sql as $$
  insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories)
  values (auth.uid(), p_day, 'lunch', p_name, 100);
$$;
grant execute on function test_helpers.log_late(date, text) to authenticated;
grant execute on function test_helpers.log_food(date, text) to authenticated;

-- Raw stored row, read as postgres.
create function test_helpers.stored(p_user uuid)
returns table (current_streak int, last_logged_date date, longest_streak int, badges_earned int)
language sql as $$
  select s.current_streak, s.last_logged_date, s.longest_streak, s.badges_earned
  from public.user_streaks s where s.user_id = p_user;
$$;

-- ==================================================================
-- 1. First food log creates a streak of 1
-- ==================================================================
set local role authenticated;
select set_config('request.jwt.claims', current_setting('t.claims_a'), true);

select is_empty($$ select * from public.get_my_streak() $$,
  '1. No streak row before the first log');

select test_helpers.log_food(current_setting('t.a')::date, 'Oats');

select results_eq(
  $$ select current_streak, last_logged_date, longest_streak from public.get_my_streak() $$,
  $$ values (1, current_setting('t.a')::date, 1) $$,
  '1. First log today -> streak 1');

-- ==================================================================
-- 2. Multiple logs on the same day count once
-- ==================================================================
select test_helpers.log_food(current_setting('t.a')::date, 'Dal');
select test_helpers.log_food(current_setting('t.a')::date, 'Chai');

select is((select current_streak from public.get_my_streak()), 1,
  '2. Three logs today still -> streak 1');

reset role;
select is((select count(*)::int from public.user_streaks
           where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a'), 1,
  '2. Exactly one user_streaks row');

-- ==================================================================
-- 3. Consecutive days increment the streak
-- ==================================================================
set local role authenticated;
select test_helpers.log_food(current_setting('t.a')::date - 1);
select is((select current_streak from public.get_my_streak()), 2,
  '3. Yesterday + today -> 2');
select test_helpers.log_food(current_setting('t.a')::date - 2);
select is((select current_streak from public.get_my_streak()), 3,
  '3. Three consecutive days -> 3');
select is((select badges_earned from public.get_my_streak()), 1,
  '10. Reaching 3 days awards the first milestone badge');

-- ==================================================================
-- 5. A backdated log on an isolated day does not inflate the current streak
-- ==================================================================
select test_helpers.log_food(current_setting('t.a')::date - 10, 'Backdated');
select results_eq(
  $$ select current_streak, longest_streak, last_logged_date from public.get_my_streak() $$,
  $$ values (3, 3, current_setting('t.a')::date) $$,
  '5. Isolated backdated log leaves current streak at 3 and last date at today');

-- Future-dated logs: since 006 they are rejected outright when beyond the
-- latest "today" on Earth. (A date between the user's today and UTC+14's
-- today is still accepted but ignored by the streak cap; whether "+1" falls
-- in that gap depends on the time of day, so the deterministic case is used.)
select throws_ok(
  $$ select test_helpers.log_food(current_setting('t.a')::date + 3, 'Future') $$,
  '23514', null,
  '5. A log dated 3 days ahead is rejected (006) and cannot affect the streak');

-- ==================================================================
-- 6. Backdated logs can repair a historical sequence
-- ==================================================================
select test_helpers.log_food(current_setting('t.a')::date - 4);
select is((select current_streak from public.get_my_streak()), 3,
  '6. D-4 alone (gap at D-3) does not join the current run');
select test_helpers.log_food(current_setting('t.a')::date - 3);
select results_eq(
  $$ select current_streak, longest_streak from public.get_my_streak() $$,
  $$ values (5, 5) $$,
  '6. Filling the D-3 gap joins the runs: D-4..D -> 5');

-- ==================================================================
-- 6b. Late entries (027): kept in history, never counted
-- ==================================================================
select test_helpers.log_late(current_setting('t.a')::date - 30, 'Late');
select test_helpers.log_late(current_setting('t.a')::date - 31, 'Late');
select test_helpers.log_late(current_setting('t.a')::date - 32, 'Late');
select results_eq(
  $$ select current_streak, longest_streak from public.get_my_streak() $$,
  $$ values (5, 5) $$,
  '6b. Three days entered weeks later build no streak and no badge');
select is((select count(*)::int from public.food_logs where food_name = 'Late'), 3,
  '6b. ...but they stay in the food history');

-- ==================================================================
-- 7. Deleting one of several logs on a date keeps the day active
-- ==================================================================
delete from public.food_logs where food_name = 'Chai';
select is((select current_streak from public.get_my_streak()), 5,
  '7. Removing one of three logs today keeps streak at 5');

-- ==================================================================
-- 8. Deleting the last log on a date recalculates
-- ==================================================================
delete from public.food_logs where logged_date = current_setting('t.a')::date - 2;
select results_eq(
  $$ select current_streak, longest_streak from public.get_my_streak() $$,
  $$ values (2, 2) $$,
  '8. Emptying D-2 splits the run: current D-1..D = 2, longest 2');
select is((select badges_earned from public.get_my_streak()), 1,
  '10. Badge already earned is kept after the run shrinks');

-- Deleting today's last logs moves the streak to the run ending yesterday.
delete from public.food_logs where logged_date = current_setting('t.a')::date;
select results_eq(
  $$ select current_streak, last_logged_date from public.get_my_streak() $$,
  $$ values (1, current_setting('t.a')::date - 1) $$,
  '8. Emptying today -> run ending yesterday (still live) = 1');

-- ==================================================================
-- 10. Milestone badges are awarded once only
-- ==================================================================
select test_helpers.log_food(current_setting('t.a')::date);
select test_helpers.log_food(current_setting('t.a')::date - 2);
select is((select badges_earned from public.get_my_streak()), 1,
  '10. Re-reaching 3+ days does not award the 3-day badge again');

select test_helpers.log_food(current_setting('t.a')::date - 5);
select test_helpers.log_food(current_setting('t.a')::date - 6);
select results_eq(
  $$ select current_streak, badges_earned from public.get_my_streak() $$,
  $$ values (7, 2) $$,
  '10. Reaching 7 days awards the second badge (total 2)');

select test_helpers.log_food(current_setting('t.a')::date, 'Extra');
select test_helpers.log_food(current_setting('t.a')::date - 6, 'Extra');
select is((select badges_earned from public.get_my_streak()), 2,
  '10. More logs inside the same run award nothing new');

delete from public.food_logs where logged_date = current_setting('t.a')::date - 6;
select test_helpers.log_food(current_setting('t.a')::date - 6);
select is((select badges_earned from public.get_my_streak()), 2,
  '10. Deleting and re-adding a day cannot farm the 7-day badge');

-- ------------------------------------------------------------------
-- UPDATE path: moving a log to another date recalculates (old and new date)
-- ------------------------------------------------------------------
update public.food_logs set logged_date = current_setting('t.a')::date - 7
where food_name = 'Backdated';
select results_eq(
  $$ select current_streak, longest_streak from public.get_my_streak() $$,
  $$ values (7, 7) $$,
  'UPDATE: moving the D-10 log to D-7 makes it a late entry, so the run stays 7 (027)');

update public.food_logs set food_name = 'Renamed'
where food_name = 'Extra' and logged_date = current_setting('t.a')::date;
select is((select current_streak from public.get_my_streak()), 7,
  'UPDATE: an edit that keeps the date leaves the streak unchanged');

-- ==================================================================
-- 11. Clients cannot write user_streaks directly
-- ==================================================================
select throws_ok(
  $$ update public.user_streaks set current_streak = 999, badges_earned = 99
     where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  '42501', null,
  '11. Direct UPDATE of own streak is refused');
select throws_ok(
  $$ insert into public.user_streaks (user_id, current_streak, badges_earned)
     values ('aaaaaaaa-0000-0000-0000-00000000000a', 999, 99) $$,
  '42501', null,
  '11. Direct INSERT (upsert path) is refused');
select throws_ok(
  $$ delete from public.user_streaks where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  '42501', null,
  '11. Direct DELETE is refused');
select throws_ok(
  $$ select public.recalculate_user_streak('aaaaaaaa-0000-0000-0000-00000000000a') $$,
  '42501', null,
  '11. Clients cannot call the internal recalculation');
select throws_ok(
  $$ select public.recalculate_user_streak('bbbbbbbb-0000-0000-0000-00000000000b', true) $$,
  '42501', null,
  '11. ...including for another user');
select throws_ok(
  $$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories)
     values ('bbbbbbbb-0000-0000-0000-00000000000b', current_date, 'lunch', 'x', 1) $$,
  '42501', null,
  '11. Cannot log food (and so trigger a recalculation) for another user');
select is((select count(*)::int from public.user_streaks), 1,
  '11. A reads only its own streak row (owner-only SELECT)');

reset role;
select results_eq(
  $$ select current_streak, longest_streak, badges_earned
     from test_helpers.stored('aaaaaaaa-0000-0000-0000-00000000000a') $$,
  $$ values (7, 7, 2) $$,
  '11. Stored values are untouched by the refused writes');

-- ==================================================================
-- 4. Missing a day breaks the current streak (B, UTC)
-- ==================================================================
set local role authenticated;
select set_config('request.jwt.claims', current_setting('t.claims_b'), true);
select test_helpers.log_food(current_setting('t.b')::date - 3);
select test_helpers.log_food(current_setting('t.b')::date - 2);

select results_eq(
  $$ select current_streak, longest_streak, last_logged_date from public.get_my_streak() $$,
  $$ values (0, 2, current_setting('t.b')::date - 2) $$,
  '4. Last active day older than yesterday -> current streak 0 (history kept)');

reset role;
select is((select current_streak from test_helpers.stored('bbbbbbbb-0000-0000-0000-00000000000b')), 2,
  '4. Stored run is kept; the lapse is applied when read');

-- A friend sees the lapsed streak as 0 too (decay in B's zone).
insert into public.friendships (requester_id, addressee_id, status)
values ('cccccccc-0000-0000-0000-00000000000c', 'bbbbbbbb-0000-0000-0000-00000000000b', 'accepted');
-- Streaks reach friends only when shared (025).
insert into public.social_settings (user_id, share_activity) values ('bbbbbbbb-0000-0000-0000-00000000000b', true);
set local role authenticated;
select set_config('request.jwt.claims', current_setting('t.claims_c'), true);
select is(
  (select current_streak from public.get_friend_list()),
  0,
  '4. Friend summary shows the lapsed streak as 0');

-- ==================================================================
-- Time zone fallback (C has no time zone stored)
-- ==================================================================
select test_helpers.log_food(current_setting('t.c_min')::date - 1);
select is((select current_streak from public.get_my_streak()), 1,
  'No zone: a log on the earliest possible "yesterday" still counts as live');

reset role;
delete from public.food_logs where user_id = 'cccccccc-0000-0000-0000-00000000000c';
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories)
values ('cccccccc-0000-0000-0000-00000000000c', current_setting('t.c_min')::date - 2, 'lunch', 'old', 1);
set local role authenticated;
select is((select current_streak from public.get_my_streak()), 0,
  'No zone: a log older than every zone''s yesterday has lapsed');

select set_config('request.jwt.claims', current_setting('t.claims_a'), true);
select throws_ok(
  $$ update public.profiles set timezone = 'Mars/Olympus_Mons'
     where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  '23514', null,
  'An invalid IANA time zone is rejected');
select lives_ok(
  $$ update public.profiles set timezone = 'America/New_York'
     where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a' $$,
  'A valid time zone can be saved by the owner');
update public.profiles set timezone = 'Asia/Kolkata'
where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a';

-- ==================================================================
-- 12. Multi-row statements produce one consistent row
-- ==================================================================
reset role;
insert into auth.users (id, email) values ('dddddddd-0000-0000-0000-00000000000d', 'streak_d@test.local');
insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, username, timezone)
values ('dddddddd-0000-0000-0000-00000000000d', 30, 170, 70, 'female', 'lose', 'streak_d', 'UTC');

-- One statement, each row entered on its own day (on time, 027).
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, created_at)
select 'dddddddd-0000-0000-0000-00000000000d', current_setting('t.b')::date - (g % 4), 'lunch', 'bulk ' || g, 50,
       (current_setting('t.b')::date - (g % 4) + time '12:00') at time zone 'utc'
from generate_series(1, 20) g;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"dddddddd-0000-0000-0000-00000000000d","role":"authenticated"}', true);

reset role;
select is((select count(*)::int from public.user_streaks
           where user_id = 'dddddddd-0000-0000-0000-00000000000d'), 1,
  '12. 20-row insert across 4 dates -> exactly one streak row');
select results_eq(
  $$ select current_streak, longest_streak from test_helpers.stored('dddddddd-0000-0000-0000-00000000000d') $$,
  $$ values (4, 4) $$,
  '12. ...with the correct streak of 4');

set local role authenticated;
delete from public.food_logs where food_name in ('bulk 4', 'bulk 8', 'bulk 12', 'bulk 16', 'bulk 20');
select is((select current_streak from public.get_my_streak()), 3,
  '12. Multi-row delete emptying one date recalculates once, correctly (3)');

-- ==================================================================
-- 9. Deleting all food logs leaves no active streak
-- ==================================================================
select set_config('request.jwt.claims', current_setting('t.claims_a'), true);
delete from public.food_logs where user_id = auth.uid();

select results_eq(
  $$ select current_streak, last_logged_date, longest_streak from public.get_my_streak() $$,
  $$ values (0, null::date, 0) $$,
  '9. No logs -> streak 0, no last date, longest 0');
select is((select badges_earned from public.get_my_streak()), 2,
  '9. Earned badges are kept (high-water mark)');

reset role;
select is((select count(*)::int from public.user_streaks
           where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a'), 1,
  '9. The streak row still exists and is consistent');

-- ==================================================================
-- Hardening checks
-- ==================================================================
select lives_ok(
  $$ delete from auth.users where id = 'bbbbbbbb-0000-0000-0000-00000000000b' $$,
  'Account deletion cascades through food_logs without the trigger failing');
select is((select count(*)::int from public.user_streaks
           where user_id = 'bbbbbbbb-0000-0000-0000-00000000000b'), 0,
  'Deleted account leaves no streak row behind');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('recalculate_user_streak', 'food_logs_recalculate_streaks', 'user_today_bounds',
                       'get_my_streak', 'get_friend_list')
     and p.prosecdef
     and p.proconfig @> array['search_path=""']),
  5,
  'All streak SECURITY DEFINER functions pin search_path to empty');

set local role anon;
select throws_ok($$ select * from public.get_my_streak() $$, '42501', null,
  'anon cannot call get_my_streak');

select * from finish();
rollback;
