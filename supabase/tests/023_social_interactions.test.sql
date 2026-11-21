-- 023: reactions, comments, reports, moderation, notifications: RLS,
-- ownership, duplicates, blocks, deleted users, invalid content, rate limits.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();
grant content_moderator to postgres;   -- the test runner acts as a moderator (rolled back)
grant usage on schema extensions to content_moderator;

-- A shares activity with friends B, D, E. C is a stranger.
insert into auth.users (id, email) values
  ('a2300000-0000-0000-0000-0000000000a1', 'si-a@test.local'),
  ('b2300000-0000-0000-0000-0000000000b1', 'si-b@test.local'),
  ('c2300000-0000-0000-0000-0000000000c1', 'si-c@test.local'),
  ('d2300000-0000-0000-0000-0000000000d1', 'si-d@test.local'),
  ('e2300000-0000-0000-0000-0000000000e1', 'si-e@test.local');
insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, username)
select u.id, 30, 170, 70, 'female', 'maintain', u.name
from (values ('a2300000-0000-0000-0000-0000000000a1'::uuid, 'si_a'), ('b2300000-0000-0000-0000-0000000000b1', 'si_b'),
             ('c2300000-0000-0000-0000-0000000000c1', 'si_c'), ('d2300000-0000-0000-0000-0000000000d1', 'si_d'),
             ('e2300000-0000-0000-0000-0000000000e1', 'si_e')) u(id, name);
insert into public.friendships (requester_id, addressee_id, status) values
  ('a2300000-0000-0000-0000-0000000000a1', 'b2300000-0000-0000-0000-0000000000b1', 'accepted'),
  ('a2300000-0000-0000-0000-0000000000a1', 'd2300000-0000-0000-0000-0000000000d1', 'accepted'),
  ('e2300000-0000-0000-0000-0000000000e1', 'a2300000-0000-0000-0000-0000000000a1', 'accepted'),
  -- B (the commenter) knows D and E, so they can read B's comments (027 audience rule).
  ('b2300000-0000-0000-0000-0000000000b1', 'd2300000-0000-0000-0000-0000000000d1', 'accepted'),
  ('b2300000-0000-0000-0000-0000000000b1', 'e2300000-0000-0000-0000-0000000000e1', 'accepted');
insert into public.social_settings (user_id, share_activity) values ('a2300000-0000-0000-0000-0000000000a1', true);
select public.record_activity('a2300000-0000-0000-0000-0000000000a1', 'streak_milestone', 'streak:7', '{"days": 7}');
select public.record_activity('b2300000-0000-0000-0000-0000000000b1', 'streak_milestone', 'streak:7', '{"days": 7}');
create temp table ev as
  select (select id from public.activity_events where actor_id = 'a2300000-0000-0000-0000-0000000000a1') as a_ev,
         (select id from public.activity_events where actor_id = 'b2300000-0000-0000-0000-0000000000b1') as b_ev;
grant select on ev to authenticated, anon, service_role, content_moderator;

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;

-- ------------------------------------------------------------ reactions
set local role authenticated;
select pg_temp.as_user('b2300000-0000-0000-0000-0000000000b1');
select lives_ok($$ select public.set_reaction((select a_ev from ev), 'like') $$, 'A friend reacts to a shared milestone');
select lives_ok($$ select public.set_reaction((select a_ev from ev), 'like') $$, 'Reacting the same way again is a no-op');
select lives_ok($$ select public.set_reaction((select a_ev from ev), 'fire') $$, 'Changing the reaction replaces it');
select results_eq(
  $$ select like_count, fire_count, my_reaction from public.get_activity_interactions(array[(select a_ev from ev)]) $$,
  $$ values (0, 1, 'fire'::text) $$, 'One reaction per person per event, with counts');
select throws_ok($$ select public.set_reaction((select a_ev from ev), 'angry') $$, '22023', null, 'Only the four positive reactions');
select throws_ok($$ select public.set_reaction((select b_ev from ev), 'like') $$, '22023', null, 'No reacting to your own activity');
select throws_ok($$ insert into public.activity_reactions (event_id, user_id, reaction)
  values ((select a_ev from ev), 'd2300000-0000-0000-0000-0000000000d1', 'like') $$, '42501', null,
  'Cannot write reactions directly, let alone as someone else');
