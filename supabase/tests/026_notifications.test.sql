-- 026: notification creation, delivery eligibility (preferences, blocks,
-- visibility), duplicates, read state, pagination, push queue, authorization.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();
grant notification_sender to postgres;   -- rolled back with the test
grant usage on schema extensions to notification_sender;

insert into auth.users (id, email) values
  ('a2600000-0000-0000-0000-0000000000a1', 'nt-a@test.local'),
  ('b2600000-0000-0000-0000-0000000000b1', 'nt-b@test.local'),
  ('c2600000-0000-0000-0000-0000000000c1', 'nt-c@test.local');
insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, username, timezone)
select u.id, 30, 170, 70, 'female', 'maintain', u.name, 'UTC'
from (values ('a2600000-0000-0000-0000-0000000000a1'::uuid, 'nt_a'), ('b2600000-0000-0000-0000-0000000000b1', 'nt_b'),
             ('c2600000-0000-0000-0000-0000000000c1', 'nt_c')) u(id, name);

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
create or replace function pg_temp.kinds(p uuid) returns text[] language sql as $$
  select coalesce(array_agg(kind || coalesce(':' || (read_at is not null)::text, '') order by created_at, kind), '{}')
  from public.notifications where recipient_id = p;
$$;

-- ------------------------------------------------------------ friend requests
set local role authenticated;
select pg_temp.as_user('a2600000-0000-0000-0000-0000000000a1');
insert into public.friendships (requester_id, addressee_id) values
  ('a2600000-0000-0000-0000-0000000000a1', 'b2600000-0000-0000-0000-0000000000b1'),
  ('a2600000-0000-0000-0000-0000000000a1', 'c2600000-0000-0000-0000-0000000000c1');
reset role;
select is(pg_temp.kinds('b2600000-0000-0000-0000-0000000000b1'), array['friend_request:false'], 'A request notifies the addressee');
set local role authenticated;
select pg_temp.as_user('c2600000-0000-0000-0000-0000000000c1');
select public.respond_to_friend_request((select id from public.friendships
  where addressee_id = 'c2600000-0000-0000-0000-0000000000c1'), false);
reset role;
select is(pg_temp.kinds('c2600000-0000-0000-0000-0000000000c1'), '{}'::text[], 'A declined request leaves no notification');
set local role authenticated;
select pg_temp.as_user('b2600000-0000-0000-0000-0000000000b1');
select public.respond_to_friend_request((select id from public.friendships
  where addressee_id = 'b2600000-0000-0000-0000-0000000000b1'), true);
reset role;
select is(pg_temp.kinds('a2600000-0000-0000-0000-0000000000a1'), array['friend_accepted:false'], 'Acceptance notifies the requester');
select is(pg_temp.kinds('b2600000-0000-0000-0000-0000000000b1'), array['friend_request:true'], 'The answered request is marked read');

-- ------------------------------------------------------------ milestones, preferences
insert into public.social_settings (user_id, share_activity) values ('a2600000-0000-0000-0000-0000000000a1', true);
select public.record_activity('a2600000-0000-0000-0000-0000000000a1', 'streak_milestone', 'streak:3', '{"days": 3}');
select public.record_activity('a2600000-0000-0000-0000-0000000000a1', 'streak_milestone', 'streak:7', '{"days": 7}');
select is((select count(*)::int from public.notifications where recipient_id = 'b2600000-0000-0000-0000-0000000000b1'
           and kind = 'friend_milestone'), 1, 'Friends hear about shared 7+ day milestones only');
select is((select payload from public.notifications where kind = 'friend_milestone'), '{"days": 7}'::jsonb,
  'The milestone notification carries the day count only');
update public.social_settings set share_streaks = false where user_id = 'a2600000-0000-0000-0000-0000000000a1';
select public.record_activity('a2600000-0000-0000-0000-0000000000a1', 'streak_milestone', 'streak:14', '{"days": 14}');
select is((select count(*)::int from public.notifications where kind = 'friend_milestone'), 1,
  'Unshared milestones notify nobody');
