-- 022: challenges: templates, participation, server-side progress, check-ins,
-- completion, expiry, groups and authorization.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, email) values
  ('a2200000-0000-0000-0000-0000000000a1', 'ch-a@test.local'),
  ('b2200000-0000-0000-0000-0000000000b1', 'ch-b@test.local'),
  ('c2200000-0000-0000-0000-0000000000c1', 'ch-c@test.local');
insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, username)
select u.id, 30, 170, 70, 'female', 'maintain', u.name
from (values ('a2200000-0000-0000-0000-0000000000a1'::uuid, 'ch_a'), ('b2200000-0000-0000-0000-0000000000b1', 'ch_b'),
             ('c2200000-0000-0000-0000-0000000000c1', 'ch_c')) u(id, name);
insert into public.friendships (requester_id, addressee_id, status) values
  ('a2200000-0000-0000-0000-0000000000a1', 'b2200000-0000-0000-0000-0000000000b1', 'accepted');

-- Templates are consistency habits only.
select is((select count(*)::int from public.challenge_templates), 11, 'Eleven curated templates');
select is((select count(*)::int from public.challenge_templates
           where title ~* '\m(calor\w*|kcal|weight|deficit|lose|fast\w*|kg)\M'
              or description ~* '\m(calor\w*|kcal|weight|deficit|fast\w*)\M'), 0,
  'No template is about calories, weight, deficits or fasting');
select ok((select bool_and(target_days < duration_days) from public.challenge_templates where cadence = 'weekly'),
  'Every weekly template leaves rest days');

-- A log-based weekly challenge that began 6 days ago (inserted directly: the API only starts today or later).
insert into public.challenges (id, template_code, kind, creator_id, starts_on, ends_on)
values ('e2200000-0000-0000-0000-000000000001', 'log-5-days', 'individual', 'a2200000-0000-0000-0000-0000000000a1',
        current_date - 6, current_date);
insert into public.challenge_participants (challenge_id, user_id, status, joined_at)
values ('e2200000-0000-0000-0000-000000000001', 'a2200000-0000-0000-0000-0000000000a1', 'active', now());
select throws_ok($$ insert into public.challenge_participants (challenge_id, user_id, status)
  values ('e2200000-0000-0000-0000-000000000001', 'a2200000-0000-0000-0000-0000000000a1', 'active') $$,
  '23505', null, 'One participation per user per challenge');
select throws_ok($$ insert into public.challenges (template_code, kind, creator_id, starts_on, ends_on)
  values ('log-5-days', 'individual', 'a2200000-0000-0000-0000-0000000000a1', current_date, current_date - 1) $$,
  '23514', null, 'A challenge cannot end before it starts');
select throws_ok($$ insert into public.challenges (template_code, kind, creator_id, starts_on, ends_on)
  values ('log-5-days', 'individual', 'a2200000-0000-0000-0000-0000000000a1', current_date, current_date + 30) $$,
  '23514', null, 'Challenges last at most two weeks');

-- ------------------------------------------------------------ progress from food logs
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g, created_at)
select 'a2200000-0000-0000-0000-0000000000a1', current_date - d, 'lunch', 'T22', 300, 30, 5, 10, (current_date - d) + time '12:00'
from generate_series(1, 4) d;
select is((select progress_days from public.challenge_participants
           where challenge_id = 'e2200000-0000-0000-0000-000000000001'), 4, 'Logged days are counted by the server');
select is((select status from public.challenge_participants where challenge_id = 'e2200000-0000-0000-0000-000000000001'),
  'active', 'Not complete at 4 of 5');
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g, created_at)
values ('a2200000-0000-0000-0000-0000000000a1', current_date - 1, 'dinner', 'T22', 300, 30, 5, 10, (current_date - 1) + time '12:00');
select is((select progress_days from public.challenge_participants
           where challenge_id = 'e2200000-0000-0000-0000-000000000001'), 4, 'Several logs on one day count once');
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g, created_at)
values ('a2200000-0000-0000-0000-0000000000a1', current_date - 9, 'lunch', 'T22', 300, 30, 5, 10, (current_date - 9) + time '12:00');
select is((select progress_days from public.challenge_participants
           where challenge_id = 'e2200000-0000-0000-0000-000000000001'), 4, 'Days outside the challenge do not count');
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g)
values ('a2200000-0000-0000-0000-0000000000a1', current_date - 6, 'lunch', 'T22 late', 300, 30, 5, 10);
select is((select progress_days from public.challenge_participants
           where challenge_id = 'e2200000-0000-0000-0000-000000000001'), 4,
  'A day entered late (now, for 6 days ago) does not count, even inside the window (027)');
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g, created_at)
values ('a2200000-0000-0000-0000-0000000000a1', current_date - 5, 'breakfast', 'T22', 300, 30, 5, 10, (current_date - 5) + time '12:00');
select results_eq(
  $$ select status, progress_days, completed_at is not null from public.challenge_participants
     where challenge_id = 'e2200000-0000-0000-0000-000000000001' $$,
  $$ values ('completed'::text, 5, true) $$, 'The fifth logged day completes the challenge');
