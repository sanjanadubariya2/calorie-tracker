-- Database tests for supabase/migrations/006_food_log_provenance.sql:
-- provenance, immutable per-100 g snapshots, server-computed portions,
-- nutrition validation, future-date rejection.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

grant select, insert, update, delete on public.profiles, public.food_logs to anon, authenticated;

insert into auth.users (id, email) values ('d0000000-0000-0000-0000-00000000000d', 'prov_d@test.local');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-0000-0000-00000000000d","role":"authenticated"}', true);
select set_config('t.today', ((now() at time zone 'utc')::date)::text, true);

-- Banana chips, as Open Food Facts reports it (per 100 g).
select set_config('t.snap',
  '{"kcal": 520, "carbs_g": 58, "fat_g": 30.04, "protein_g": 2.3, "saturated_fat_g": 26, "sodium_g": 0.1}', true);

-- ==================================================================
-- 1. Provenance and the snapshot are stored; totals are computed
-- ==================================================================
insert into public.food_logs
  (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g, serving_g,
   source, source_ref, nutrients_per_100g)
values
  (auth.uid(), current_setting('t.today')::date, 'lunch', 'Banana chips', 1, 1, 1, 1, 37,
   'open_food_facts', '8901234', current_setting('t.snap')::jsonb);

select results_eq(
  $$ select source, source_ref, nutrients_per_100g, food_id, ai_confidence
     from public.food_logs where food_name = 'Banana chips' $$,
  $$ values ('open_food_facts'::text, '8901234'::text, current_setting('t.snap')::jsonb, null::uuid, null::numeric) $$,
  'Provenance and the exact per-100 g snapshot are preserved');

-- 520 * 0.37 = 192.4 -> 192; 58 * 0.37 = 21.46 -> 21.5; 30.04 * 0.37 = 11.1148 -> 11.1; 2.3 * 0.37 = 0.851 -> 0.9
select results_eq(
  $$ select calories, carbs_g, fat_g, protein_g from public.food_logs where food_name = 'Banana chips' $$,
  $$ values (192::numeric, 21.5::numeric, 11.1::numeric, 0.9::numeric) $$,
  'Totals are computed from the snapshot; the client''s 1/1/1/1 is ignored');

-- ==================================================================
-- 2. Portion edits recompute from the snapshot: no rounding drift
-- ==================================================================
update public.food_logs set serving_g = 100 where food_name = 'Banana chips';
select results_eq(
  $$ select calories, carbs_g, fat_g, protein_g from public.food_logs where food_name = 'Banana chips' $$,
  $$ values (520::numeric, 58.0::numeric, 30.0::numeric, 2.3::numeric) $$,
  '37 g -> 100 g gives exactly the per-100 g values (old client-side rescale gave 519 kcal)');

update public.food_logs set serving_g = 37 where food_name = 'Banana chips';
update public.food_logs set serving_g = 100 where food_name = 'Banana chips';
select is((select calories from public.food_logs where food_name = 'Banana chips'), 520::numeric,
  'Repeated edits never drift');

-- ==================================================================
-- 3. The historical snapshot is immutable
-- ==================================================================
update public.food_logs
set nutrients_per_100g = '{"kcal": 999, "carbs_g": 1, "fat_g": 1, "protein_g": 1}',
    source = 'manual', source_ref = 'changed', calories = 5
where food_name = 'Banana chips';

select results_eq(
  $$ select source, source_ref, nutrients_per_100g, calories
     from public.food_logs where food_name = 'Banana chips' $$,
  $$ values ('open_food_facts'::text, '8901234'::text, current_setting('t.snap')::jsonb, 520::numeric) $$,
  'An update cannot rewrite the snapshot, provenance, or the computed totals');

update public.food_logs set food_name = 'Banana chips (salted)', meal_type = 'dinner'
where food_name = 'Banana chips';
select results_eq(
  $$ select meal_type, nutrients_per_100g from public.food_logs where source_ref = '8901234' $$,
  $$ values ('dinner'::text, current_setting('t.snap')::jsonb) $$,
  'Name and meal stay editable; the snapshot is unchanged');

-- A re-log copies the original snapshot, so it is reproducible too.
insert into public.food_logs
  (user_id, logged_date, meal_type, food_name, calories, serving_g, source, source_ref, nutrients_per_100g)
select auth.uid(), logged_date, 'breakfast', food_name, 0, 50, 'relog', source_ref, nutrients_per_100g
from public.food_logs where source_ref = '8901234';
select results_eq(
  $$ select calories, source from public.food_logs where source = 'relog' $$,
  $$ values (260::numeric, 'relog'::text) $$,
  'Re-log of 50 g from the stored snapshot = 260 kcal');

-- ==================================================================
-- 4. Logs without a snapshot keep client totals (quick add, old clients)
-- ==================================================================
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, is_quick_add)
values (auth.uid(), current_setting('t.today')::date, 'evening_snack', 'Restaurant meal', 650, true);
select results_eq(
  $$ select source, calories, carbs_g from public.food_logs where food_name = 'Restaurant meal' $$,
  $$ values ('quick_add'::text, 650::numeric, 0::numeric) $$,
  'Old-client quick add (no source sent) is tagged quick_add and keeps its calories');

insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g, serving_g)
values (auth.uid(), current_setting('t.today')::date, 'lunch', 'Old app search entry', 300, 40, 10, 12, 150);
select results_eq(
  $$ select source, calories, serving_g, nutrients_per_100g from public.food_logs where food_name = 'Old app search entry' $$,
  $$ values ('unknown'::text, 300::numeric, 150::numeric, null::jsonb) $$,
  'Old-client search entry still saves, with source unknown and its own totals');

