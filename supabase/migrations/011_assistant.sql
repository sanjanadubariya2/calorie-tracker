-- Calorie Tracker — AI nutrition assistant: conversations, preferences, usage
-- Run after 010_food_portion.sql. Safe to re-run.
--
-- Ownership model
--   * Users READ their own conversations/messages and DELETE their own
--     conversations (messages and tool records go with them). They can't
--     insert or edit messages: history is fed back to the model, so clients
--     must not be able to forge assistant or tool turns, or their usage.
--   * The backend writes conversation data as `assistant_writer`, always with
--     the user id taken from the verified access token. That role can't read
--     or write any other table, and can only delete EXPIRED conversations.
--   * Dietary preferences are entered by the user (own row, full access).
--     The assistant never writes them.
--
-- Older projects grant ALL on new public tables to anon/authenticated by
-- default; every grant here is therefore explicit, after a revoke.
--
-- assistant_writer is created WITHOUT a password; set one outside version
-- control:  alter role assistant_writer password '<generated secret>';
-- Connect through the pooler as  assistant_writer.<project-ref>.

begin;

-- ============================================================
-- 1. Conversations
-- ============================================================
create table if not exists public.assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text check (title is null or char_length(title) between 1 and 120),
  -- One running turn per conversation; a lock older than 2 minutes is stale.
  turn_status text not null default 'idle' check (turn_status in ('idle', 'running')),
  turn_started_at timestamptz,
  last_seq int not null default 0 check (last_seq >= 0),
  message_count int not null default 0 check (message_count >= 0),
  -- Rolling summary of older messages: {summary, key_facts[], open_questions[]}.
  summary jsonb check (summary is null or (jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 16384)),
  summary_through_seq int not null default 0 check (summary_through_seq >= 0),
  summary_updated_at timestamptz,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  estimated_cost_usd numeric(14, 6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Retention: 90 days after the last activity (extended by the backend).
  expires_at timestamptz not null default now() + interval '90 days',
  unique (id, user_id)
);

create index if not exists assistant_conversations_user_updated_idx
  on public.assistant_conversations (user_id, updated_at desc);
create index if not exists assistant_conversations_expires_idx
  on public.assistant_conversations (expires_at);

-- ============================================================
-- 2. Messages (ordered by seq, never by timestamp)
-- ============================================================
create table if not exists public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null,
  seq int not null check (seq > 0),
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 8000),
  -- Assistant messages: the validated structured response (server-built).
  response jsonb check (response is null or (jsonb_typeof(response) = 'object' and pg_column_size(response) <= 65536)),
  outcome text check (outcome in ('complete', 'clarification', 'error', 'refused', 'step_limit', 'budget_exceeded')),
  client_message_id uuid,
  model text check (model is null or char_length(model) <= 80),
  input_tokens int check (input_tokens is null or input_tokens >= 0),
  output_tokens int check (output_tokens is null or output_tokens >= 0),
  thinking_tokens int check (thinking_tokens is null or thinking_tokens >= 0),
  estimated_cost_usd numeric(14, 6),
  correlation_id text check (correlation_id is null or char_length(correlation_id) <= 64),
  created_at timestamptz not null default now(),
  -- The message's owner is always the conversation's owner.
  foreign key (conversation_id, user_id)
    references public.assistant_conversations (id, user_id) on delete cascade,
  unique (conversation_id, seq),
  unique (conversation_id, client_message_id)
);

-- ============================================================
-- 3. Tool executions (audit/debugging; never exposed to clients)
--    Arguments only, never result payloads.
-- ============================================================
create table if not exists public.assistant_tool_calls (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.assistant_messages(id) on delete cascade,
  user_id uuid not null,
  step smallint not null check (step between 0 and 50),
  tool text not null check (char_length(tool) between 1 and 64),
  arguments jsonb not null check (pg_column_size(arguments) <= 4096),
  status text not null check (status in ('ok', 'invalid_arguments', 'error', 'timeout', 'unknown_tool', 'limit_exceeded')),
  result_chars int check (result_chars is null or result_chars >= 0),
  duration_ms int check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now()
);
create index if not exists assistant_tool_calls_message_idx on public.assistant_tool_calls (message_id);

-- ============================================================
-- 4. Daily usage per user (durable budget; no Redis)
-- ============================================================
create table if not exists public.assistant_usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  turns int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  estimated_cost_usd numeric(14, 6) not null default 0,
  primary key (user_id, usage_date)
);

-- ============================================================
-- 5. Dietary preferences (user-entered only)
-- ============================================================
create or replace function public.is_valid_text_list(p_items text[], p_max_items int, p_max_len int)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_items is not null
     and coalesce(array_length(p_items, 1), 0) <= p_max_items
     and not exists (
       select 1 from unnest(p_items) as x(item)
       where item is null or char_length(btrim(item)) = 0 or char_length(item) > p_max_len
     );
$$;

