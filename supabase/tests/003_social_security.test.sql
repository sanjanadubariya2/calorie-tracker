-- Database-level tests for supabase/migrations/003_social_security.sql.
--
-- Run with the Supabase CLI against a local stack (migrations 001–003 applied):
--   supabase start
--   supabase test db
--
-- Every statement under test runs as the `authenticated` role with a real JWT
-- `sub` claim, so RLS, table/column grants, and function EXECUTE privileges
-- are exercised exactly as PostgREST would exercise them. Setup and
-- verification run as the session owner (postgres) to see ground truth.
-- Everything happens inside one transaction and is rolled back at the end.

begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(44);

-- ------------------------------------------------------------------
-- Production-equivalent table grants.
--
-- Migrations 001/002 rely on Supabase's *legacy* default privileges, which
-- gave anon/authenticated full DML on every new public table. Current
-- Supabase versions (including the local CLI stack) no longer do that, so
-- without this block authenticated would get "permission denied" on these
-- tables and the RLS policies below would never be exercised. Granting the
-- legacy privileges reproduces the production attack surface; RLS must then
-- do the protecting. friendships is deliberately left alone: 003 sets its
-- grants explicitly, and those are under test. Rolled back with everything else.
-- ------------------------------------------------------------------
grant select, insert, update, delete on public.profiles, public.food_logs, public.user_streaks
  to anon, authenticated;

-- ------------------------------------------------------------------
-- Fixtures: three users with profiles, and food logs for A.
-- ------------------------------------------------------------------
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'user_a@test.local'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'user_b@test.local'),
  ('cccccccc-0000-0000-0000-000000000003', 'user_c@test.local');

insert into public.profiles (user_id, age, height_cm, weight_kg, gender, goal, daily_target_kcal, username) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 30, 170, 70, 'female', 'lose', 1800, 'user_a'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 31, 180, 80, 'male', 'maintain', 2400, 'user_b'),
  ('cccccccc-0000-0000-0000-000000000003', 32, 160, 60, 'female', 'gain', 2100, 'user_c');

-- "today" is any date inside the permitted window; UTC today always is.
select set_config('test.today', ((now() at time zone 'utc')::date)::text, true);

insert into public.food_logs (user_id, logged_date, meal_type, food_name, calories) values
  ('aaaaaaaa-0000-0000-0000-000000000001', current_setting('test.today')::date, 'breakfast', 'Oats', 300),
  ('aaaaaaaa-0000-0000-0000-000000000001', current_setting('test.today')::date, 'lunch', 'Dal rice', 450),
  ('aaaaaaaa-0000-0000-0000-000000000001', current_setting('test.today')::date - 30, 'dinner', 'Old meal', 999);

-- Claims for each identity, stored as settings so statements can reference them.
select set_config('test.claims_a', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);
select set_config('test.claims_b', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);
select set_config('test.claims_c', '{"sub":"cccccccc-0000-0000-0000-000000000003","role":"authenticated"}', true);

-- ==================================================================
-- Case 1: User A sends a request to User B
-- ==================================================================
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_a'), true);

select lives_ok(
  $$ insert into public.friendships (requester_id, addressee_id)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002') $$,
  '1. A can send a request to B (ids only)'
);

select results_eq(
  $$ select user_id, username from public.get_outgoing_requests() $$,
  $$ values ('bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'user_b'::text) $$,
  '1. A sees the request in get_outgoing_requests()'
);

reset role;
select set_config('test.req1',
  (select id::text from public.friendships
   where requester_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and addressee_id = 'bbbbbbbb-0000-0000-0000-000000000002'), true);

select is(
  (select status from public.friendships where id = current_setting('test.req1')::uuid),
  'pending',
  '1. New request is stored as pending'
);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_b'), true);

select results_eq(
  $$ select friendship_id, user_id, username from public.get_pending_requests() $$,
  $$ select current_setting('test.req1')::uuid,
            'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'user_a'::text $$,
  '1. B sees the request in get_pending_requests()'
);

-- ==================================================================
-- Case 6: User C cannot create an accepted friendship directly
-- ==================================================================
select set_config('request.jwt.claims', current_setting('test.claims_c'), true);

select throws_ok(
  $$ insert into public.friendships (requester_id, addressee_id, status)
     values ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'accepted') $$,
  '42501', null,
  '6. C cannot insert a row with status = accepted'
);

select throws_ok(
  $$ insert into public.friendships (requester_id, addressee_id, status)
     values ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'pending') $$,
  '42501', null,
  '6. Clients cannot supply status at all (column-level INSERT grant)'
);

select throws_ok(
  $$ insert into public.friendships (requester_id, addressee_id)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003') $$,
  '42501', null,
  '6. C cannot create a request on behalf of A (requester must be the caller)'
);