select throws_ok($$ update public.activity_reactions set reaction = 'like' $$, '42501', null, 'Cannot edit reactions directly');
select throws_ok($$ delete from public.activity_reactions $$, '42501', null, 'Cannot delete reactions directly');
reset role;

set local role authenticated;
select pg_temp.as_user('d2300000-0000-0000-0000-0000000000d1');
select lives_ok($$ select public.set_reaction((select a_ev from ev), 'celebrate') $$, 'Another friend reacts');
select is((select count(*)::int from public.activity_reactions), 1, 'RLS: I only see my own reaction rows');
select lives_ok($$ select public.remove_reaction((select a_ev from ev)) $$, 'Unlike');
select lives_ok($$ select public.remove_reaction((select a_ev from ev)) $$, 'Unliking twice is harmless');
select lives_ok($$ select public.set_reaction((select a_ev from ev), 'support') $$, 'React again');
reset role;

set local role authenticated;
select pg_temp.as_user('c2300000-0000-0000-0000-0000000000c1');
select throws_ok($$ select public.set_reaction((select a_ev from ev), 'like') $$, 'P0002', null, 'Strangers cannot react');
select is((select count(*)::int from public.get_activity_interactions(array[(select a_ev from ev)])), 0,
  'Strangers get no counts for events they cannot see');
select throws_ok($$ select * from public.get_comments((select a_ev from ev)) $$, 'P0002', null, 'Strangers cannot read comments');
select throws_ok($$ select public.add_comment((select a_ev from ev), 'hi') $$, 'P0002', null, 'Strangers cannot comment');
reset role;

-- ------------------------------------------------------------ comments
set local role authenticated;
select pg_temp.as_user('b2300000-0000-0000-0000-0000000000b1');
create temp table cm (id uuid);
grant all on cm to authenticated, service_role, content_moderator;
insert into cm select public.add_comment((select a_ev from ev), '  Well done!  ');
select is((select body from public.get_comments((select a_ev from ev))), 'Well done!', 'A friend comments (trimmed)');
select throws_ok($$ select public.add_comment((select a_ev from ev), 'Well done!') $$, '22023', null, 'No duplicate comment');
select throws_ok($$ select public.add_comment((select a_ev from ev), '   ') $$, '22023', null, 'No empty comments');
select throws_ok($$ select public.add_comment((select a_ev from ev), repeat('x', 281)) $$, '22023', null, 'At most 280 characters');
select throws_ok($$ select public.add_comment((select a_ev from ev), E'bad\x07bell') $$, '22023', null, 'No control characters');
select throws_ok($$ select public.add_comment((select a_ev from ev), E'1\n2\n3\n4\n5') $$, '22023', null, 'At most 4 lines');
select throws_ok($$ insert into public.activity_comments (event_id, author_id, body)
  values ((select a_ev from ev), 'a2300000-0000-0000-0000-0000000000a1', 'fake') $$, '42501', null,
  'Cannot write comments directly or as another user');
select lives_ok($$ select public.add_comment((select a_ev from ev), 'Two') $$, 'comment 2');
select lives_ok($$ select public.add_comment((select a_ev from ev), 'Three') $$, 'comment 3');
select lives_ok($$ select public.add_comment((select a_ev from ev), 'Four') $$, 'comment 4');
select lives_ok($$ select public.add_comment((select a_ev from ev), 'Five') $$, 'comment 5');
select throws_ok($$ select public.add_comment((select a_ev from ev), 'Six') $$, 'P0429', null, 'Rate limit: 5 comments a minute');
select results_eq($$ select is_mine, can_delete from public.get_comments((select a_ev from ev)) limit 1 $$,
  $$ values (true, true) $$, 'My comments are marked deletable');
reset role;

set local role authenticated;
select pg_temp.as_user('d2300000-0000-0000-0000-0000000000d1');
select results_eq($$ select is_mine, can_delete, author_username from public.get_comments((select a_ev from ev)) limit 1 $$,
  $$ values (false, false, 'si_b'::text) $$, 'Others'' comments are not deletable by me');
