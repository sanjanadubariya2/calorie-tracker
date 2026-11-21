-- 024: achievements: thresholds, duplicate unlocks, time-zone boundaries,
-- backdated and fabricated activity, no revocation, silent backfill, RLS.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values
  ('a2400000-0000-0000-0000-0000000000a1', 'ac-a@test.local'),
  ('b2400000-0000-0000-0000-0000000000b1', 'ac-b@test.local'),
  ('c2400000-0000-0000-0000-0000000000c1', 'ac-c@test.local'),
  ('d2400000-0000-0000-0000-0000000000d1', 'ac-d@test.local'),
  ('e2400000-0000-0000-0000-0000000000e1', 'ac-e@test.local'),
  ('f2400000-0000-0000-0000-0000000000f1', 'ac-f@test.local');
insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, username, timezone)
select u.id, 30, 170, 70, 'female', 'maintain', u.name, u.tz
from (values ('a2400000-0000-0000-0000-0000000000a1'::uuid, 'ac_a', null::text),
             ('b2400000-0000-0000-0000-0000000000b1', 'ac_b', 'UTC'),
             ('c2400000-0000-0000-0000-0000000000c1', 'ac_c', null),
             ('d2400000-0000-0000-0000-0000000000d1', 'ac_d', 'Pacific/Kiritimati'),
             ('e2400000-0000-0000-0000-0000000000e1', 'ac_e', 'Pacific/Pago_Pago'),
             ('f2400000-0000-0000-0000-0000000000f1', 'ac_f', null)) u(id, name, tz);

-- An on-time log: created at noon UTC on the logged day (as the server would record it).
create or replace function pg_temp.log(p_user uuid, p_days_ago int, p_meal text default 'lunch') returns void
language sql as $$
  insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g, created_at)
  values (p_user, current_date - p_days_ago, p_meal, 'T24', 300, 30, 5, 10,
          (current_date - p_days_ago)::timestamp at time zone 'utc' + interval '12 hours');
$$;
create or replace function pg_temp.has(p_user uuid, p_code text) returns boolean language sql as $$
  select exists (select 1 from public.user_achievements where user_id = p_user and code = p_code);
$$;
create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;

select is((select count(*)::int from public.achievement_definitions where active), 15, 'Fifteen achievements');
select is((select count(*)::int from public.achievement_definitions
           where title || description ~* '\m(calor\w*|kcal|weight|deficit|kg|fast\w*)\M'), 0,
  'None is about calories, weight or restriction');

-- ------------------------------------------------------------ thresholds (A, time zone unknown)
select pg_temp.log('a2400000-0000-0000-0000-0000000000a1', d) from generate_series(1, 4) d;
select ok(pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'first_day_logged'), 'First meal unlocks on the first log');
select ok(not pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'first_week'), '4 days in a week: not yet');
select pg_temp.log('a2400000-0000-0000-0000-0000000000a1', 5);
select ok(pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'first_week'), '5 of 7 days: first consistent week');
select ok(not pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'consistency_7'), '5 days: not 7 in a row');
select pg_temp.log('a2400000-0000-0000-0000-0000000000a1', 7);
select ok(not pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'consistency_7'), '6 days with a gap: not 7 in a row');
select pg_temp.log('a2400000-0000-0000-0000-0000000000a1', 6);
select ok(pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'consistency_7'), 'Filling the gap on time: 7 in a row');
select ok(not pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'comeback'), 'No comeback without a break');
select pg_temp.log('a2400000-0000-0000-0000-0000000000a1', 20);
select ok(pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'comeback'), 'Returning after days off is rewarded');

-- Duplicates: re-evaluating changes nothing; each unlock is announced once.
select is(public.evaluate_achievements('a2400000-0000-0000-0000-0000000000a1'), 0, 'Re-evaluation unlocks nothing new');
select is(public.evaluate_achievements('a2400000-0000-0000-0000-0000000000a1'), 0, '...however often');
select is((select count(*)::int from public.activity_events where actor_id = 'a2400000-0000-0000-0000-0000000000a1'
           and kind = 'achievement'), (select count(*)::int from public.user_achievements
           where user_id = 'a2400000-0000-0000-0000-0000000000a1'), 'One feed announcement per unlock');
select is((select payload from public.activity_events where actor_id = 'a2400000-0000-0000-0000-0000000000a1'
           and dedupe_key = 'consistency_7'), '{"code": "consistency_7", "title": "7-day consistency"}'::jsonb,
  'The announcement carries only the code and title');
select throws_ok($$ insert into public.user_achievements (user_id, code) values
  ('a2400000-0000-0000-0000-0000000000a1', 'consistency_7') $$, '23505', null, 'The primary key forbids a second unlock');

-- Missed days and deletions never take an achievement away.
delete from public.food_logs where user_id = 'a2400000-0000-0000-0000-0000000000a1';
select is((select count(*)::int from public.user_achievements where user_id = 'a2400000-0000-0000-0000-0000000000a1'), 4,
  'Deleting every log keeps all four unlocks');

