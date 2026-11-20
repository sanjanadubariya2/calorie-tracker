-- Calorie Tracker — assistant action proposals (food-log proposals)
-- Run after 011_assistant.sql. Safe to re-run.
--
-- The assistant can only PROPOSE a food log. A proposal is created by the
-- backend (assistant_writer) for the verified user, priced from the catalogue,
-- and expires. Only an explicit confirmation from the app (an authenticated
-- HTTP call, not a chat message) turns it into food_logs rows, which are
-- inserted AS THE USER through the normal path (RLS + the nutrition snapshot
-- and streak triggers).
--
-- Status lifecycle (writer only; one-way except confirming -> pending when the
-- save fails):
--   pending -> confirming -> confirmed
--   pending -> rejected | expired
--   confirming -> pending          (save failed; the user may retry)

begin;

create table if not exists public.assistant_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  conversation_id uuid not null,
  kind text not null default 'log_food' check (kind in ('log_food')),
  status text not null default 'pending'
    check (status in ('pending', 'confirming', 'confirmed', 'rejected', 'expired')),
  -- What was proposed: items (catalogue food id, grams, nutrition), meal type, date.
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 32768),
  -- Rows created on confirmation.
  food_log_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status_changed_at timestamptz not null default now(),
  foreign key (conversation_id, user_id)
    references public.assistant_conversations (id, user_id) on delete cascade,
  check (expires_at > created_at)
);

create index if not exists assistant_proposals_user_idx on public.assistant_proposals (user_id, created_at desc);
create index if not exists assistant_proposals_conversation_idx on public.assistant_proposals (conversation_id);

alter table public.assistant_proposals enable row level security;
revoke all on table public.assistant_proposals from anon, authenticated;
grant select on table public.assistant_proposals to authenticated;

drop policy if exists "Users read their own proposals" on public.assistant_proposals;
create policy "Users read their own proposals" on public.assistant_proposals
  for select to authenticated using (user_id = (select auth.uid()));

grant select, insert, update on table public.assistant_proposals to assistant_writer;
drop policy if exists "assistant_writer manages proposals" on public.assistant_proposals;
create policy "assistant_writer manages proposals" on public.assistant_proposals
  for all to assistant_writer using (true) with check (true);

commit;

-- Rollback (manual): drop table public.assistant_proposals;