select throws_ok($$ select public.delete_comment((select id from cm)) $$, 'P0002', null, 'Cannot delete someone else''s comment');
select throws_ok($$ update public.activity_comments set body = 'edited' $$, '42501', null, 'Cannot edit comments');
reset role;

-- ------------------------------------------------------------ reports and moderation
set local role authenticated;
select pg_temp.as_user('b2300000-0000-0000-0000-0000000000b1');
select throws_ok($$ select public.report_content('comment', (select id from cm), 'spam') $$, 'P0002', null,
  'Cannot report your own comment');
reset role;
set local role authenticated;
select pg_temp.as_user('a2300000-0000-0000-0000-0000000000a1');
select throws_ok($$ select public.report_content('comment', (select id from cm), 'rude') $$, '22023', null, 'A reason from the list');
select lives_ok($$ select public.report_content('comment', (select id from cm), 'harassment', 'not nice') $$, 'Report a comment');
select lives_ok($$ select public.report_content('comment', (select id from cm), 'harassment') $$, 'Reporting twice is a no-op');
select is((select count(*)::int from public.get_comments((select a_ev from ev)) where id = (select id from cm)), 0,
  'The reporter stops seeing it at once');
select is((select count(*)::int from public.content_reports), 1, 'One report, visible to its reporter');
select throws_ok($$ select * from public.moderation_queue $$, '42501', null, 'Users cannot read the moderation queue');
select throws_ok($$ select public.moderate_report(gen_random_uuid(), 'remove') $$, '42501', null, 'Users cannot moderate');
select throws_ok($$ select public.report_content('profile', 'a2300000-0000-0000-0000-0000000000a1', 'spam') $$, 'P0002', null,
  'Cannot report yourself');
select lives_ok($$ select public.report_content('profile', 'c2300000-0000-0000-0000-0000000000c1', 'inappropriate') $$,
  'Report a profile');
reset role;
select is((select snapshot from public.content_reports where target_kind = 'profile'), '@si_c', 'Profile snapshot kept for review');
set local role authenticated;
select pg_temp.as_user('d2300000-0000-0000-0000-0000000000d1');
select is((select count(*)::int from public.get_comments((select a_ev from ev)) where id = (select id from cm)), 1,
  'Others still see it after one report');
select lives_ok($$ select public.report_content('comment', (select id from cm), 'spam') $$, 'second reporter');
reset role;
set local role authenticated;
select pg_temp.as_user('e2300000-0000-0000-0000-0000000000e1');
select lives_ok($$ select public.report_content('comment', (select id from cm), 'spam') $$, 'third reporter');
reset role;
select is((select status from public.activity_comments where id = (select id from cm)), 'hidden',
  'Three reporters hide a comment pending review');
set local role service_role;
select throws_ok($$ select * from public.moderation_queue $$, '42501', null, 'service_role (the API key) cannot read the queue');
reset role;
set local role content_moderator;
select is((select open_reports::int from public.moderation_queue where comment_id = (select id from cm) limit 1), 3,
  'Moderators see the queue with report counts');
select lives_ok($$ select public.moderate_report((select id from public.moderation_queue where comment_id = (select id from cm) limit 1),
  'restore', 'Not harassment on review') $$, 'A moderator restores it');
reset role;
select results_eq($$ select action, moderator, note from public.moderation_actions $$,
  $$ values ('restore'::text, 'postgres'::text, 'Not harassment on review'::text) $$, 'The decision is audited with the moderator''s login');
select results_eq($$ select (select status from public.activity_comments where id = (select id from cm)),
                           (select count(*)::int from public.content_reports where comment_id = (select id from cm) and status = 'open') $$,
  $$ values ('visible'::text, 0) $$, 'Restored and reports closed');

