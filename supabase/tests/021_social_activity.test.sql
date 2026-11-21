-- 021: sharing settings, blocks, activity events and the feed.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- A is the viewer. B and C are A's friends, D is a stranger, E is A's friend who will be blocked.
insert into auth.users (id, email) values
  ('a2100000-0000-0000-0000-0000000000a1', 'feed-a@test.local'),
  ('b2100000-0000-0000-0000-0000000000b1', 'feed-b@test.local'),
  ('c2100000-0000-0000-0000-0000000000c1', 'feed-c@test.local'),
  ('d2100000-0000-0000-0000-0000000000d1', 'feed-d@test.local'),
  ('e2100000-0000-0000-0000-0000000000e1', 'feed-e@test.local');
insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, username)
select u.id, 30, 170, 70, 'female', 'maintain', u.name
from (values ('a2100000-0000-0000-0000-0000000000a1'::uuid, 'feed_a'), ('b2100000-0000-0000-0000-0000000000b1', 'feed_b'),
             ('c2100000-0000-0000-0000-0000000000c1', 'feed_c'), ('d2100000-0000-0000-0000-0000000000d1', 'feed_d'),
             ('e2100000-0000-0000-0000-0000000000e1', 'feed_e')) u(id, name);
insert into public.friendships (requester_id, addressee_id, status) values
  ('a2100000-0000-0000-0000-0000000000a1', 'b2100000-0000-0000-0000-0000000000b1', 'accepted'),
  ('c2100000-0000-0000-0000-0000000000c1', 'a2100000-0000-0000-0000-0000000000a1', 'accepted'),
  ('a2100000-0000-0000-0000-0000000000a1', 'e2100000-0000-0000-0000-0000000000e1', 'accepted');
insert into public.social_settings (user_id, share_activity) values
  ('b2100000-0000-0000-0000-0000000000b1', true),       -- B shares
  ('c2100000-0000-0000-0000-0000000000c1', false),      -- C does not (the default)
  ('d2100000-0000-0000-0000-0000000000d1', true),       -- D shares, but is not A's friend
  ('e2100000-0000-0000-0000-0000000000e1', true);
select public.record_activity('a2100000-0000-0000-0000-0000000000a1', 'streak_milestone', 'streak:3', '{"days": 3}');
select public.record_activity('b2100000-0000-0000-0000-0000000000b1', 'streak_milestone', 'streak:7', '{"days": 7}');
select public.record_activity('b2100000-0000-0000-0000-0000000000b1', 'achievement', 'first_day_logged',
                              '{"code": "first_day_logged", "title": "First day logged"}');
select public.record_activity('c2100000-0000-0000-0000-0000000000c1', 'habit_milestone', 'logged_days:7', '{"days": 7}');
select public.record_activity('d2100000-0000-0000-0000-0000000000d1', 'streak_milestone', 'streak:3', '{"days": 3}');
select public.record_activity('e2100000-0000-0000-0000-0000000000e1', 'streak_milestone', 'streak:3', '{"days": 3}');

-- ------------------------------------------------------------ payload and write protection
select throws_ok($$ insert into public.activity_events (actor_id, kind, dedupe_key, payload)
  values ('a2100000-0000-0000-0000-0000000000a1', 'streak_milestone', 'x', '{"days": 3, "calories": 1800}') $$,
  '23514', null, 'Event payloads cannot carry health data (only whitelisted keys)');
select throws_ok($$ insert into public.activity_events (actor_id, kind, dedupe_key, payload)
  values ('a2100000-0000-0000-0000-0000000000a1', 'achievement', 'y', '{"weight_kg": 70}') $$,
  '23514', null, '...for every kind');
select public.record_activity('b2100000-0000-0000-0000-0000000000b1', 'streak_milestone', 'streak:7', '{"days": 7}');
select is((select count(*)::int from public.activity_events where actor_id = 'b2100000-0000-0000-0000-0000000000b1'
           and dedupe_key = 'streak:7'), 1, 'A milestone is recorded once');
