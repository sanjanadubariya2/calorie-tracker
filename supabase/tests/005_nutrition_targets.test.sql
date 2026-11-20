-- Database tests for supabase/migrations/005_nutrition_targets.sql:
-- server-computed targets, macro split validation, target history,
-- get_daily_status / get_daily_totals, local-date semantics.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- Production-equivalent grants on the 001 tables (see 003 test for why).
grant select, insert, update, delete on public.profiles, public.food_logs to anon, authenticated;

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-00000000000a', 'targets_a@test.local'),
  ('b0000000-0000-0000-0000-00000000000b', 'targets_b@test.local'),
  ('c0000000-0000-0000-0000-00000000000c', 'targets_c@test.local');

select set_config('t.claims_a', '{"sub":"a0000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select set_config('t.claims_b', '{"sub":"b0000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
select set_config('t.claims_c', '{"sub":"c0000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);

-- ==================================================================
-- 1. Mifflin-St Jeor, activity levels, goals, floor (pure function)
-- ==================================================================
-- Male 80 kg, 180 cm, 30 y: BMR = 800 + 1125 - 150 + 5 = 1780.
select is(public.compute_daily_target(80, 180, 30, 'male', 'maintain', 'sedentary'), 2136, 'TDEE sedentary: 1780 * 1.2');
select is(public.compute_daily_target(80, 180, 30, 'male', 'maintain', 'light'), 2448, 'TDEE light: 1780 * 1.375 = 2447.5 -> 2448 (half away from zero)');
select is(public.compute_daily_target(80, 180, 30, 'male', 'maintain', 'moderate'), 2759, 'TDEE moderate: 1780 * 1.55');
select is(public.compute_daily_target(80, 180, 30, 'male', 'maintain', 'active'), 3071, 'TDEE active: 1780 * 1.725 = 3070.5 -> 3071');
select is(public.compute_daily_target(80, 180, 30, 'male', 'maintain', 'very_active'), 3382, 'TDEE very active: 1780 * 1.9');
select is(public.compute_daily_target(80, 180, 30, 'male', 'lose', 'light'), 1948, 'Goal lose: -500');
select is(public.compute_daily_target(80, 180, 30, 'male', 'gain', 'light'), 2748, 'Goal gain: +300');
-- Female 58 kg, 165 cm, 22 y: BMR = 1340.25.
select is(public.compute_daily_target(58, 165, 22, 'female', 'lose', 'light'), 1343, 'Female BMR uses -161');
select is(public.compute_daily_target(45, 150, 60, 'female', 'lose', 'sedentary'), 1200, 'Floor: a computed 612 kcal is raised to 1200');

select results_eq($$ select * from public.macro_targets(2000, 55, 25, 20) $$, $$ values (275, 56, 100) $$,
  'Macro grams 55/25/20 of 2000 kcal');
select results_eq($$ select * from public.macro_targets(2000, 40, 30, 30) $$, $$ values (200, 67, 150) $$,
  'Macro grams 40/30/30 of 2000 kcal');

-- ==================================================================
-- 2. The trigger owns daily_target_kcal
-- ==================================================================
set local role authenticated;
select set_config('request.jwt.claims', current_setting('t.claims_a'), true);

insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, daily_target_kcal, username, timezone)
values ('a0000000-0000-0000-0000-00000000000a', 30, 180, 80, 'male', 'maintain', 9999, 'targets_a', 'Asia/Kolkata');

select results_eq(
  $$ select daily_target_kcal, activity_level, macro_carb_pct, macro_fat_pct, macro_protein_pct
     from public.profiles where user_id = auth.uid() $$,
  $$ values (2448, 'light'::text, 55::smallint, 25::smallint, 20::smallint) $$,
  'Client-sent 9999 ignored; defaults light + 55/25/20 applied');

update public.profiles set daily_target_kcal = 1 where user_id = auth.uid();
select is((select daily_target_kcal from public.profiles where user_id = auth.uid()), 2448,
  'A direct update of daily_target_kcal is recomputed back');

update public.profiles set activity_level = 'active' where user_id = auth.uid();
select is((select daily_target_kcal from public.profiles where user_id = auth.uid()), 3071,
  'Changing activity level recomputes the target');

-- ==================================================================
-- 3. Invalid preferences cannot be saved
-- ==================================================================
select throws_ok($$ update public.profiles set macro_carb_pct = 60 where user_id = auth.uid() $$,
  '23514', null, 'Macro split must sum to 100 (60/25/20 = 105)');
select throws_ok($$ update public.profiles set macro_carb_pct = 75, macro_fat_pct = 5, macro_protein_pct = 20
                    where user_id = auth.uid() $$,
  '23514', null, 'Each macro must be within 10–70 (75/5/20 sums to 100 but is out of range)');
select throws_ok($$ update public.profiles set macro_carb_pct = -10, macro_fat_pct = 60, macro_protein_pct = 50
                    where user_id = auth.uid() $$,
  '23514', null, 'Negative macro percentage rejected');
select lives_ok($$ update public.profiles set macro_carb_pct = 40, macro_fat_pct = 30, macro_protein_pct = 30
                   where user_id = auth.uid() $$,
  'A valid 40/30/30 split saves');
select throws_ok($$ update public.profiles set activity_level = 'couch' where user_id = auth.uid() $$,
  '23514', null, 'Unknown activity level rejected');
select throws_ok($$ update public.profiles set weight_kg = -5 where user_id = auth.uid() $$,
  '23514', null, 'Negative weight rejected');
select throws_ok($$ update public.profiles set age = 0 where user_id = auth.uid() $$,
  '23514', null, 'Age 0 rejected');

-- ==================================================================
-- 4. Target history
-- ==================================================================
select is((select count(*)::int from public.nutrition_target_history), 1,
  'All changes on one local day collapse into one history row');
select results_eq(
  $$ select daily_target_kcal, activity_level, macro_carb_pct from public.nutrition_target_history $$,
  $$ values (3071, 'active'::text, 40::smallint) $$,
  'The history row holds the latest target of the day');

update public.profiles set username = 'targets_a2' where user_id = auth.uid();
select is((select count(*)::int from public.nutrition_target_history), 1,
  'A username change does not touch target history');

-- A user with no history (e.g. a profile whose stored target already matched
-- the formula during the 005 backfill) gets a first row on any save, and a
-- stale stored target is corrected first.
reset role;
delete from public.nutrition_target_history where user_id = 'a0000000-0000-0000-0000-00000000000a';
alter table public.profiles disable trigger profiles_compute_target;
update public.profiles set daily_target_kcal = 2300 where user_id = 'a0000000-0000-0000-0000-00000000000a';
alter table public.profiles enable trigger profiles_compute_target;
set local role authenticated;
update public.profiles set username = 'targets_a3' where user_id = auth.uid();
select results_eq(
  $$ select p.daily_target_kcal, (select count(*)::int from public.nutrition_target_history h where h.user_id = p.user_id),
            (select h.daily_target_kcal from public.nutrition_target_history h where h.user_id = p.user_id)
     from public.profiles p where p.user_id = auth.uid() $$,
  $$ values (3071, 1, 3071) $$,
  'A history-less user gets a first row on any save, with the stale target recomputed first');

select throws_ok($$ insert into public.nutrition_target_history
                     (user_id, effective_from, daily_target_kcal, macro_carb_pct, macro_fat_pct, macro_protein_pct, activity_level, goal)
                   values (auth.uid(), current_date, 100, 55, 25, 20, 'light', 'lose') $$,
  '42501', null, 'Clients cannot write target history');

-- Older targets (inserted as the owner, as if recorded on earlier days).
reset role;
insert into public.nutrition_target_history
  (user_id, effective_from, daily_target_kcal, macro_carb_pct, macro_fat_pct, macro_protein_pct, activity_level, goal)
values
  ('a0000000-0000-0000-0000-00000000000a', date '2026-01-01', 2000, 55, 25, 20, 'light', 'maintain'),
  ('a0000000-0000-0000-0000-00000000000a', date '2026-03-01', 1800, 50, 30, 20, 'light', 'lose');

set local role authenticated;
select results_eq(
  $$ select target_kcal, target_carbs_g, target_fat_g, target_protein_g from public.get_daily_status(date '2026-02-15') $$,
  $$ values (2000, 275, 56, 100) $$,
  'A past day uses the target in force then (2026-01-01 row)');
select results_eq(
  $$ select target_kcal, macro_carb_pct from public.get_daily_status(date '2026-03-01') $$,
  $$ values (1800, 50::smallint) $$,
  'A target applies from its effective date');
select is((select target_kcal from public.get_daily_status(date '2025-06-01')), 2000,
  'A day before any history uses the earliest target');

-- ==================================================================
-- 5. get_daily_status: no logs, several logs, isolation
-- ==================================================================
select set_config('t.day', '2026-04-10', true);
select results_eq(
  format($$ select consumed_kcal, consumed_carbs_g, consumed_fat_g, consumed_protein_g, entry_count,
                   remaining_kcal = target_kcal
            from public.get_daily_status(%L) $$, current_setting('t.day')),
  $$ values (0::numeric, 0::numeric, 0::numeric, 0::numeric, 0, true) $$,
  'No logs: zero consumption, remaining = target');

insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g)
values
  (auth.uid(), current_setting('t.day')::date, 'breakfast', 'Oats', 300, 50, 6, 10),
  (auth.uid(), current_setting('t.day')::date, 'lunch', 'Dal rice', 650.5, 90.2, 15, 22.3),
  (auth.uid(), current_setting('t.day')::date - 1, 'dinner', 'Other day', 999, 1, 1, 1);

select results_eq(
  format($$ select consumed_kcal, consumed_carbs_g, consumed_fat_g, consumed_protein_g, entry_count
            from public.get_daily_status(%L) $$, current_setting('t.day')),
  $$ values (950.5::numeric, 140.2::numeric, 21::numeric, 32.3::numeric, 2) $$,
  'Several logs: sums only that date');

-- Target in force on 2026-04-10 is the 2026-03-01 row (1800, 50/30/20 -> 225/60/90 g).
select results_eq(
  format($$ select remaining_kcal, remaining_carbs_g, remaining_fat_g, remaining_protein_g
            from public.get_daily_status(%L) $$, current_setting('t.day')),
  $$ values (849.5::numeric, 84.8::numeric, 39::numeric, 57.7::numeric) $$,
  'Remaining = target - consumed for kcal and each macro');

select set_config('request.jwt.claims', current_setting('t.claims_b'), true);
select results_eq(
  format($$ select consumed_kcal, entry_count, target_kcal from public.get_daily_status(%L) $$, current_setting('t.day')),
  $$ values (0::numeric, 0, null::int) $$,
  'Another user sees none of A''s logs; no profile -> null targets, zero consumption');

select throws_ok($$ select * from public.get_daily_status() $$, '22023', null,
  'No time zone stored: the date must be passed explicitly');

-- ==================================================================
-- 6. Local-date boundaries
-- ==================================================================
-- C lives in UTC+14 (Kiritimati); its "today" is always ahead of UTC-12's.
reset role;
insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, username, timezone)
values ('c0000000-0000-0000-0000-00000000000c', 30, 170, 70, 'female', 'maintain', 'targets_c', 'Pacific/Kiritimati');
select set_config('t.c_today', ((now() at time zone 'Pacific/Kiritimati')::date)::text, true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('t.claims_c'), true);
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories)
values (auth.uid(), current_setting('t.c_today')::date, 'lunch', 'Local today', 400),
       (auth.uid(), current_setting('t.c_today')::date - 1, 'lunch', 'Local yesterday', 700);