create table if not exists public.user_dietary_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  diet text check (diet in ('omnivore', 'eggetarian', 'vegetarian', 'vegan', 'pescatarian', 'jain')),
  -- Only allergies the user stated explicitly, from a fixed list.
  allergies text[] not null default '{}' check (
    allergies <@ array['peanut', 'tree_nut', 'milk', 'egg', 'wheat_gluten', 'soy', 'fish', 'shellfish', 'sesame', 'mustard']::text[]
    and public.is_valid_text_list(allergies, 10, 20)),
  dislikes text[] not null default '{}' check (public.is_valid_text_list(dislikes, 20, 40)),
  cuisines text[] not null default '{}' check (public.is_valid_text_list(cuisines, 10, 40)),
  meal_preferences text[] not null default '{}' check (public.is_valid_text_list(meal_preferences, 10, 80)),
  notes text check (notes is null or char_length(notes) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.user_dietary_preferences_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_dietary_preferences_touch on public.user_dietary_preferences;
create trigger user_dietary_preferences_touch
  before update on public.user_dietary_preferences
  for each row execute function public.user_dietary_preferences_touch();

revoke all on function public.user_dietary_preferences_touch() from public, anon, authenticated;

-- ============================================================
-- 6. RLS and privileges for app users
-- ============================================================
alter table public.assistant_conversations enable row level security;
alter table public.assistant_messages enable row level security;
alter table public.assistant_tool_calls enable row level security;
alter table public.assistant_usage_daily enable row level security;
alter table public.user_dietary_preferences enable row level security;

revoke all on table public.assistant_conversations, public.assistant_messages, public.assistant_tool_calls,
  public.assistant_usage_daily, public.user_dietary_preferences from anon, authenticated;

grant select, delete on table public.assistant_conversations to authenticated;
grant select on table public.assistant_messages to authenticated;
grant select on table public.assistant_usage_daily to authenticated;
grant select, insert, update, delete on table public.user_dietary_preferences to authenticated;
-- assistant_tool_calls: no client access at all.

drop policy if exists "Users read their own conversations" on public.assistant_conversations;
create policy "Users read their own conversations" on public.assistant_conversations
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "Users delete their own conversations" on public.assistant_conversations;
create policy "Users delete their own conversations" on public.assistant_conversations
  for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Users read their own messages" on public.assistant_messages;
create policy "Users read their own messages" on public.assistant_messages
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Users read their own assistant usage" on public.assistant_usage_daily;
create policy "Users read their own assistant usage" on public.assistant_usage_daily
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Users manage their own dietary preferences" on public.user_dietary_preferences;
create policy "Users manage their own dietary preferences" on public.user_dietary_preferences
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ============================================================
-- 7. assistant_writer: the backend's only write path for conversations
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'assistant_writer') then
    create role assistant_writer login noinherit connection limit 10;
  end if;
end;
$$;

grant usage on schema public to assistant_writer;
grant select, insert, update on table public.assistant_conversations, public.assistant_messages,
  public.assistant_tool_calls, public.assistant_usage_daily to assistant_writer;
grant delete on table public.assistant_conversations to assistant_writer;

drop policy if exists "assistant_writer manages conversations" on public.assistant_conversations;
drop policy if exists "assistant_writer reads conversations" on public.assistant_conversations;
create policy "assistant_writer reads conversations" on public.assistant_conversations
  for select to assistant_writer using (true);
drop policy if exists "assistant_writer creates conversations" on public.assistant_conversations;
create policy "assistant_writer creates conversations" on public.assistant_conversations
  for insert to assistant_writer with check (true);
drop policy if exists "assistant_writer updates conversations" on public.assistant_conversations;
create policy "assistant_writer updates conversations" on public.assistant_conversations
  for update to assistant_writer using (true) with check (true);
-- Retention purge only: the writer can't delete a live conversation.
drop policy if exists "assistant_writer purges expired conversations" on public.assistant_conversations;
create policy "assistant_writer purges expired conversations" on public.assistant_conversations
  for delete to assistant_writer using (expires_at < now());

drop policy if exists "assistant_writer manages messages" on public.assistant_messages;
create policy "assistant_writer manages messages" on public.assistant_messages
  for all to assistant_writer using (true) with check (true);
drop policy if exists "assistant_writer manages tool calls" on public.assistant_tool_calls;
create policy "assistant_writer manages tool calls" on public.assistant_tool_calls
  for all to assistant_writer using (true) with check (true);
drop policy if exists "assistant_writer manages usage" on public.assistant_usage_daily;
create policy "assistant_writer manages usage" on public.assistant_usage_daily
  for all to assistant_writer using (true) with check (true);
drop policy if exists "assistant_writer reads preferences" on public.user_dietary_preferences;

revoke all on function public.is_valid_text_list(text[], int, int) from public, anon;
grant execute on function public.is_valid_text_list(text[], int, int) to authenticated;

commit;

-- Rollback (manual):
--   drop table public.assistant_tool_calls, public.assistant_messages,
--     public.assistant_conversations, public.assistant_usage_daily,
--     public.user_dietary_preferences;
--   drop function public.is_valid_text_list(text[], int, int);
--   drop function public.user_dietary_preferences_touch();
--   drop role assistant_writer;