-- ==================================================================
-- Case 8: Users cannot befriend themselves
-- ==================================================================
select throws_ok(
  $$ insert into public.friendships (requester_id, addressee_id)
     values ('cccccccc-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000003') $$,
  '42501', null,
  '8. Self-friendship insert is rejected (RLS check runs before the no_self_friendship CHECK)'
);

-- ==================================================================
-- Case 9: Duplicate requests are rejected, in both directions
-- ==================================================================
select set_config('request.jwt.claims', current_setting('test.claims_a'), true);
select throws_ok(
  $$ insert into public.friendships (requester_id, addressee_id)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002') $$,
  '23505', null,
  '9. A cannot send B a second request'
);

select set_config('request.jwt.claims', current_setting('test.claims_b'), true);
select throws_ok(
  $$ insert into public.friendships (requester_id, addressee_id)
     values ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001') $$,
  '23505', null,
  '9. B cannot send a reverse request while A->B exists'
);

-- ==================================================================
-- Case 5: User C cannot accept A's request to B (nor can A accept it)
-- ==================================================================
select set_config('request.jwt.claims', current_setting('test.claims_c'), true);
select throws_ok(
  format('select public.respond_to_friend_request(%L::uuid, true)', current_setting('test.req1')),
  'P0002', null,
  '5. C cannot accept a request addressed to B'
);
select throws_ok(
  format('select public.respond_to_friend_request(%L::uuid, false)', current_setting('test.req1')),
  'P0002', null,
  '5. C cannot decline a request addressed to B'
);
select throws_ok(
  format('select public.cancel_friend_request(%L::uuid)', current_setting('test.req1')),
  'P0002', null,
  '5. C cannot cancel a request sent by A'
);

select set_config('request.jwt.claims', current_setting('test.claims_a'), true);
select throws_ok(
  format('select public.respond_to_friend_request(%L::uuid, true)', current_setting('test.req1')),
  'P0002', null,
  '5. The requester cannot accept their own request'
);

-- ==================================================================
-- Case 7: User B cannot modify requester/addressee (no direct UPDATE at all)
-- ==================================================================
select set_config('request.jwt.claims', current_setting('test.claims_b'), true);
select throws_ok(
  format($$ update public.friendships set requester_id = 'cccccccc-0000-0000-0000-000000000003'
            where id = %L::uuid $$, current_setting('test.req1')),
  '42501', null,
  '7. B cannot rewrite requester_id'
);
select throws_ok(
  format($$ update public.friendships set addressee_id = 'cccccccc-0000-0000-0000-000000000003'
            where id = %L::uuid $$, current_setting('test.req1')),
  '42501', null,
  '7. B cannot rewrite addressee_id'
);
select throws_ok(
  format($$ update public.friendships set status = 'accepted' where id = %L::uuid $$,
         current_setting('test.req1')),
  '42501', null,
  '7. B cannot accept by direct UPDATE either'
);

reset role;
select results_eq(
  format($$ select requester_id, addressee_id, status from public.friendships where id = %L::uuid $$,
         current_setting('test.req1')),
  $$ values ('aaaaaaaa-0000-0000-0000-000000000001'::uuid,
             'bbbbbbbb-0000-0000-0000-000000000002'::uuid, 'pending'::text) $$,
  '5/7. Request is untouched after all the rejected attempts'
);

-- ==================================================================
-- Case 10: Unconnected users (and pending pairs) get no summaries
-- ==================================================================
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_b'), true);
select is_empty(
  format('select * from public.get_friend_summaries(%L::date)', current_setting('test.today')),
  '10. A pending request does not expose summaries'
);

-- ==================================================================
-- Case 2: User B accepts the request
-- ==================================================================
select lives_ok(
  format('select public.respond_to_friend_request(%L::uuid, true)', current_setting('test.req1')),
  '2. B can accept A''s request'
);

reset role;
select is(
  (select status from public.friendships where id = current_setting('test.req1')::uuid),
  'accepted',
  '2. Request is now accepted'
);

set local role authenticated;
select throws_ok(
  format('select public.respond_to_friend_request(%L::uuid, false)', current_setting('test.req1')),
  '55000', null,
  '2. An accepted request cannot be answered again'
);

select set_config('request.jwt.claims', current_setting('test.claims_a'), true);
select throws_ok(
  format('select public.cancel_friend_request(%L::uuid)', current_setting('test.req1')),
  '55000', null,
  '4. An accepted request cannot be cancelled as a request'
);

-- Connected users get today's aggregate only: 300 + 450, not the 30-day-old 999.
select set_config('request.jwt.claims', current_setting('test.claims_b'), true);
select results_eq(
  format('select user_id, username, today_kcal, daily_target_kcal from public.get_friend_summaries(%L::date)',
         current_setting('test.today')),
  -- Since 005 the server computes daily_target_kcal (the fixture's 1800 is
  -- ignored): female, 30 y, 170 cm, 70 kg, lose, light activity -> 1496.
  $$ values ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'user_a'::text, 750::numeric, 1496) $$,
  '2. B sees A''s aggregate summary for today'
);