-- ------------------------------------------------------------ backdated and fabricated activity (B, UTC)
set local role authenticated;
select pg_temp.as_user('b2400000-0000-0000-0000-0000000000b1');
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g, created_at)
select 'b2400000-0000-0000-0000-0000000000b1', current_date - d, 'lunch', 'T24', 300, 30, 5, 10, '2020-01-01'
from generate_series(1, 10) d;
select ok((select bool_and(created_at > now() - interval '1 minute') from public.food_logs
           where user_id = 'b2400000-0000-0000-0000-0000000000b1'), 'Clients cannot choose created_at');
update public.food_logs set created_at = '2020-01-01' where user_id = 'b2400000-0000-0000-0000-0000000000b1';
select ok((select bool_and(created_at > now() - interval '1 minute') from public.food_logs
           where user_id = 'b2400000-0000-0000-0000-0000000000b1'), 'Nor change it later');
select results_eq($$ select longest_streak, logged_days from public.get_streak_summary() $$,
  $$ values (1, 1) $$, 'Since 027 the streak and achievements agree: only the on-time day (yesterday) counts');
select ok(not pg_temp.has('b2400000-0000-0000-0000-0000000000b1', 'first_week')
          and not pg_temp.has('b2400000-0000-0000-0000-0000000000b1', 'consistency_7'),
  'Ten days entered at once unlock no consistency achievement');
select ok(pg_temp.has('b2400000-0000-0000-0000-0000000000b1', 'first_day_logged'), '...though the on-time day counts');
update public.food_logs set logged_date = current_date - 30 where user_id = 'b2400000-0000-0000-0000-0000000000b1';
select throws_ok($$ insert into public.user_achievements (user_id, code) values
  ('b2400000-0000-0000-0000-0000000000b1', 'logged_100') $$, '42501', null, 'Clients cannot award achievements');
select throws_ok($$ update public.user_achievements set unlocked_at = now() - interval '1 year' $$, '42501', null,
  'Clients cannot edit unlocks');
select throws_ok($$ select public.evaluate_achievements('b2400000-0000-0000-0000-0000000000b1') $$, '42501', null,
  'Clients cannot run the evaluator');
select is((select count(*)::int from public.user_achievements where user_id <> 'b2400000-0000-0000-0000-0000000000b1'), 0,
  'RLS: only my own achievements are readable');
reset role;
select is((select count(*)::int from public.achievement_logged_days('b2400000-0000-0000-0000-0000000000b1')), 0,
  'Moving logs to old dates does not make them count');

-- ------------------------------------------------------------ time-zone boundaries
-- D is UTC+14: a log for day X made at 23:59 local on X+1 counts; at 00:01 on X+2 it doesn't.
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g, created_at) values
  ('d2400000-0000-0000-0000-0000000000d1', current_date - 30, 'lunch', 'T24', 300, 30, 5, 10,
   ((current_date - 29)::timestamp + interval '23 hours 59 minutes') at time zone 'Pacific/Kiritimati'),
  ('d2400000-0000-0000-0000-0000000000d1', current_date - 20, 'lunch', 'T24', 300, 30, 5, 10,
   ((current_date - 18)::timestamp + interval '1 minute') at time zone 'Pacific/Kiritimati'),
-- E is UTC-11: 23:30 local on X+1 is already X+2 in UTC, and still counts.
  ('e2400000-0000-0000-0000-0000000000e1', current_date - 30, 'lunch', 'T24', 300, 30, 5, 10,
   ((current_date - 29)::timestamp + interval '23 hours 30 minutes') at time zone 'Pacific/Pago_Pago'),
-- F has no zone: the window spans UTC-12..+14.
  ('f2400000-0000-0000-0000-0000000000f1', current_date - 30, 'lunch', 'T24', 300, 30, 5, 10,
   (current_date - 28)::timestamp at time zone 'utc' + interval '11 hours'),
  ('f2400000-0000-0000-0000-0000000000f1', current_date - 20, 'lunch', 'T24', 300, 30, 5, 10,
   (current_date - 18)::timestamp at time zone 'utc' + interval '13 hours');
select is(array(select public.achievement_logged_days('d2400000-0000-0000-0000-0000000000d1')),
  array[current_date - 30], 'UTC+14: the next local day counts, the one after does not');
select is(array(select public.achievement_logged_days('e2400000-0000-0000-0000-0000000000e1')),
  array[current_date - 30], 'UTC-11: judged in local time, not UTC');
select is(array(select public.achievement_logged_days('f2400000-0000-0000-0000-0000000000f1')),
  array[current_date - 30], 'Unknown zone: lenient up to the latest zone on Earth, no further');

-- ------------------------------------------------------------ challenges, habits, social
insert into public.challenges (id, template_code, kind, creator_id, starts_on, ends_on)
select ('e2400000-0000-0000-0000-00000000000' || w)::uuid, 'walk-5-days', 'individual', 'a2400000-0000-0000-0000-0000000000a1',
       date_trunc('week', current_date)::date - 7 * w, date_trunc('week', current_date)::date - 7 * w + 6
