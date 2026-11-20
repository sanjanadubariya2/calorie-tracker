-- 011: assistant conversations, messages, tool calls, usage, preferences.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- Test-only, rolled back: switch to the role, and let it call pgTAP's functions.
grant assistant_writer to postgres;
grant usage on schema extensions to assistant_writer;

insert into auth.users (id, email) values
  ('a1100000-0000-0000-0000-0000000000a1', 'asst-a@test.local'),
  ('b1100000-0000-0000-0000-0000000000b1', 'asst-b@test.local');

-- ------------------------------------------------------------ writer creates data
set local role assistant_writer;
insert into public.assistant_conversations (id, user_id, title) values
  ('c1100000-0000-0000-0000-00000000000a', 'a1100000-0000-0000-0000-0000000000a1', 'A chat'),
  ('c1100000-0000-0000-0000-00000000000b', 'b1100000-0000-0000-0000-0000000000b1', 'B chat');
insert into public.assistant_messages (id, conversation_id, user_id, seq, role, content) values
  ('d1100000-0000-0000-0000-000000000001', 'c1100000-0000-0000-0000-00000000000a', 'a1100000-0000-0000-0000-0000000000a1', 1, 'user', 'hi'),
  ('d1100000-0000-0000-0000-000000000002', 'c1100000-0000-0000-0000-00000000000a', 'a1100000-0000-0000-0000-0000000000a1', 2, 'assistant', 'hello'),
  ('d1100000-0000-0000-0000-000000000003', 'c1100000-0000-0000-0000-00000000000b', 'b1100000-0000-0000-0000-0000000000b1', 1, 'user', 'B secret');
insert into public.assistant_tool_calls (message_id, user_id, step, tool, arguments, status)
values ('d1100000-0000-0000-0000-000000000002', 'a1100000-0000-0000-0000-0000000000a1', 0, 'get_daily_status', '{}', 'ok');

select throws_ok(
  $$ insert into public.assistant_messages (conversation_id, user_id, seq, role, content)
     values ('c1100000-0000-0000-0000-00000000000a', 'b1100000-0000-0000-0000-0000000000b1', 3, 'user', 'x') $$,
  '23503', null, 'A message can only belong to the conversation''s owner');
select throws_ok(
  $$ insert into public.assistant_messages (conversation_id, user_id, seq, role, content)
     values ('c1100000-0000-0000-0000-00000000000a', 'a1100000-0000-0000-0000-0000000000a1', 2, 'user', 'dup') $$,
  '23505', null, 'Message order (seq) is unique per conversation');
select throws_ok(
  $$ insert into public.assistant_messages (conversation_id, user_id, seq, role, content)
     values ('c1100000-0000-0000-0000-00000000000a', 'a1100000-0000-0000-0000-0000000000a1', 9, 'system', 'x') $$,
  '23514', null, 'Only user/assistant roles');
select throws_ok($$ select * from public.food_logs $$, '42501', null, 'The writer cannot read food logs');
select throws_ok($$ select * from public.profiles $$, '42501', null, 'The writer cannot read profiles');
select throws_ok($$ select * from public.user_dietary_preferences $$, '42501', null, 'The writer cannot read preferences');
select throws_ok($$ delete from public.assistant_messages $$, '42501', null, 'The writer cannot delete messages directly');

delete from public.assistant_conversations where id = 'c1100000-0000-0000-0000-00000000000b';
select is((select count(*)::int from public.assistant_conversations where id = 'c1100000-0000-0000-0000-00000000000b'), 1,
  'The writer cannot delete a live conversation');
update public.assistant_conversations set expires_at = now() - interval '1 day' where id = 'c1100000-0000-0000-0000-00000000000b';
delete from public.assistant_conversations where id = 'c1100000-0000-0000-0000-00000000000b';
select is((select count(*)::int from public.assistant_conversations where id = 'c1100000-0000-0000-0000-00000000000b'), 0,
  'The writer can purge an expired conversation');
select is((select count(*)::int from public.assistant_messages where conversation_id = 'c1100000-0000-0000-0000-00000000000b'), 0,
  'Purging removes its messages');
-- Recreate B's conversation for the isolation checks.
insert into public.assistant_conversations (id, user_id, title) values
  ('c1100000-0000-0000-0000-00000000000b', 'b1100000-0000-0000-0000-0000000000b1', 'B chat');