select is((select count(*)::int from pg_proc p, unnest(p.proargnames) a
           where p.proname = 'get_activity_feed' and a ~* '(kcal|calor|weight|protein|carb|fat|food|target)'), 0,
  'The feed returns no nutrition, weight or food columns');

-- ------------------------------------------------------------ the viewer
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2100000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select results_eq(
  $$ select actor_username, kind, is_me from public.get_activity_feed() order by actor_username, kind $$,
  $$ values ('feed_a'::text, 'streak_milestone'::text, true), ('feed_b', 'achievement', false),
            ('feed_b', 'streak_milestone', false), ('feed_e', 'streak_milestone', false) $$,
  'Own events plus friends who share; not a friend who keeps activity private, not a stranger');
select is((select count(*)::int from public.activity_events where actor_id <> 'a2100000-0000-0000-0000-0000000000a1'),
  0, 'Direct reads see only your own events');
select throws_ok($$ insert into public.activity_events (actor_id, kind, dedupe_key) values
  ('a2100000-0000-0000-0000-0000000000a1', 'achievement', 'fake') $$, '42501', null, 'Clients cannot write events');
select throws_ok($$ insert into public.user_blocks (blocker_id, blocked_id) values
  ('a2100000-0000-0000-0000-0000000000a1', 'd2100000-0000-0000-0000-0000000000d1') $$, '42501', null,
  'Blocks are created only through block_user()');
select lives_ok($$ insert into public.social_settings (share_activity) values (true) $$,
  'Users manage their own settings (user_id comes from auth.uid())');
select throws_ok($$ insert into public.social_settings (user_id, share_activity) values
  ('d2100000-0000-0000-0000-0000000000d1', true) $$, '42501', null, 'Clients cannot name the user_id');
select lives_ok($$ update public.social_settings set share_activity = false
  where user_id = 'b2100000-0000-0000-0000-0000000000b1' $$, 'Updating someone else''s settings matches nothing (RLS)');
reset role;
select is((select share_activity from public.social_settings where user_id = 'b2100000-0000-0000-0000-0000000000b1'),
  true, 'B''s settings are unchanged');

-- B turns off streak sharing: hidden from friends at once (past events too).
update public.social_settings set share_streaks = false where user_id = 'b2100000-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2100000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select results_eq($$ select kind from public.get_activity_feed() where actor_username = 'feed_b' $$,
  $$ values ('achievement'::text) $$, 'A per-kind setting hides past events immediately');

-- Blocking E ends the friendship and hides E everywhere.
select public.block_user('e2100000-0000-0000-0000-0000000000e1');
select is((select count(*)::int from public.get_activity_feed() where actor_username = 'feed_e'), 0,
  'A blocked friend disappears from the feed');
select is((select count(*)::int from public.friendships where 'e2100000-0000-0000-0000-0000000000e1' in (requester_id, addressee_id)),
  0, 'Blocking removes the friendship');
select throws_ok($$ insert into public.friendships (requester_id, addressee_id) values
  ('a2100000-0000-0000-0000-0000000000a1', 'e2100000-0000-0000-0000-0000000000e1') $$, '42501', null,
  'No friend request across a block');
select is((select username from public.get_blocked_users()), 'feed_e', 'You can see whom you blocked');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e2100000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
select is((select count(*)::int from public.find_profile_by_username('feed_a')), 0,
  'The blocked user cannot find the blocker by username');
select throws_ok($$ insert into public.friendships (requester_id, addressee_id) values
  ('e2100000-0000-0000-0000-0000000000e1', 'a2100000-0000-0000-0000-0000000000a1') $$, '42501', null,
  '...or send them a request');
reset role;

-- Unfriending B hides B's activity.
delete from public.friendships where requester_id = 'a2100000-0000-0000-0000-0000000000a1'
  and addressee_id = 'b2100000-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2100000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select is((select count(*)::int from public.get_activity_feed() where not is_me), 0,
  'A deleted friendship removes that friend''s activity');
reset role;

