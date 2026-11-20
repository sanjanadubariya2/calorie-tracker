-- 012: assistant proposals are readable by their owner only and writable only by the backend writer.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

grant assistant_writer to postgres;
grant usage on schema extensions to assistant_writer;

insert into auth.users (id, email) values
  ('a1200000-0000-0000-0000-0000000000a1', 'prop-a@test.local'),
  ('b1200000-0000-0000-0000-0000000000b1', 'prop-b@test.local');

set local role assistant_writer;
insert into public.assistant_conversations (id, user_id) values
  ('c1200000-0000-0000-0000-00000000000a', 'a1200000-0000-0000-0000-0000000000a1'),
  ('c1200000-0000-0000-0000-00000000000b', 'b1200000-0000-0000-0000-0000000000b1');
insert into public.assistant_proposals (id, user_id, conversation_id, payload, expires_at) values
  ('e1200000-0000-0000-0000-00000000000a', 'a1200000-0000-0000-0000-0000000000a1', 'c1200000-0000-0000-0000-00000000000a',
   '{"items": []}', now() + interval '30 minutes'),
  ('e1200000-0000-0000-0000-00000000000b', 'b1200000-0000-0000-0000-0000000000b1', 'c1200000-0000-0000-0000-00000000000b',
   '{"items": []}', now() + interval '30 minutes');
select throws_ok(
  $$ insert into public.assistant_proposals (user_id, conversation_id, payload, expires_at)
     values ('b1200000-0000-0000-0000-0000000000b1', 'c1200000-0000-0000-0000-00000000000a', '{}', now() + interval '1 hour') $$,
  '23503', null, 'A proposal belongs to the conversation''s owner');
select throws_ok(
  $$ update public.assistant_proposals set status = 'done' $$, '23514', null, 'Only known statuses');
select throws_ok($$ select * from public.food_logs $$, '42501', null, 'The writer still cannot touch food logs');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a1200000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select results_eq($$ select id from public.assistant_proposals $$,
  $$ values ('e1200000-0000-0000-0000-00000000000a'::uuid) $$, 'Users see only their own proposals');
select throws_ok($$ update public.assistant_proposals set status = 'confirmed' $$, '42501', null,
  'Users cannot confirm a proposal by writing to the table');
select throws_ok(
  $$ insert into public.assistant_proposals (user_id, conversation_id, payload, expires_at)
     values ('a1200000-0000-0000-0000-0000000000a1', 'c1200000-0000-0000-0000-00000000000a', '{}', now() + interval '1 hour') $$,
  '42501', null, 'Users cannot create proposals');
delete from public.assistant_conversations where id = 'c1200000-0000-0000-0000-00000000000a';
reset role;
select is((select count(*)::int from public.assistant_proposals where user_id = 'a1200000-0000-0000-0000-0000000000a1'), 0,
  'Deleting the conversation deletes its proposals');

set local role anon;
select throws_ok($$ select * from public.assistant_proposals $$, '42501', null, 'anon: no proposals');
reset role;

select * from finish();
rollback;