insert into public.assistant_messages (conversation_id, user_id, seq, role, content) values
  ('c1100000-0000-0000-0000-00000000000b', 'b1100000-0000-0000-0000-0000000000b1', 1, 'user', 'B secret');
insert into public.assistant_usage_daily (user_id, usage_date, turns, input_tokens) values
  ('a1100000-0000-0000-0000-0000000000a1', current_date, 1, 100),
  ('b1100000-0000-0000-0000-0000000000b1', current_date, 1, 999);
reset role;

-- ------------------------------------------------------------ user A
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1100000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select results_eq($$ select title from public.assistant_conversations order by title $$, $$ values ('A chat') $$,
  'A sees only their own conversations');
select results_eq($$ select seq, content from public.assistant_messages order by seq $$,
  $$ values (1, 'hi'), (2, 'hello') $$, 'A sees only their own messages, in order');
select results_eq($$ select input_tokens from public.assistant_usage_daily $$, $$ values (100::bigint) $$,
  'A sees only their own usage');
select throws_ok($$ select * from public.assistant_tool_calls $$, '42501', null, 'Clients cannot read tool records');

select throws_ok(
  $$ insert into public.assistant_messages (conversation_id, user_id, seq, role, content)
     values ('c1100000-0000-0000-0000-00000000000a', 'a1100000-0000-0000-0000-0000000000a1', 3, 'assistant', 'forged') $$,
  '42501', null, 'Clients cannot insert (forge) messages');
select throws_ok($$ update public.assistant_messages set content = 'edited' $$, '42501', null, 'Clients cannot edit messages');
select throws_ok(
  $$ insert into public.assistant_conversations (user_id) values ('a1100000-0000-0000-0000-0000000000a1') $$,
  '42501', null, 'Clients cannot create conversations directly');
select throws_ok($$ update public.assistant_conversations set input_tokens = 0 $$, '42501', null, 'Clients cannot reset token counts');
select throws_ok($$ update public.assistant_usage_daily set input_tokens = 0 $$, '42501', null, 'Clients cannot reset their budget');

delete from public.assistant_conversations where id = 'c1100000-0000-0000-0000-00000000000b';
reset role;
select is((select count(*)::int from public.assistant_conversations where id = 'c1100000-0000-0000-0000-00000000000b'), 1,
  'A cannot delete B''s conversation');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1100000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
delete from public.assistant_conversations where id = 'c1100000-0000-0000-0000-00000000000a';
reset role;
select is((select count(*)::int from public.assistant_messages where conversation_id = 'c1100000-0000-0000-0000-00000000000a'), 0,
  'Deleting a conversation deletes its messages');
select is((select count(*)::int from public.assistant_tool_calls where user_id = 'a1100000-0000-0000-0000-0000000000a1'), 0,
  '...and its tool records');

-- ------------------------------------------------------------ preferences
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1100000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select lives_ok(
  $$ insert into public.user_dietary_preferences (user_id, diet, allergies, dislikes)
     values ('a1100000-0000-0000-0000-0000000000a1', 'vegetarian', array['peanut'], array['karela']) $$,
  'A saves their own preferences');
select throws_ok(
  $$ insert into public.user_dietary_preferences (user_id, diet) values ('b1100000-0000-0000-0000-0000000000b1', 'vegan') $$,
  '42501', null, 'A cannot write B''s preferences');
select throws_ok(
  $$ update public.user_dietary_preferences set allergies = array['strawberries'] $$,
  '23514', null, 'Allergies come from the fixed list');
select throws_ok(
  $$ update public.user_dietary_preferences set dislikes = array_fill('x'::text, array[21]) $$,
  '23514', null, 'At most 20 dislikes');
select throws_ok(
  $$ update public.user_dietary_preferences set diet = 'keto-ish' $$, '23514', null, 'Diet from the fixed list');
update public.user_dietary_preferences set dislikes = array['karela', 'lauki'];
select results_eq($$ select dislikes from public.user_dietary_preferences $$, $$ values (array['karela', 'lauki']) $$,
  'A updates preferences');
delete from public.user_dietary_preferences;
select is_empty($$ select 1 from public.user_dietary_preferences $$, 'A deletes preferences');
reset role;

-- ------------------------------------------------------------ anon
set local role anon;
select throws_ok($$ select * from public.assistant_conversations $$, '42501', null, 'anon: no conversations');
select throws_ok($$ select * from public.user_dietary_preferences $$, '42501', null, 'anon: no preferences');
reset role;

select * from finish();
rollback;