update public.social_settings set share_streaks = true where user_id = 'a2600000-0000-0000-0000-0000000000a1';
set local role authenticated;
select pg_temp.as_user('b2600000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.get_notifications() where kind = 'friend_milestone'), 1, 'B sees it');
insert into public.notification_preferences (friend_milestones, reactions) values (false, false);
select throws_ok($$ insert into public.notification_preferences (user_id, comments)
  values ('a2600000-0000-0000-0000-0000000000a1', false) $$, '42501', null, 'Cannot set someone else''s preferences');
reset role;
select public.record_activity('a2600000-0000-0000-0000-0000000000a1', 'streak_milestone', 'streak:30', '{"days": 30}');
select is((select count(*)::int from public.notifications where kind = 'friend_milestone'), 1,
  'A turned-off category is not created');

-- Reactions respect preferences; comments still notify.
select public.record_activity('b2600000-0000-0000-0000-0000000000b1', 'habit_milestone', 'logged_days:7', '{"days": 7}');
insert into public.social_settings (user_id, share_activity) values ('b2600000-0000-0000-0000-0000000000b1', true);
create temp table bev as select id from public.activity_events where actor_id = 'b2600000-0000-0000-0000-0000000000b1';
grant select on bev to authenticated;
set local role authenticated;
select pg_temp.as_user('a2600000-0000-0000-0000-0000000000a1');
select public.set_reaction((select id from bev), 'fire');
select public.add_comment((select id from bev), 'Great!');
reset role;
select results_eq($$ select kind from public.notifications where recipient_id = 'b2600000-0000-0000-0000-0000000000b1'
                     and kind in ('reaction', 'comment') $$, $$ values ('comment'::text) $$,
  'Reactions off: only the comment notifies');

-- ------------------------------------------------------------ challenges and achievements
set local role authenticated;
select pg_temp.as_user('a2600000-0000-0000-0000-0000000000a1');
create temp table ch as select public.start_challenge('walk-5-days', current_date + 1,
  array['b2600000-0000-0000-0000-0000000000b1'::uuid]) as id;
grant select on ch to authenticated, notification_sender;
reset role;
select is((select payload ->> 'title' from public.notifications where recipient_id = 'b2600000-0000-0000-0000-0000000000b1'
           and kind = 'challenge_invite'), 'Walk on 5 days', 'An invitation notifies the invitee, with the title');
set local role authenticated;
select pg_temp.as_user('b2600000-0000-0000-0000-0000000000b1');
select public.join_challenge((select id from ch));
select is((select is_read from public.get_notifications() where kind = 'challenge_invite'), true, 'Joining marks it read');
select is((select count(*)::int from public.get_notifications() where kind = 'challenge_starting'), 1,
  'A challenge starting tomorrow reminds people who joined in advance');
select is((select count(*)::int from public.get_notifications() where kind = 'challenge_starting'), 1,
  '...once, however often notifications are read');
reset role;
update public.challenge_participants set status = 'completed', completed_at = now()
where challenge_id = (select id from ch) and user_id = 'b2600000-0000-0000-0000-0000000000b1';
select ok((select count(*) = 1 from public.notifications where recipient_id = 'b2600000-0000-0000-0000-0000000000b1'
           and kind = 'challenge_completed'), 'Completing a challenge notifies');
select ok((select count(*) >= 1 from public.notifications where recipient_id = 'b2600000-0000-0000-0000-0000000000b1'
           and kind = 'achievement_unlocked' and dedupe_key = 'first_challenge'), 'Unlocking an achievement notifies');
select is((select count(*)::int from public.notifications where kind = 'achievement_unlocked'
           and recipient_id = 'b2600000-0000-0000-0000-0000000000b1' and dedupe_key = 'first_challenge'), 1, '...once');
insert into public.user_achievements (user_id, code, seen_at) values ('c2600000-0000-0000-0000-0000000000c1', 'logged_50', now());
select is(pg_temp.kinds('c2600000-0000-0000-0000-0000000000c1'), '{}'::text[], 'Silent backfill does not notify');
-- Routine actions never notify: after the first-meal achievement, more logs add nothing.
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g)
values ('c2600000-0000-0000-0000-0000000000c1', current_date, 'lunch', 'T26', 300, 30, 5, 10);
create temp table before_logs as select count(*) as n from public.notifications where recipient_id = 'c2600000-0000-0000-0000-0000000000c1';
insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, carbs_g, fat_g, protein_g)
select 'c2600000-0000-0000-0000-0000000000c1', current_date, m, 'T26', 300, 30, 5, 10 from unnest(array['dinner', 'breakfast']) m;
select is((select count(*) from public.notifications where recipient_id = 'c2600000-0000-0000-0000-0000000000c1'),
  (select n from before_logs), 'Logging food never creates notifications by itself');

-- Duplicates.
select lives_ok($$ select public.notify('b2600000-0000-0000-0000-0000000000b1', 'challenge_completed',
  'challenge:' || (select id from ch), p_challenge => (select id from ch)) $$, 'Re-notifying is a no-op');
select is((select count(*)::int from public.notifications where kind = 'challenge_completed'), 1, '...no duplicate');