select public.refresh_challenge_participant('e2200000-0000-0000-0000-000000000001', 'a2200000-0000-0000-0000-0000000000a1');
select public.refresh_challenge_participant('e2200000-0000-0000-0000-000000000001', 'a2200000-0000-0000-0000-0000000000a1');
select results_eq(
  $$ select kind, dedupe_key from public.activity_events where actor_id = 'a2200000-0000-0000-0000-0000000000a1'
     and (kind = 'challenge_completed' or dedupe_key in ('first_challenge', 'five_challenges')) order by kind $$,
  $$ values ('achievement'::text, 'first_challenge'::text),
            ('challenge_completed', 'challenge:e2200000-0000-0000-0000-000000000001') $$,
  'Completion is announced once, with the first-challenge achievement, however often it is refreshed');
select is((select payload ->> 'title' from public.activity_events where kind = 'challenge_completed'
           and actor_id = 'a2200000-0000-0000-0000-0000000000a1'), 'Log meals on 5 days',
  'The feed event names the challenge, nothing about food');

-- ------------------------------------------------------------ late logs cannot backfill a finished challenge
insert into public.challenges (id, template_code, kind, creator_id, starts_on, ends_on)
values ('e2200000-0000-0000-0000-000000000002', 'breakfast-5-days', 'individual', 'b2200000-0000-0000-0000-0000000000b1',
        current_date - 20, current_date - 14);
insert into public.challenge_participants (challenge_id, user_id, status, joined_at)
values ('e2200000-0000-0000-0000-000000000002', 'b2200000-0000-0000-0000-0000000000b1', 'active', now() - interval '20 days');
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g)
select 'b2200000-0000-0000-0000-0000000000b1', current_date - d, 'breakfast', 'T22', 300, 30, 5, 10
from generate_series(14, 20) d;
select results_eq(
  $$ select status, progress_days from public.challenge_participants where challenge_id = 'e2200000-0000-0000-0000-000000000002' $$,
  $$ values ('active'::text, 0) $$, 'Logs added after a challenge ended never complete it');

-- ------------------------------------------------------------ as user A: API
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2200000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select throws_ok($$ update public.challenge_participants set progress_days = 99 $$, '42501', null,
  'Clients cannot write progress');
select throws_ok($$ insert into public.challenge_checkins (challenge_id, user_id, day)
  values ('e2200000-0000-0000-0000-000000000001', 'a2200000-0000-0000-0000-0000000000a1', current_date) $$,
  '42501', null, 'Clients cannot write check-ins directly');
select throws_ok($$ insert into public.challenges (template_code, kind, creator_id, starts_on, ends_on)
  values ('log-today', 'individual', 'a2200000-0000-0000-0000-0000000000a1', current_date, current_date) $$,
  '42501', null, 'Clients cannot create challenges directly');
select throws_ok($$ select public.leave_challenge('e2200000-0000-0000-0000-000000000001') $$, '55000', null,
  'A completed challenge cannot be left');
select throws_ok($$ select public.start_challenge('lose-5-kg') $$, 'P0002', null, 'Only curated templates exist');
select throws_ok($$ select public.start_challenge('log-5-days', current_date - 10) $$, '22023', null,
  'Challenges cannot start in the past');
select throws_ok($$ select public.start_challenge('log-5-days', null, array['c2200000-0000-0000-0000-0000000000c1'::uuid]) $$,
  '22023', null, 'Only friends can be invited');

-- Self-reported: a walk challenge with friend B.
select ok(public.start_challenge('walk-5-days', null, array['b2200000-0000-0000-0000-0000000000b1'::uuid]) is not null,
  'A group challenge with a friend starts');
create temp table walk as select challenge_id from public.get_my_challenges() where template_code = 'walk-5-days';
select is((select public.check_in_challenge((select challenge_id from walk))), 1, 'Check in today: 1 day');
select is((select public.check_in_challenge((select challenge_id from walk))), 1, 'Checking in twice the same day still counts once');
select throws_ok($$ select public.check_in_challenge((select challenge_id from walk), current_date - 3) $$, '22023', null,
  'No check-ins for days long past');