from generate_series(1, 3) w;
insert into public.challenge_participants (challenge_id, user_id, status, joined_at)
select id, 'a2400000-0000-0000-0000-0000000000a1', 'active', now() from public.challenges where creator_id = 'a2400000-0000-0000-0000-0000000000a1';
insert into public.challenge_checkins (challenge_id, user_id, day)
values ('e2400000-0000-0000-0000-000000000001', 'a2400000-0000-0000-0000-0000000000a1', date_trunc('week', current_date)::date - 7);
select ok(pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'first_checkin'), 'A first habit check-in');
update public.challenge_participants set status = 'completed', completed_at = now()
where challenge_id = 'e2400000-0000-0000-0000-000000000001';
select ok(pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'first_challenge'), 'First challenge completed');
update public.challenge_participants set status = 'completed', completed_at = now()
where challenge_id = 'e2400000-0000-0000-0000-000000000003';
select ok(not pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'challenge_weeks_3'), 'Weeks 1 and 3: not a run');
update public.challenge_participants set status = 'completed', completed_at = now()
where challenge_id = 'e2400000-0000-0000-0000-000000000002';
select ok(pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'challenge_weeks_3'), 'Three weeks in a row');
select ok(not pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'five_challenges'), 'Three of five');

-- Social: reactions given and received (one per person per event).
select public.record_activity('a2400000-0000-0000-0000-0000000000a1', 'streak_milestone', 'streak:3', '{"days": 3}');
insert into auth.users (id, email)
select ('92400000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'fan' || i || '@test.local' from generate_series(1, 10) i;
insert into public.activity_reactions (event_id, user_id, reaction)
select (select id from public.activity_events where actor_id = 'a2400000-0000-0000-0000-0000000000a1' and dedupe_key = 'streak:3'),
       ('92400000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'celebrate'
from generate_series(1, 9) i;
select ok(not pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'encouraged_10'), '9 reactions received: not yet');
select ok(pg_temp.has('92400000-0000-0000-0000-000000000001', 'first_encouragement'), 'Reacting earns a first encouragement');
insert into public.activity_reactions (event_id, user_id, reaction)
select (select id from public.activity_events where actor_id = 'a2400000-0000-0000-0000-0000000000a1' and dedupe_key = 'streak:3'),
       '92400000-0000-0000-0000-000000000010', 'fire';
select ok(pg_temp.has('a2400000-0000-0000-0000-0000000000a1', 'encouraged_10'), 'Ten reactions received');
update public.activity_reactions set reaction = 'like' where user_id = '92400000-0000-0000-0000-000000000001';
update public.activity_reactions set reaction = 'fire' where user_id = '92400000-0000-0000-0000-000000000001';
select is((select (public.achievement_metrics('92400000-0000-0000-0000-000000000001') ->> 'reactions_given')::int), 1,
  'Toggling a reaction does not inflate the count');

-- ------------------------------------------------------------ silent backfill
alter table public.food_logs disable trigger achievements_on_food_logs_insert;
select pg_temp.log('c2400000-0000-0000-0000-0000000000c1', d) from generate_series(1, 7) d;
alter table public.food_logs enable trigger achievements_on_food_logs_insert;
select is(public.evaluate_achievements('c2400000-0000-0000-0000-0000000000c1', false), 3, 'Backfill unlocks existing history');
select results_eq(
  $$ select count(*)::int, count(seen_at)::int from public.user_achievements where user_id = 'c2400000-0000-0000-0000-0000000000c1' $$,
  $$ values (3, 3) $$, '...marked as already celebrated');
select is((select count(*)::int from public.activity_events where actor_id = 'c2400000-0000-0000-0000-0000000000c1'
           and kind = 'achievement'), 0, '...and not announced in the feed');

-- ------------------------------------------------------------ reads and celebration
set local role authenticated;
select pg_temp.as_user('a2400000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from public.get_my_achievements()), 15, 'All achievements are listed, locked ones too');
select results_eq(
  $$ select unlocked_at is not null, progress, threshold from public.get_my_achievements() where code = 'five_challenges' $$,
  $$ values (false, 3, 5) $$, 'Locked achievements show progress');
select is((select count(*)::int from public.get_my_achievements() where unlocked_at is not null and seen_at is null), 8,
  'New unlocks wait to be celebrated');
select lives_ok($$ select public.mark_achievements_seen(array['consistency_7', 'first_week']) $$, 'Celebrate two');
select is((select count(*)::int from public.get_my_achievements() where unlocked_at is not null and seen_at is null), 6,
  'Each is celebrated once');
select results_eq($$ select challenge_week_run, challenges_completed from public.get_streak_summary() $$,
  $$ values (3, 3) $$, 'Challenge week streak in the summary');
reset role;

set local role anon;
select throws_ok($$ select * from public.get_my_achievements() $$, '42501', null, 'anon: no achievements');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select * from public.get_streak_summary() $$, '28000', null, 'No identity, no summary');
reset role;

select * from finish();
rollback;