-- ------------------------------------------------------------ read state, pagination, isolation
set local role authenticated;
select pg_temp.as_user('b2600000-0000-0000-0000-0000000000b1');
create temp table page1 as select * from public.get_notifications(null, null, 2);
select is((select count(*)::int from page1), 2, 'Page of 2');
select is((select count(*)::int from public.get_notifications(
  (select min(created_at) from page1), (select id from page1 order by created_at, id limit 1), 50)
  where id in (select id from page1)), 0, 'The next page does not repeat the first');
select throws_ok($$ select * from public.get_notifications(null, gen_random_uuid(), 5) $$, '22023', null,
  'A cursor needs its timestamp');
select lives_ok($$ select public.mark_notifications_read(array[(select id from public.get_notifications() where not is_read limit 1)]) $$,
  'Mark one read');
select lives_ok($$ select public.mark_notifications_read() $$, 'Mark all read');
select is(public.get_unread_notification_count(), 0, 'Nothing unread');
select lives_ok($$ select public.mark_notifications_read(array(select id from public.notifications)) $$,
  'Marking ids that are not mine does nothing');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, kind, event_id)
  values ('a2600000-0000-0000-0000-0000000000a1', 'b2600000-0000-0000-0000-0000000000b1', 'reaction',
          (select id from public.activity_events limit 1)) $$, '42501', null, 'Clients cannot create notifications');
select is((select count(*)::int from public.notifications where recipient_id <> 'b2600000-0000-0000-0000-0000000000b1'), 0,
  'RLS: only my notifications are readable');
select is((select count(*)::int from public.notification_preferences), 1, 'RLS: only my preferences');
reset role;
select ok((select count(*) > 0 from public.notifications where recipient_id = 'a2600000-0000-0000-0000-0000000000a1'
           and read_at is null), 'A''s notifications stayed unread');

-- Blocks: nothing new, and old ones hidden.
select public.block_user('a2600000-0000-0000-0000-0000000000a1') from (select pg_temp.as_user('b2600000-0000-0000-0000-0000000000b1')) x;
set local role authenticated;
select pg_temp.as_user('b2600000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.get_notifications() where actor_id = 'a2600000-0000-0000-0000-0000000000a1'), 0,
  'Nothing from a blocked person is shown');
reset role;
select lives_ok($$ select public.notify('b2600000-0000-0000-0000-0000000000b1', 'friend_request', 'x',
  'a2600000-0000-0000-0000-0000000000a1', p_friendship => gen_random_uuid()) $$, 'blocked notify attempt');
select is((select count(*)::int from public.notifications where dedupe_key = 'x'), 0, 'The gate drops it');
select public.unblock_user('a2600000-0000-0000-0000-0000000000a1') from (select pg_temp.as_user('b2600000-0000-0000-0000-0000000000b1')) x;

-- ------------------------------------------------------------ push
set local role authenticated;
select pg_temp.as_user('c2600000-0000-0000-0000-0000000000c1');
select throws_ok($$ select public.register_push_token('not-a-token', 'ios') $$, '22023', null, 'Token format checked');
select throws_ok($$ select public.register_push_token('ExponentPushToken[abcdefghij1234]', 'symbian') $$, '22023', null,
  'Platform checked');
select lives_ok($$ select public.register_push_token('ExponentPushToken[abcdefghij1234]', 'ios') $$, 'Register a device');
select throws_ok($$ insert into public.push_tokens (user_id, token, platform)
  values ('a2600000-0000-0000-0000-0000000000a1', 'ExponentPushToken[zzzzzzzzzz9999]', 'ios') $$, '42501', null,
  'Tokens cannot be written directly');