select set_config('request.jwt.claims', current_setting('test.claims_c'), true);
select is_empty(
  format('select * from public.get_friend_summaries(%L::date)', current_setting('test.today')),
  '10. Unconnected C gets no summaries'
);

-- ==================================================================
-- Case 11: Connected users cannot query arbitrary dates
-- ==================================================================
select set_config('request.jwt.claims', current_setting('test.claims_b'), true);
select throws_ok(
  format('select * from public.get_friend_summaries(%L::date - 30)', current_setting('test.today')),
  '22023', null,
  '11. A date 30 days back is refused'
);
select throws_ok(
  format('select * from public.get_friend_summaries(%L::date - 2)', current_setting('test.today')),
  '22023', null,
  '11. A date 2 days back is refused (outside every time zone''s today)'
);
select throws_ok(
  format('select * from public.get_friend_summaries(%L::date + 3)', current_setting('test.today')),
  '22023', null,
  '11. A future date is refused'
);
select throws_ok(
  'select * from public.get_friend_summaries(null)',
  '22023', null,
  '11. A null date is refused'
);

-- ==================================================================
-- Case 12: Connected users still cannot read individual logs or profiles
-- ==================================================================
select is_empty(
  $$ select * from public.food_logs where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  '12. Friend B cannot read A''s food_logs rows'
);
select is_empty(
  $$ select * from public.profiles where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  '12. Friend B cannot read A''s profile (age/height/weight)'
);
select is_empty(
  $$ select * from public.user_streaks where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  '12. Friend B cannot read A''s streak row directly'
);

-- ==================================================================
-- Case 3: User B declines a request
-- ==================================================================
reset role;
delete from public.friendships;

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_a'), true);
insert into public.friendships (requester_id, addressee_id)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');

reset role;
select set_config('test.req2', (select id::text from public.friendships limit 1), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_b'), true);
select lives_ok(
  format('select public.respond_to_friend_request(%L::uuid, false)', current_setting('test.req2')),
  '3. B can decline A''s request'
);

reset role;
select is(
  (select count(*)::int from public.friendships where id = current_setting('test.req2')::uuid),
  0,
  '3. Declined request is removed'
);

set local role authenticated;
select throws_ok(
  format('select public.respond_to_friend_request(%L::uuid, true)', current_setting('test.req2')),
  'P0002', null,
  '3. A declined request cannot then be accepted'
);
select is_empty(
  format('select * from public.get_friend_summaries(%L::date)', current_setting('test.today')),
  '3. Declining does not create a friendship'
);

-- ==================================================================
-- Case 4: User A cancels a pending request
-- ==================================================================
select set_config('request.jwt.claims', current_setting('test.claims_a'), true);
insert into public.friendships (requester_id, addressee_id)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');

reset role;
select set_config('test.req3', (select id::text from public.friendships limit 1), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_b'), true);
select throws_ok(
  format('select public.cancel_friend_request(%L::uuid)', current_setting('test.req3')),
  'P0002', null,
  '4. The addressee cannot use cancel (only the requester can)'
);

select set_config('request.jwt.claims', current_setting('test.claims_a'), true);
select lives_ok(
  format('select public.cancel_friend_request(%L::uuid)', current_setting('test.req3')),
  '4. A can cancel their pending request'
);

reset role;
select is(
  (select count(*)::int from public.friendships),
  0,
  '4. Cancelled request is removed and nothing else was deleted'
);

-- ==================================================================
-- Privileges and hardening
-- ==================================================================
set local role anon;
select throws_ok(
  $$ select public.respond_to_friend_request(gen_random_uuid(), true) $$,
  '42501', null,
  'anon cannot execute respond_to_friend_request'
);
select throws_ok(
  $$ select * from public.find_profile_by_username('user_a') $$,
  '42501', null,
  'anon cannot execute find_profile_by_username'
);
select throws_ok(
  $$ select * from public.friendships $$,
  '42501', null,
  'anon has no table access to friendships'
);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_a'), true);
select throws_ok(
  $$ update public.profiles set username = 'Bad Name!'
     where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  '23514', null,
  'Username format is enforced by the database'
);

reset role;
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('respond_to_friend_request', 'cancel_friend_request', 'get_friend_summaries',
                       'get_pending_requests', 'get_outgoing_requests', 'find_profile_by_username')
     and p.prosecdef
     and p.proconfig @> array['search_path=""']),
  6,
  'All six social SECURITY DEFINER functions pin search_path to empty'
);

select * from finish();
rollback;