-- ------------------------------------------------------------ deletion by owner and author
set local role authenticated;
select pg_temp.as_user('a2300000-0000-0000-0000-0000000000a1');
select lives_ok($$ select public.delete_comment((select id from cm)) $$, 'The event owner can delete comments on their event');
select is((select count(*)::int from public.activity_comments where id = (select id from cm)), 0, '...and it is gone');
reset role;
set local role authenticated;
select pg_temp.as_user('b2300000-0000-0000-0000-0000000000b1');
select lives_ok($$ select public.delete_comment((select id from public.activity_comments where body = 'Two')) $$,
  'An author deletes their own comment');
reset role;

-- ------------------------------------------------------------ notifications
set local role authenticated;
select pg_temp.as_user('a2300000-0000-0000-0000-0000000000a1');
select results_eq($$ select kind, count(*)::int from public.get_notifications() group by kind order by kind $$,
  $$ values ('comment'::text, 3), ('reaction', 2) $$,
  'Friends'' reactions (one per friend, updated in place) and comments notify the owner');
select is((select reaction from public.get_notifications() where kind = 'reaction' and actor_username = 'si_b'), 'fire',
  'A changed reaction updates its notification');
select is(public.get_unread_notification_count(), 5, 'Unread count');
select lives_ok($$ select public.mark_notifications_read() $$, 'Mark all read');
select is(public.get_unread_notification_count(), 0, 'All read');
select throws_ok($$ update public.notifications set read_at = null $$, '42501', null, 'Notifications are not directly writable');
reset role;

-- ------------------------------------------------------------ visibility settings and blocks
update public.social_settings set share_streaks = false where user_id = 'a2300000-0000-0000-0000-0000000000a1';
set local role authenticated;
select pg_temp.as_user('b2300000-0000-0000-0000-0000000000b1');
select throws_ok($$ select public.set_reaction((select a_ev from ev), 'like') $$, 'P0002', null,
  'When the owner stops sharing that kind, nobody can react');
select is((select count(*)::int from public.get_activity_interactions(array[(select a_ev from ev)])), 0, '...or see counts');
reset role;
update public.social_settings set share_streaks = true where user_id = 'a2300000-0000-0000-0000-0000000000a1';

select public.block_user('d2300000-0000-0000-0000-0000000000d1') from (select pg_temp.as_user('a2300000-0000-0000-0000-0000000000a1')) x;
select is((select count(*)::int from public.notifications where actor_id = 'd2300000-0000-0000-0000-0000000000d1'), 0,
  'Blocking clears notifications from that person');
set local role authenticated;
select pg_temp.as_user('a2300000-0000-0000-0000-0000000000a1');
select is((select support_count from public.get_activity_interactions(array[(select a_ev from ev)])), 0,
  'A blocked person''s reaction is not counted for me');
reset role;
set local role authenticated;
select pg_temp.as_user('d2300000-0000-0000-0000-0000000000d1');
select throws_ok($$ select public.set_reaction((select a_ev from ev), 'like') $$, 'P0002', null, 'Blocked users cannot react');
select throws_ok($$ select public.add_comment((select a_ev from ev), 'hello?') $$, 'P0002', null, 'Blocked users cannot comment');
reset role;

-- ------------------------------------------------------------ deleted users
delete from auth.users where id = 'b2300000-0000-0000-0000-0000000000b1';
select results_eq(
  $$ select (select count(*)::int from public.activity_reactions where user_id = 'b2300000-0000-0000-0000-0000000000b1'),
            (select count(*)::int from public.activity_comments where author_id = 'b2300000-0000-0000-0000-0000000000b1'),
            (select count(*)::int from public.notifications where actor_id = 'b2300000-0000-0000-0000-0000000000b1') $$,
  $$ values (0, 0, 0) $$, 'Deleting an account removes its reactions, comments and notifications');

-- ------------------------------------------------------------ unauthorized
set local role anon;
select throws_ok($$ select public.set_reaction((select a_ev from ev), 'like') $$, '42501', null, 'anon cannot react');
select throws_ok($$ select * from public.get_notifications() $$, '42501', null, 'anon has no notifications');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select throws_ok($$ select public.add_comment((select a_ev from ev), 'x') $$, '28000', null, 'No identity, no comments');
reset role;

select * from finish();
rollback;