select throws_ok($$ select * from public.push_outbox $$, '42501', null, 'The outbox is not readable by users');
select throws_ok($$ select * from public.claim_push_batch(10) $$, '42501', null, 'Users cannot run delivery');
reset role;
-- Push is off by default: a request creates an in-app notification only.
insert into public.friendships (requester_id, addressee_id) values
  ('a2600000-0000-0000-0000-0000000000a1', 'c2600000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from public.push_outbox where user_id = 'c2600000-0000-0000-0000-0000000000c1'), 0, 'Push off by default: nothing queued');
insert into public.notification_preferences (user_id, push_enabled) values ('c2600000-0000-0000-0000-0000000000c1', true);
delete from public.friendships where addressee_id = 'c2600000-0000-0000-0000-0000000000c1';
insert into public.friendships (requester_id, addressee_id) values
  ('a2600000-0000-0000-0000-0000000000a1', 'c2600000-0000-0000-0000-0000000000c1');
select is((select count(*)::int from public.push_outbox where user_id = 'c2600000-0000-0000-0000-0000000000c1'), 1, 'With push on, a friend request is queued');
select public.notify('c2600000-0000-0000-0000-0000000000c1', 'achievement_unlocked', 'logged_100',
                     p_payload => '{"title": "100 days logged", "code": "logged_100"}');
select is((select count(*)::int from public.push_outbox where user_id = 'c2600000-0000-0000-0000-0000000000c1'), 1, 'Achievements stay in-app (no push)');

set local role notification_sender;
create temp table claimed as select * from public.claim_push_batch(10);
select results_eq($$ select token, title, body, data ->> 'kind' from claimed $$,
  $$ values ('ExponentPushToken[abcdefghij1234]'::text, 'New friend request'::text, '@nt_a wants to be friends.'::text,
             'friend_request'::text) $$, 'The worker gets the token, safe text and deep-link data');
select is((select count(*)::int from public.claim_push_batch(10)), 0, 'A claimed push is not handed out twice');
select public.record_push_result((select outbox_id from claimed), false, null, 'MessageRateExceeded');
reset role;
select results_eq($$ select status, attempts, next_attempt_at > now() from public.push_outbox where user_id = 'c2600000-0000-0000-0000-0000000000c1' $$,
  $$ values ('pending'::text, 1, true) $$, 'A transient error is retried later');
update public.push_outbox set next_attempt_at = now() where user_id = 'c2600000-0000-0000-0000-0000000000c1';
set local role notification_sender;
select is((select count(*)::int from public.claim_push_batch(10)), 1, 'Retried when due');
select throws_ok($$ select * from public.push_outbox $$, '42501', null, 'The sender cannot read tables, only call its functions');
reset role;
select public.record_push_result((select id from public.push_outbox where user_id = 'c2600000-0000-0000-0000-0000000000c1' limit 1), false, null, 'DeviceNotRegistered');
select results_eq($$ select (select status from public.push_outbox where user_id = 'c2600000-0000-0000-0000-0000000000c1'),
                           (select disabled_reason from public.push_tokens where token = 'ExponentPushToken[abcdefghij1234]') $$,
  $$ values ('failed'::text, 'DeviceNotRegistered'::text) $$, 'An unregistered device is disabled');
select lives_ok($$ select public.register_push_token('ExponentPushToken[abcdefghij1234]', 'android') $$, 'x')
  from (select pg_temp.as_user('a2600000-0000-0000-0000-0000000000a1')) x;
select is((select user_id from public.push_tokens where token = 'ExponentPushToken[abcdefghij1234]'), 'a2600000-0000-0000-0000-0000000000a1'::uuid,
  'A re-registered device follows the account now signed in')
  from (select 1) x;

-- Read in the app before delivery: skipped.
update public.push_tokens set user_id = 'c2600000-0000-0000-0000-0000000000c1', disabled_at = null where token = 'ExponentPushToken[abcdefghij1234]';
select public.notify('c2600000-0000-0000-0000-0000000000c1', 'challenge_starting', 'skip-me', p_challenge => (select id from ch));
select ok((select count(*) = 1 from public.push_outbox where status = 'pending' and user_id = 'c2600000-0000-0000-0000-0000000000c1'), 'queued');
update public.notifications set read_at = now() where dedupe_key = 'skip-me';
set local role notification_sender;
select is((select count(*)::int from public.claim_push_batch(10)), 0, 'Already read in the app: not pushed');
reset role;
select is((select status from public.push_outbox o join public.notifications n on n.id = o.notification_id
           where n.dedupe_key = 'skip-me'), 'skipped', '...and marked skipped');

-- At most 20 pushes a day per person.
insert into public.notifications (recipient_id, kind, challenge_id, dedupe_key)
select 'c2600000-0000-0000-0000-0000000000c1', 'challenge_starting', (select id from ch), 'cap-' || i from generate_series(1, 30) i;
select ok((select count(*) <= 20 from public.push_outbox where user_id = 'c2600000-0000-0000-0000-0000000000c1'),
  'Push is capped at 20 a day');

-- ------------------------------------------------------------ unauthorized
set local role anon;
select throws_ok($$ select * from public.get_notifications() $$, '42501', null, 'anon: no notifications');
select throws_ok($$ select public.register_push_token('ExponentPushToken[abcdefghij1234]', 'ios') $$, '42501', null,
  'anon cannot register devices');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.get_unread_notification_count() $$, '28000', null, 'No identity, no count');
reset role;

select * from finish();
rollback;