select throws_ok($$ select public.check_in_challenge((select challenge_id from walk), current_date + 3) $$, '22023', null,
  'No check-ins for the future');
select throws_ok($$ select public.check_in_challenge('e2200000-0000-0000-0000-000000000001') $$, '22023', null,
  'Log-tracked challenges take no check-ins');
select results_eq(
  $$ select state, kind, target_days, checked_in_today from public.get_my_challenges() where template_code = 'walk-5-days' $$,
  $$ values ('active'::text, 'group'::text, 5, true) $$, 'My challenges show state and today''s check-in');
select results_eq(
  $$ select username, state from public.get_challenge_participants((select challenge_id from walk)) $$,
  $$ values ('ch_a'::text, 'active'::text), ('ch_b', 'invited') $$, 'Members are listed, me first then alphabetically');
reset role;

-- B accepts; C (not a member) sees nothing.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b2200000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
select is((select state from public.get_my_challenges() where template_code = 'walk-5-days'), 'invited', 'B sees the invitation');
select lives_ok($$ select public.join_challenge((select challenge_id from walk)) $$, 'B joins');
select lives_ok($$ select public.join_challenge((select challenge_id from walk)) $$, 'Joining twice is a no-op');
select is((select count(*)::int from public.challenge_participants where challenge_id = (select challenge_id from walk)
           and user_id = 'b2200000-0000-0000-0000-0000000000b1'), 1, '...with a single participation');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c2200000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
select throws_ok($$ select * from public.get_challenge_participants((select challenge_id from walk)) $$, 'P0002', null,
  'Non-members cannot see a group challenge');
select throws_ok($$ select public.join_challenge((select challenge_id from walk)) $$, 'P0002', null,
  'Non-members cannot join a private challenge');
select is((select count(*)::int from public.challenges where id = (select challenge_id from walk)), 0,
  'Non-members cannot read it directly either');
select throws_ok($$ select public.check_in_challenge((select challenge_id from walk)) $$, 'P0002', null,
  'Non-members cannot check in');

-- App challenges are open to anyone, and strangers are never listed.
create temp table app as select app_challenge_id from public.get_challenge_catalog() where template_code = 'log-5-days';
select ok((select app_challenge_id from app) is not null, 'This week''s app challenge exists');
select lives_ok($$ select public.join_challenge((select app_challenge_id from app)) $$, 'Anyone can join an app challenge');
select is((select count(*)::int from public.get_challenge_participants((select app_challenge_id from app))), 0,
  'App challenge participants are not listed');
reset role;

-- ------------------------------------------------------------ expiry
insert into public.challenges (id, template_code, kind, creator_id, starts_on, ends_on)
values ('e2200000-0000-0000-0000-000000000003', 'log-5-days', 'group', 'a2200000-0000-0000-0000-0000000000a1',
        current_date - 20, current_date - 14);
insert into public.challenge_participants (challenge_id, user_id, status, joined_at, invited_by) values
  ('e2200000-0000-0000-0000-000000000003', 'a2200000-0000-0000-0000-0000000000a1', 'active', now(), null),
  ('e2200000-0000-0000-0000-000000000003', 'b2200000-0000-0000-0000-0000000000b1', 'invited', null,
   'a2200000-0000-0000-0000-0000000000a1');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2200000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select is((select state from public.get_my_challenges() where challenge_id = 'e2200000-0000-0000-0000-000000000003'),
  'expired', 'An unfinished challenge past its end is expired');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b2200000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
select throws_ok($$ select public.join_challenge('e2200000-0000-0000-0000-000000000003') $$, '55000', null,
  'An ended challenge cannot be joined');
reset role;

-- A block hides the inviter and their challenge members.
select public.block_user('b2200000-0000-0000-0000-0000000000b1') from (select set_config('request.jwt.claims',
  '{"sub":"a2200000-0000-0000-0000-0000000000a1","role":"authenticated"}', true)) x;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2200000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select is((select count(*)::int from public.get_challenge_participants((select challenge_id from walk)) where not is_me), 0,
  'Blocked users are hidden from challenge members');
reset role;

-- ------------------------------------------------------------ unauthorized
set local role anon;
select throws_ok($$ select * from public.get_my_challenges() $$, '42501', null, 'anon: no challenges');
select throws_ok($$ select public.start_challenge('log-today') $$, '42501', null, 'anon cannot start one');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.join_challenge(gen_random_uuid()) $$, '28000', null, 'No identity, no joining');
reset role;

select * from finish();
rollback;