select results_eq(
  $$ select status_date, consumed_kcal from public.get_daily_status() $$,
  format($$ values (%L::date, 400::numeric) $$, current_setting('t.c_today')),
  'Default date = today in the user''s zone (UTC+14), not UTC');
select lives_ok(
  format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories)
            values (auth.uid(), %L, 'dinner', 'Edge', 1) $$, current_setting('t.c_today')),
  'A UTC+14 user can log on their local today even when UTC is still a day behind');

-- A friend's "today" is the friend's own local date.
reset role;
insert into public.friendships (requester_id, addressee_id, status)
values ('a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000c', 'accepted');
set local role authenticated;
select set_config('request.jwt.claims', current_setting('t.claims_a'), true);
select is(
  (select today_kcal from public.get_friend_summaries((((now() at time zone 'utc') - interval '12 hours')::date))),
  401::numeric,
  'Friend summary totals the friend''s local today even when the viewer''s date is behind');

-- ==================================================================
-- 7. get_daily_totals
-- ==================================================================
select set_config('request.jwt.claims', current_setting('t.claims_a'), true);
select results_eq(
  format($$ select logged_date, meal_type, calories, entry_count
            from public.get_daily_totals(%L::date - 1, %L::date) $$,
         current_setting('t.day'), current_setting('t.day')),
  format($$ values (%L::date - 1, 'dinner'::text, 999::numeric, 1),
                   (%L::date, 'breakfast'::text, 300::numeric, 1),
                   (%L::date, 'lunch'::text, 650.5::numeric, 1) $$,
         current_setting('t.day'), current_setting('t.day'), current_setting('t.day')),
  'Per-day, per-meal sums for the range');
select throws_ok($$ select * from public.get_daily_totals(date '2020-01-01', date '2026-01-01') $$,
  '22023', null, 'Ranges over 400 days are refused');
select throws_ok($$ select * from public.get_daily_totals(date '2026-02-01', date '2026-01-01') $$,
  '22023', null, 'Reversed ranges are refused');

-- ==================================================================
-- 8. Privileges and hardening
-- ==================================================================
set local role anon;
select throws_ok($$ select * from public.get_daily_status(date '2026-01-01') $$, '42501', null,
  'anon cannot call get_daily_status');
reset role;
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('get_daily_status', 'get_daily_totals', 'compute_daily_target', 'macro_targets',
                       'activity_factor', 'profiles_compute_target', 'profiles_record_target_history')
     and p.proconfig @> array['search_path=""']),
  7, 'All new functions pin search_path to empty');
select ok(
  (select not p.prosecdef from pg_proc p where p.proname = 'get_daily_status'),
  'get_daily_status runs as the caller (SECURITY INVOKER), so RLS applies');

select * from finish();
rollback;