-- ==================================================================
-- 5. Rounding: half away from zero (matches lib/nutrition.ts)
-- ==================================================================
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g, source, nutrients_per_100g)
values (auth.uid(), current_setting('t.today')::date, 'lunch', 'Rounding', 0, 3, 'manual',
        '{"kcal": 250, "carbs_g": 5, "fat_g": 15, "protein_g": 1.5}');
-- 250*3/100 = 7.5 -> 8; 5*0.03 = 0.15 -> 0.2; 15*0.03 = 0.45 -> 0.5; 1.5*0.03 = 0.045 -> 0.0
select results_eq(
  $$ select calories, carbs_g, fat_g, protein_g from public.food_logs where food_name = 'Rounding' $$,
  $$ values (8::numeric, 0.2::numeric, 0.5::numeric, 0.0::numeric) $$,
  'Exact .5 boundaries round away from zero');

-- ==================================================================
-- 6. Invalid nutrition values are rejected
-- ==================================================================
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g)
                           values (auth.uid(), %L, 'lunch', 'x', 100, -1) $$, current_setting('t.today')),
  '23514', null, 'Negative carbs rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, fat_g)
                           values (auth.uid(), %L, 'lunch', 'x', 100, -0.1) $$, current_setting('t.today')),
  '23514', null, 'Negative fat rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, protein_g)
                           values (auth.uid(), %L, 'lunch', 'x', 100, -5) $$, current_setting('t.today')),
  '23514', null, 'Negative protein rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories)
                           values (auth.uid(), %L, 'lunch', 'x', -1) $$, current_setting('t.today')),
  '23514', null, 'Negative calories rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories)
                           values (auth.uid(), %L, 'lunch', 'x', 25000) $$, current_setting('t.today')),
  '23514', null, 'Implausible calories (25,000 in one entry) rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g)
                           values (auth.uid(), %L, 'lunch', 'x', 100, 0) $$, current_setting('t.today')),
  '23514', null, 'Zero serving rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g)
                           values (auth.uid(), %L, 'lunch', 'x', 100, 6000) $$, current_setting('t.today')),
  '23514', null, 'Serving over 5 kg rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories)
                           values (auth.uid(), %L, 'lunch', '   ', 100) $$, current_setting('t.today')),
  '23514', null, 'Blank food name rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g, nutrients_per_100g)
                           values (auth.uid(), %L, 'lunch', 'x', 0, 10, '{"kcal": 1200, "carbs_g": 1, "fat_g": 1, "protein_g": 1}') $$, current_setting('t.today')),
  '23514', null, 'Snapshot over 1000 kcal/100 g rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g, nutrients_per_100g)
                           values (auth.uid(), %L, 'lunch', 'x', 0, 10, '{"kcal": 100, "carbs_g": -1, "fat_g": 1, "protein_g": 1}') $$, current_setting('t.today')),
  '23514', null, 'Negative per-100 g macro rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g, nutrients_per_100g)
                           values (auth.uid(), %L, 'lunch', 'x', 0, 10, '{"kcal": 100, "carbs_g": 1, "fat_g": 1}') $$, current_setting('t.today')),
  '23514', null, 'Snapshot missing protein_g rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g, nutrients_per_100g)
                           values (auth.uid(), %L, 'lunch', 'x', 0, 10, '{"kcal": "100", "carbs_g": 1, "fat_g": 1, "protein_g": 1}') $$, current_setting('t.today')),
  '23514', null, 'Snapshot with a string value rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, serving_g, nutrients_per_100g)
                           values (auth.uid(), %L, 'lunch', 'x', 0, 10, '{"kcal": 100, "carbs_g": 1, "fat_g": 1, "protein_g": 1, "vitamin_q": 3}') $$, current_setting('t.today')),
  '23514', null, 'Snapshot with an unknown key rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, source)
                           values (auth.uid(), %L, 'lunch', 'x', 1, 'magic') $$, current_setting('t.today')),
  '23514', null, 'Unknown source rejected');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, source, ai_confidence)
                           values (auth.uid(), %L, 'lunch', 'x', 1, 'open_food_facts', 0.9) $$, current_setting('t.today')),
  '23514', null, 'ai_confidence only allowed for ai_assisted entries');
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, source, ai_confidence)
                           values (auth.uid(), %L, 'lunch', 'x', 1, 'ai_assisted', 1.5) $$, current_setting('t.today')),
  '23514', null, 'ai_confidence above 1 rejected');
select lives_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, source, ai_confidence)
                          values (auth.uid(), %L, 'lunch', 'AI guess', 1, 'ai_assisted', 0.85) $$, current_setting('t.today')),
  'An ai_assisted entry with confidence 0.85 is accepted (fields stay optional otherwise)');

-- ==================================================================
-- 7. Dates
-- ==================================================================
select throws_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories)
                           values (auth.uid(), %L::date + 3, 'lunch', 'x', 1) $$, current_setting('t.today')),
  '23514', null, 'A date beyond every time zone''s today is rejected');
select throws_ok($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories)
                    values (auth.uid(), date '1999-12-31', 'lunch', 'x', 1) $$,
  '23514', null, 'A date before 2000 is rejected');
select lives_ok(format($$ insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories)
                          values (auth.uid(), %L::date - 400, 'lunch', 'Backfill', 1) $$, current_setting('t.today')),
  'Backdating (400 days) is still allowed');

-- ==================================================================
-- 8. Existing triggers still cooperate (streaks, 004)
-- ==================================================================
select is((select current_streak from public.get_my_streak()), 1,
  'Provenance trigger and the streak trigger both run on insert');

select * from finish();
rollback;