-- ------------------------------------------------------------ milestones from real logs
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g, created_at)
select 'c2100000-0000-0000-0000-0000000000c1', current_date - d, 'lunch', 'T21', 100, 10, 1, 1,
       (current_date - d) + time '12:00'
from generate_series(1, 7) d;                        -- each entered on its day (027: only on-time days count)
select results_eq(
  $$ select kind, dedupe_key from public.activity_events where actor_id = 'c2100000-0000-0000-0000-0000000000c1'
     order by kind, dedupe_key $$,
  $$ values ('achievement'::text, 'consistency_7'::text), ('achievement', 'first_day_logged'), ('achievement', 'first_week'),
            ('habit_milestone', 'logged_days:7'), ('streak_milestone', 'streak:3'), ('streak_milestone', 'streak:7') $$,
  'Seven consecutive logged days: achievements (024), a 7-day habit milestone and streak milestones');
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g, created_at)
values ('c2100000-0000-0000-0000-0000000000c1', current_date - 3, 'dinner', 'T21', 100, 10, 1, 1, (current_date - 3) + time '19:00');
select is((select count(*)::int from public.activity_events where actor_id = 'c2100000-0000-0000-0000-0000000000c1'), 6,
  'Logging again on an existing day announces nothing new');

-- ------------------------------------------------------------ pagination and performance
insert into public.activity_events (actor_id, kind, dedupe_key, payload, created_at)
select 'a2100000-0000-0000-0000-0000000000a1', 'habit_milestone', 'page:' || g, '{"days": 7}', now() - g * interval '1 minute'
from generate_series(1, 45) g;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2100000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
create temp table page1 as select * from public.get_activity_feed(null, null, 20);
select is((select count(*)::int from page1), 20, 'A page has the requested size');
create temp table page2 as select * from public.get_activity_feed(
  (select created_at from page1 order by created_at, id limit 1), (select id from page1 order by created_at, id limit 1), 20);
select is((select count(*)::int from page2), 20, 'The next page follows the cursor');
select is((select count(*)::int from page1 join page2 using (id)), 0, 'Pages never overlap');
select ok((select max(created_at) from page2) <= (select min(created_at) from page1), 'Pages are in time order');
select is((select count(*)::int from public.get_activity_feed(null, null, 1000)), 46, 'Page size is capped at 50');
select throws_ok($$ select * from public.get_activity_feed(null, gen_random_uuid(), 10) $$, '22023', null,
  'A cursor needs its timestamp');
reset role;

-- 20k events from 40 sharing friends: the feed stays fast.
insert into auth.users (id, email)
select ('f2100000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'perf' || g || '@test.local' from generate_series(1, 40) g;
insert into public.friendships (requester_id, addressee_id, status)
select 'a2100000-0000-0000-0000-0000000000a1', ('f2100000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'accepted'
from generate_series(1, 40) g;
insert into public.social_settings (user_id, share_activity)
select ('f2100000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, true from generate_series(1, 40) g;
insert into public.activity_events (actor_id, kind, dedupe_key, payload, created_at)
select ('f2100000-0000-0000-0000-' || lpad((g % 40 + 1)::text, 12, '0'))::uuid, 'habit_milestone', 'perf:' || g,
       '{"days": 30}', now() - g * interval '1 second'
from generate_series(1, 20000) g;
analyze public.activity_events;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2100000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select performs_ok($$ select * from public.get_activity_feed(null, null, 20) $$, 250, 'First page in under 250 ms');
select performs_ok($$ select * from public.get_activity_feed(now() - interval '3 hours', null, 20) $$, 250,
  'A deep page in under 250 ms');
reset role;

-- ------------------------------------------------------------ unauthorized
set local role anon;
select throws_ok($$ select * from public.get_activity_feed() $$, '42501', null, 'anon cannot read the feed');
select throws_ok($$ select * from public.activity_events $$, '42501', null, 'anon cannot read events');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select * from public.get_activity_feed() $$, '28000', null, 'No identity, no feed');
reset role;

select * from finish();
rollback;
