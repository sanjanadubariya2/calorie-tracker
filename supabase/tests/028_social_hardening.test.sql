-- 027 hardening: comment audience, moderation, one activity policy (time
-- zones, backdating), old clients, retention, push monitoring.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- O shares activity. Friends of O: A (the commenter), M (also A's friend), N (not A's friend), K (A's friend, but
-- K and A blocked each other). S is a stranger to O.
insert into auth.users (id, email)
select ('a2800000-0000-0000-0000-0000000000' || x)::uuid, 'h' || x || '@test.local'
from unnest(array['01', '02', '03', '04', '05', '06']) x;
insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, username, avatar_url)
select ('a2800000-0000-0000-0000-0000000000' || x)::uuid, 30, 170, 70, 'female', 'maintain', 'h_' || n, 'https://x/' || n
from (values ('01', 'o'), ('02', 'a'), ('03', 'm'), ('04', 'n'), ('05', 'k'), ('06', 's')) v(x, n);
create temp table u(name text primary key, id uuid);
insert into u select n, ('a2800000-0000-0000-0000-0000000000' || x)::uuid
from (values ('01', 'o'), ('02', 'a'), ('03', 'm'), ('04', 'n'), ('05', 'k'), ('06', 's')) v(x, n);
grant select on u to authenticated, content_moderator;
create or replace function pg_temp.id(p text) returns uuid language sql as $$ select id from u where name = p $$;
create or replace function pg_temp.as_user(p text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', (select id from u where name = p), 'role', 'authenticated')::text, true);
$$;
insert into public.friendships (requester_id, addressee_id, status)
select pg_temp.id(a), pg_temp.id(b), 'accepted'
from (values ('o', 'a'), ('o', 'm'), ('o', 'n'), ('o', 'k'), ('a', 'm'), ('a', 'k')) f(a, b);
insert into public.social_settings (user_id, share_activity) values (pg_temp.id('o'), true);
insert into public.user_blocks (blocker_id, blocked_id) values (pg_temp.id('k'), pg_temp.id('a'));
select public.record_activity(pg_temp.id('o'), 'streak_milestone', 'streak:7', '{"days": 7}');
create temp table ev as select id from public.activity_events where actor_id = pg_temp.id('o');
grant select on ev to authenticated, content_moderator;

-- A comments (A and K are blocked from each other, but both can see O's event).
set local role authenticated;
select pg_temp.as_user('a');
create temp table cm as select public.add_comment((select id from ev), 'Great job!') as id;
grant select on cm to authenticated, content_moderator, social_maintainer;
reset role;
set local role authenticated;
select pg_temp.as_user('o');
select public.add_comment((select id from ev), 'Thanks all');
reset role;

create or replace function pg_temp.sees(p text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(p);
  execute 'set local role authenticated';
  begin
    select string_agg(body, ',' order by body) into v from public.get_comments((select id from ev));
  exception when others then v := 'ERR:' || sqlstate;
  end;
  execute 'reset role';
  return coalesce(v, '');
end;
$$;

-- ------------------------------------------------------------ 1. comment audience
select is(pg_temp.sees('o'), 'Great job!,Thanks all', 'The event owner reads every comment');
select is(pg_temp.sees('a'), 'Great job!,Thanks all', 'The author reads their own comment (and the owner''s)');
select is(pg_temp.sees('m'), 'Great job!,Thanks all', 'A friend of the author who can see the event reads it');
select is(pg_temp.sees('n'), 'Thanks all', 'A friend of the owner who doesn''t know the author does not');
select is(pg_temp.sees('k'), 'Thanks all', 'Blocked from the author: not shown, even as their friend');
select is(pg_temp.sees('s'), 'ERR:P0002', 'A stranger to the owner sees no comments at all');

set local role authenticated;
select pg_temp.as_user('n');
select is((select comment_count from public.get_activity_interactions(array[(select id from ev)])), 1,
  'Comment counts follow the same audience');
select throws_ok($$ select public.report_content('comment', (select id from cm), 'spam') $$, 'P0002', null,
  'Nobody can report a comment they cannot read');
reset role;
set local role authenticated;
select pg_temp.as_user('m');
select is((select comment_count from public.get_activity_interactions(array[(select id from ev)])), 2, '...2 for the author''s friend');
reset role;

update public.social_settings set share_activity = false where user_id = pg_temp.id('o');
select is(pg_temp.sees('a'), 'ERR:P0002', 'When the owner stops sharing, even the author no longer sees the thread');
select is(pg_temp.sees('o'), 'Great job!,Thanks all', '...the owner still does');
update public.social_settings set share_activity = true where user_id = pg_temp.id('o');

-- ------------------------------------------------------------ 2. moderation
select ok(not pg_has_role('authenticator', 'content_moderator', 'member'),
  'The API''s authenticator cannot switch to content_moderator (no JWT can reach it)');
select ok(not (select rolcanlogin from pg_roles where rolname = 'content_moderator'), 'content_moderator is a group, not a login');
select throws_ok($$ select public.moderate_report(gen_random_uuid(), 'dismiss') $$, '42501', null,
  'A database login that is not a moderator is refused');
set local role authenticated;
select pg_temp.as_user('m');
select lives_ok($$ select public.report_content('comment', (select id from cm), 'harassment') $$, 'M reports A''s comment');
select lives_ok($$ select public.report_content('profile', (select id from u where name = 'a'), 'inappropriate') $$,
  'M reports A''s profile');
select throws_ok($$ select public.moderate_report((select id from public.content_reports limit 1), 'remove') $$, '42501', null,
  'App users cannot moderate');
select throws_ok($$ select * from public.moderation_actions $$, '42501', null, 'App users cannot read decisions');
reset role;
set local role service_role;
select throws_ok($$ select public.moderate_report(gen_random_uuid(), 'remove') $$, '42501', null,
  'service_role (held by the API key) cannot moderate');
reset role;

grant content_moderator to postgres;          -- the test runner becomes a moderator (rolled back)
grant usage on schema extensions to content_moderator;
create temp table rep as
  select (select id from public.content_reports where target_kind = 'comment') as c,
         (select id from public.content_reports where target_kind = 'profile') as p;
grant select on rep to content_moderator;
set local role content_moderator;
select is((select count(*)::int from public.moderation_queue), 2, 'Moderators see open reports');
select throws_ok($$ select public.moderate_report((select c from rep), 'clear_avatar') $$, '22023', null,
  'Actions must fit the report type');
select lives_ok($$ select public.moderate_report((select c from rep), 'remove', 'Harassment confirmed') $$, 'Remove a comment');
select throws_ok($$ select public.moderate_report((select c from rep), 'restore') $$, '55000', null, 'A resolved report stays resolved');
select lives_ok($$ select public.moderate_report((select p from rep), 'clear_avatar') $$, 'Clear a reported avatar');
select is((select count(*)::int from public.moderation_actions), 2, 'Both decisions are audited');
select throws_ok($$ update public.activity_comments set status = 'visible' $$, '42501', null,
  'Moderators change content only through moderate_report');
reset role;
select results_eq($$ select (select status from public.activity_comments where id = (select id from cm)),
                           (select avatar_url from public.profiles where user_id = pg_temp.id('a')) $$,
  $$ values ('removed'::text, null::text) $$, 'The comment is removed for everyone and the avatar cleared');
select is(pg_temp.sees('o'), 'Thanks all', 'A removed comment is gone for the owner too');

-- ------------------------------------------------------------ 3. one activity policy
-- T is UTC+14, W is UTC-11, Z has no zone. Logs are inserted as the server
-- would record them (created_at = the moment of entry).
insert into auth.users (id, email) values
  ('b2800000-0000-0000-0000-0000000000a1', 'tz-t@test.local'), ('b2800000-0000-0000-0000-0000000000a2', 'tz-w@test.local'),
  ('b2800000-0000-0000-0000-0000000000a3', 'tz-z@test.local');
insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, username, timezone) values
  ('b2800000-0000-0000-0000-0000000000a1', 30, 170, 70, 'female', 'maintain', 'tz_t', 'Pacific/Kiritimati'),
  ('b2800000-0000-0000-0000-0000000000a2', 30, 170, 70, 'female', 'maintain', 'tz_w', 'Pacific/Pago_Pago'),
  ('b2800000-0000-0000-0000-0000000000a3', 30, 170, 70, 'female', 'maintain', 'tz_z', null);
create or replace function pg_temp.log_at(p_user uuid, p_day date, p_local timestamp, p_tz text) returns void language sql as $$
  insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories, created_at)
  values (p_user, p_day, 'lunch', 'T28', 100, p_local at time zone p_tz);
$$;

-- UTC+14: three days, each entered late in its own local evening -> a 3-day streak.
select pg_temp.log_at('b2800000-0000-0000-0000-0000000000a1', current_date - d, (current_date - d) + time '23:50',
                      'Pacific/Kiritimati') from generate_series(3, 5) d;
select results_eq($$ select longest_streak from public.user_streaks where user_id = 'b2800000-0000-0000-0000-0000000000a1' $$,
  $$ values (3) $$, 'UTC+14: entries made late on their own local day count');
-- Logged for day X just after midnight two local days later: too late.
select pg_temp.log_at('b2800000-0000-0000-0000-0000000000a1', current_date - 6, (current_date - 4) + time '00:05',
                      'Pacific/Kiritimati');
select results_eq($$ select longest_streak from public.user_streaks where user_id = 'b2800000-0000-0000-0000-0000000000a1' $$,
  $$ values (3) $$, 'UTC+14: an entry two local days late does not extend the streak');
-- ...but "yesterday's dinner, logged this morning" does.
select pg_temp.log_at('b2800000-0000-0000-0000-0000000000a1', current_date - 2, (current_date - 1) + time '08:00',
                      'Pacific/Kiritimati');
select results_eq($$ select longest_streak from public.user_streaks where user_id = 'b2800000-0000-0000-0000-0000000000a1' $$,
  $$ values (4) $$, 'UTC+14: an entry the next morning counts (one-day grace)');

-- UTC-11: 23:30 local on day X+1 is already X+2 in UTC; judged in local time, it counts.
select pg_temp.log_at('b2800000-0000-0000-0000-0000000000a2', current_date - 10, (current_date - 9) + time '23:30',
                      'Pacific/Pago_Pago');
select is((select count(*)::int from public.active_days('b2800000-0000-0000-0000-0000000000a2')), 1,
  'UTC-11: a next-day entry counts in local time');

-- No zone: lenient to the latest zone on Earth, no further.
select pg_temp.log_at('b2800000-0000-0000-0000-0000000000a3', current_date - 10, (current_date - 8) + time '11:00', 'utc');
select pg_temp.log_at('b2800000-0000-0000-0000-0000000000a3', current_date - 20, (current_date - 18) + time '13:00', 'utc');
select is(array(select public.active_days('b2800000-0000-0000-0000-0000000000a3')), array[current_date - 10],
  'Unknown zone: up to UTC-12''s next day, and no later');

-- Streak, achievements and challenges agree on the same days.
select is((select longest_streak from public.user_streaks where user_id = 'b2800000-0000-0000-0000-0000000000a1'),
          (select max(n)::int from (select count(*) over (order by (d - date '2000-01-01') range between 3 preceding and current row) n
                                    from public.active_days('b2800000-0000-0000-0000-0000000000a1') d) x),
  'The streak is computed from exactly the days achievements use');

-- A recomputation under the policy never lowers badges.
update public.user_streaks set badges_earned = 5 where user_id = 'b2800000-0000-0000-0000-0000000000a1';
select public.recalculate_user_streak('b2800000-0000-0000-0000-0000000000a1');
select is((select badges_earned from public.user_streaks where user_id = 'b2800000-0000-0000-0000-0000000000a1'), 5,
  'Badges are a high-water mark: never taken away by a recomputation');
select has_table('public', 'streak_policy_audit', 'Policy changes to existing streaks are recorded');
set local role authenticated;
select pg_temp.as_user('o');
select throws_ok($$ select * from public.streak_policy_audit $$, '42501', null, 'The audit is not readable by app users');
select throws_ok($$ select * from public.active_days(auth.uid()) $$, '42501', null, 'Internal helpers are not callable');
reset role;

-- ------------------------------------------------------------ 4. retention
-- Fixture: an expired event with a reaction, a comment and a notification; an
-- expired event whose comment has an open report; a live event.
insert into public.activity_events (actor_id, kind, dedupe_key, payload, created_at, expires_at) values
  (pg_temp.id('o'), 'habit_milestone', 'old-1', '{"days": 7}', now() - interval '200 days', now() - interval '20 days'),
  (pg_temp.id('o'), 'habit_milestone', 'old-2', '{"days": 30}', now() - interval '200 days', now() - interval '20 days');
create temp table old_ev as select dedupe_key, id from public.activity_events where dedupe_key in ('old-1', 'old-2');
insert into public.activity_reactions (event_id, user_id, reaction) select id, pg_temp.id('a'), 'like' from old_ev;
insert into public.activity_comments (id, event_id, author_id, body)
select gen_random_uuid(), id, pg_temp.id('a'), 'old ' || dedupe_key from old_ev;
insert into public.content_reports (reporter_id, target_kind, comment_id, target_user_id, snapshot, reason)
select pg_temp.id('m'), 'comment', c.id, pg_temp.id('a'), c.body, 'spam'
from public.activity_comments c join old_ev e on e.id = c.event_id where e.dedupe_key = 'old-2';
insert into public.notifications (recipient_id, actor_id, kind, event_id, reaction, created_at)
select pg_temp.id('o'), pg_temp.id('a'), 'reaction', id, 'like', now() - interval '200 days' from old_ev where dedupe_key = 'old-1';
-- Notifications: read and old (purged), unread and 100 days old (kept), unread and 400 days old (purged).
insert into public.notifications (recipient_id, kind, dedupe_key, payload, created_at, read_at) values
  (pg_temp.id('m'), 'achievement_unlocked', 'r-old', '{}', now() - interval '100 days', now() - interval '99 days'),
  (pg_temp.id('m'), 'achievement_unlocked', 'u-100', '{}', now() - interval '100 days', null),
  (pg_temp.id('m'), 'achievement_unlocked', 'u-400', '{}', now() - interval '400 days', null);
-- Push: an old finished delivery, an old pending one (live device), a pending one for a disabled device,
-- a stale device, and a device disabled long ago.
insert into public.push_tokens (id, user_id, token, platform, last_seen_at, disabled_at) values
  ('c2800000-0000-0000-0000-000000000001', pg_temp.id('m'), 'ExponentPushToken[live0000000001]', 'ios', now(), null),
  ('c2800000-0000-0000-0000-000000000002', pg_temp.id('m'), 'ExponentPushToken[stale000000002]', 'ios', now() - interval '120 days', null),
  ('c2800000-0000-0000-0000-000000000003', pg_temp.id('m'), 'ExponentPushToken[dead0000000003]', 'android', now() - interval '60 days',
   now() - interval '40 days'),
  ('c2800000-0000-0000-0000-000000000004', pg_temp.id('m'), 'ExponentPushToken[gone0000000004]', 'android', now(), now() - interval '1 day');
insert into public.push_outbox (notification_id, token_id, user_id, status, created_at)
select n.id, t.id, pg_temp.id('m'), s.status, now() - s.age
from (values ('c2800000-0000-0000-0000-000000000001'::uuid, 'sent', interval '40 days'),
             ('c2800000-0000-0000-0000-000000000001'::uuid, 'pending', interval '40 days'),
             ('c2800000-0000-0000-0000-000000000004'::uuid, 'pending', interval '2 hours')) s(tok, status, age)
join public.push_tokens t on t.id = s.tok
cross join lateral (select id from public.notifications where dedupe_key = 'u-100') n
on conflict do nothing;
-- (one row per notification/token pair: the 'sent' and 'pending' rows above share a pair, so use another notification)
insert into public.push_outbox (notification_id, token_id, user_id, status, created_at)
select (select id from public.notifications where dedupe_key = 'u-400'), 'c2800000-0000-0000-0000-000000000001',
       pg_temp.id('m'), 'pending', now() - interval '40 days';
insert into public.social_rate_log (user_id, action, at) values
  (pg_temp.id('a'), 'comment_hour', now() - interval '3 days'), (pg_temp.id('a'), 'comment_hour', now() - interval '1 hour');

set local role authenticated;
select pg_temp.as_user('o');
select throws_ok($$ select * from public.purge_social_data() $$, '42501', null, 'App users cannot run retention');
reset role;
grant social_maintainer to postgres;           -- rolled back
grant usage on schema extensions to social_maintainer;

set local role social_maintainer;
create temp table dry as select * from public.purge_social_data(true);
reset role;
select ok((select sum(affected) > 0 from dry), 'A dry run reports what would go');
select is((select count(*)::int from public.activity_events where dedupe_key in ('old-1', 'old-2')), 2, '...and deletes nothing');

set local role social_maintainer;
create temp table purged as select * from public.purge_social_data();
reset role;
select results_eq($$ select dedupe_key from public.activity_events where dedupe_key in ('old-1', 'old-2') $$,
  $$ values ('old-2'::text) $$, 'Expired events go, except one with an open report awaiting review');
select is((select count(*)::int from public.activity_events where id = (select id from ev)), 1, 'Live events stay');
select results_eq(
  $$ select (select count(*)::int from public.activity_reactions where event_id = (select id from old_ev where dedupe_key = 'old-1')),
            (select count(*)::int from public.activity_comments where event_id = (select id from old_ev where dedupe_key = 'old-1')),
            (select count(*)::int from public.notifications where event_id = (select id from old_ev where dedupe_key = 'old-1')) $$,
  $$ values (0, 0, 0) $$, 'Its reactions, comments and notifications go with it (no orphans)');
select results_eq($$ select dedupe_key from public.notifications where dedupe_key in ('r-old', 'u-100', 'u-400') order by 1 $$,
  $$ values ('u-100'::text) $$, 'Read notifications after 90 days and any after a year go; recent unread ones stay');
select results_eq(
  $$ select t.token, o.status from public.push_outbox o join public.push_tokens t on t.id = o.token_id order by 1, 2 $$,
  $$ values ('ExponentPushToken[gone0000000004]'::text, 'skipped'::text) $$,
  'Old finished deliveries go; undeliverable pending pushes are closed (skipped), never sent; nothing in flight is touched');
select results_eq($$ select token, case when disabled_at is null then 'active' else coalesce(disabled_reason, 'disabled') end
                     from public.push_tokens where user_id = (select id from u where name = 'm') order by 1 $$,
  $$ values ('ExponentPushToken[gone0000000004]'::text, 'disabled'::text), ('ExponentPushToken[live0000000001]', 'active'),
            ('ExponentPushToken[stale000000002]', 'stale') $$,
  'Devices unseen for 90 days are disabled, long-disabled ones deleted, live ones kept');
select results_eq($$ select count(*) filter (where at < now() - interval '2 days')::int, count(*) filter (where at > now() - interval '2 hours')::int
                     from public.social_rate_log where user_id = (select id from u where name = 'a') $$,
  $$ values (0, 3) $$, 'Rate-limit entries older than 2 days go; current ones stay (and keep enforcing limits)');
select is((select count(*)::int from public.content_reports where comment_id is not null), 2,
  'Reports, open and resolved, are kept for audit');

-- ------------------------------------------------------------ 5. push monitoring
grant notification_sender to postgres;
grant usage on schema extensions to notification_sender;
set local role notification_sender;
select ok((select active_devices >= 1 from public.push_health()), 'The delivery role can read push health');
reset role;
set local role authenticated;
select pg_temp.as_user('o');
select throws_ok($$ select * from public.push_health() $$, '42501', null, 'App users cannot');
reset role;

select * from finish();
rollback;
