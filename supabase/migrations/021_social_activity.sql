-- Migration 021: social foundation (sharing settings, blocks) and activity feed
-- (Phase 4, Tasks 1-2).
--
--   social_settings   what a user shares with friends. Everything is OFF until
--                     the user opts in (share_activity is the master switch).
--   user_blocks       a block hides each user from the other: no requests, no
--                     feed, no lookups; blocking also removes the friendship.
--   activity_events   milestones and challenge events. Written only by the
--                     database (triggers / SECURITY DEFINER functions). Payloads
--                     carry only whitelisted, non-health fields: never food,
--                     calories, macros, weight or targets.
--   get_activity_feed the ONLY way to read someone else's events. Visibility is
--                     decided at read time, so changing a setting, unfriending
--                     or blocking takes effect immediately for past events too.
--
-- Rollback (local): drop the functions/triggers below, the three tables, and
-- restore 003's friendships insert policy and find_profile_by_username.

begin;

-- ============================================================
-- 1. Sharing settings
-- ============================================================
create table if not exists public.social_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  share_activity boolean not null default false,        -- master switch for the friends' feed
  share_streaks boolean not null default true,          -- per kind; only matters when share_activity
  share_habits boolean not null default true,
  share_achievements boolean not null default true,
  share_challenges boolean not null default true,
  updated_at timestamptz not null default now()
);

create or replace function public.social_settings_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists social_settings_touch on public.social_settings;
create trigger social_settings_touch before insert or update on public.social_settings
  for each row execute function public.social_settings_touch();

alter table public.social_settings enable row level security;
revoke all on table public.social_settings from anon, authenticated;
-- user_id always comes from its auth.uid() default: clients can't even name it.
grant select, delete on table public.social_settings to authenticated;
grant insert (share_activity, share_streaks, share_habits, share_achievements, share_challenges),
      update (share_activity, share_streaks, share_habits, share_achievements, share_challenges)
  on table public.social_settings to authenticated;
drop policy if exists "Users manage their sharing settings" on public.social_settings;
create policy "Users manage their sharing settings" on public.social_settings
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ============================================================
-- 2. Blocks
-- ============================================================
create table if not exists public.user_blocks (
  blocker_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id);

alter table public.user_blocks enable row level security;
revoke all on table public.user_blocks from anon, authenticated;
grant select, delete on table public.user_blocks to authenticated;      -- create via block_user()
drop policy if exists "Users see and remove their own blocks" on public.user_blocks;
create policy "Users see and remove their own blocks" on public.user_blocks
  for all to authenticated using (blocker_id = (select auth.uid()));

-- Is there a block either way between the caller and p_other? (Only ever about the caller.)
create or replace function public.is_blocked_with(p_other uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = p_other)
       or (b.blocker_id = p_other and b.blocked_id = auth.uid()));
$$;

-- Internal: a block between two given users.
create or replace function public.blocked_between(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b) or (b.blocker_id = p_b and b.blocked_id = p_a));
$$;

create or replace function public.block_user(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_user_id is null or p_user_id = v_uid or not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'Invalid user' using errcode = '22023';
  end if;
  insert into public.user_blocks (blocker_id, blocked_id) values (v_uid, p_user_id) on conflict do nothing;
  -- A block ends the friendship and any pending request, in either direction.
  delete from public.friendships f
  where (f.requester_id = v_uid and f.addressee_id = p_user_id)
     or (f.requester_id = p_user_id and f.addressee_id = v_uid);
end;
$$;

create or replace function public.unblock_user(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  delete from public.user_blocks b where b.blocker_id = auth.uid() and b.blocked_id = p_user_id;
end;
$$;

-- Usernames of the people I blocked (profiles are owner-only, so via a function).
create or replace function public.get_blocked_users()
returns table (user_id uuid, username text, avatar_url text, blocked_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select b.blocked_id, p.username, p.avatar_url, b.created_at
  from public.user_blocks b
  left join public.profiles p on p.user_id = b.blocked_id
  where b.blocker_id = auth.uid()
  order by b.created_at desc;
$$;

-- Friend requests can't be sent across a block (either way).
drop policy if exists "Users can send friend requests" on public.friendships;
create policy "Users can send friend requests"
  on public.friendships for insert
  to authenticated
  with check (
    (select auth.uid()) = requester_id
    and status = 'pending'
    and requester_id <> addressee_id
    and not public.is_blocked_with(addressee_id)
  );

-- Lookup never finds someone across a block.
create or replace function public.find_profile_by_username(p_username text)
returns table (user_id uuid, username text, avatar_url text)
language sql stable security definer set search_path = '' as $$
  select p.user_id, p.username, p.avatar_url
  from public.profiles p
  where lower(p.username) = lower(trim(p_username))
    and p.user_id <> auth.uid()
    and not public.blocked_between(auth.uid(), p.user_id)
  limit 1;
$$;

-- ============================================================
-- 3. Activity events
-- ============================================================
-- Payload keys allowed per event. Nothing here can carry food, calories,
-- macros, weight or targets.
create or replace function public.activity_payload_ok(p_kind text, p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object'
     and pg_column_size(p) <= 1024
     and not exists (
       select 1 from jsonb_object_keys(p) k
       where k not in (case p_kind
         when 'streak_milestone' then 'days'
         when 'habit_milestone' then 'days'
         else '' end,
         case p_kind when 'achievement' then 'code' else '' end,
         case p_kind when 'achievement' then 'title' else '' end,
         case when p_kind in ('challenge_joined', 'challenge_completed') then 'challenge_id' else '' end,
         case when p_kind in ('challenge_joined', 'challenge_completed') then 'title' else '' end,
         case when p_kind in ('challenge_joined', 'challenge_completed') then 'target_days' else '' end));
$$;

create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('streak_milestone', 'habit_milestone', 'achievement',
                                     'challenge_joined', 'challenge_completed')),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 120),
  payload jsonb not null default '{}' check (public.activity_payload_ok(kind, payload)),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '180 days',
  unique (actor_id, kind, dedupe_key)            -- each milestone is announced once
);
create index if not exists activity_events_actor_time_idx
  on public.activity_events (actor_id, created_at desc, id desc);

alter table public.activity_events enable row level security;
revoke all on table public.activity_events from anon, authenticated;
grant select on table public.activity_events to authenticated;          -- own rows only; others via the feed
drop policy if exists "Users see their own activity" on public.activity_events;
create policy "Users see their own activity" on public.activity_events
  for select to authenticated using (actor_id = (select auth.uid()));

-- Internal writer: idempotent (a repeated milestone is a no-op).
create or replace function public.record_activity(p_actor uuid, p_kind text, p_key text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_actor is null or not exists (select 1 from auth.users u where u.id = p_actor) then
    return;                      -- e.g. during account deletion cascades
  end if;
  insert into public.activity_events (actor_id, kind, dedupe_key, payload)
  values (p_actor, p_kind, p_key, coalesce(p_payload, '{}'))
  on conflict (actor_id, kind, dedupe_key) do nothing;
end;
$$;

-- Streak milestones: announced when badges_earned (a high-water mark) rises.
create or replace function public.user_streaks_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old int := case when tg_op = 'UPDATE' then coalesce(old.badges_earned, 0) else 0 end;
  v_milestones int[] := array[3, 7, 14, 30, 60, 100, 180, 365];
  i int;
begin
  if coalesce(new.badges_earned, 0) > v_old then
    for i in v_old + 1 .. least(new.badges_earned, array_length(v_milestones, 1)) loop
      perform public.record_activity(new.user_id, 'streak_milestone', 'streak:' || v_milestones[i],
                                     jsonb_build_object('days', v_milestones[i]));
    end loop;
  end if;
  return null;
end;
$$;
drop trigger if exists user_streaks_activity on public.user_streaks;
create trigger user_streaks_activity after insert or update of badges_earned on public.user_streaks
  for each row execute function public.user_streaks_activity();

-- Habit milestones: total days with at least one log (7, 30, 50, 100, 200, 365).
-- Only milestones crossed by this statement are announced, so existing history
-- doesn't flood the feed. Achievements (e.g. the first meal) are awarded by
-- evaluate_achievements in 024.
create or replace function public.food_logs_habit_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_now int;
  v_before int;
  m int;
begin
  for r in select distinct n.user_id from new_rows n order by 1 loop
    select count(distinct l.logged_date) into v_now
    from public.food_logs l
    where l.user_id = r.user_id
      and l.logged_date <= (select b.today_max from public.user_today_bounds(r.user_id) b);
    -- Days that exist only because of this statement's rows.
    select v_now - count(*) into v_before
    from (select distinct n.logged_date from new_rows n where n.user_id = r.user_id) d
    where not exists (
      select 1 from public.food_logs l
      where l.user_id = r.user_id and l.logged_date = d.logged_date
        and l.id not in (select n2.id from new_rows n2));
    foreach m in array array[7, 30, 50, 100, 200, 365] loop
      if v_before < m and v_now >= m then
        perform public.record_activity(r.user_id, 'habit_milestone', 'logged_days:' || m,
                                       jsonb_build_object('days', m));
      end if;
    end loop;
  end loop;
  return null;
end;
$$;
drop trigger if exists food_logs_habit_activity on public.food_logs;
create trigger food_logs_habit_activity after insert on public.food_logs
  referencing new table as new_rows
  for each statement execute function public.food_logs_habit_activity();

-- ============================================================
-- 4. The feed
-- ============================================================
-- The caller's own events plus events of accepted friends who share that kind,
-- with no block either way. Keyset pagination on (created_at, id).
create or replace function public.get_activity_feed(
  p_before_at timestamptz default null, p_before_id uuid default null, p_limit int default 20)
returns table (id uuid, actor_id uuid, actor_username text, actor_avatar_url text, is_me boolean,
               kind text, payload jsonb, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_actors uuid[];
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_before_id is not null and p_before_at is null then
    raise exception 'p_before_at is required with p_before_id' using errcode = '22023';
  end if;

  select array_agg(x.fid) into v_actors
  from (
    select case when f.requester_id = v_uid then f.addressee_id else f.requester_id end as fid
    from public.friendships f
    where f.status = 'accepted' and (f.requester_id = v_uid or f.addressee_id = v_uid)
  ) x
  join public.social_settings s on s.user_id = x.fid and s.share_activity
  where not public.blocked_between(v_uid, x.fid);

  return query
  select e.id, e.actor_id, p.username, p.avatar_url, e.actor_id = v_uid, e.kind, e.payload, e.created_at
  from public.activity_events e
  left join public.profiles p on p.user_id = e.actor_id
  left join public.social_settings s on s.user_id = e.actor_id
  where (e.actor_id = v_uid
         or (e.actor_id = any(coalesce(v_actors, '{}'::uuid[]))
             and case e.kind
                   when 'streak_milestone' then s.share_streaks
                   when 'habit_milestone' then s.share_habits
                   when 'achievement' then s.share_achievements
                   else s.share_challenges
                 end))
    and e.expires_at > now()
    and (p_before_at is null
         or (e.created_at, e.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
  order by e.created_at desc, e.id desc
  limit v_limit;
end;
$$;

-- Retention: the assistant_writer purge role may delete expired events.
drop policy if exists "assistant_writer purges expired activity" on public.activity_events;
create policy "assistant_writer purges expired activity" on public.activity_events
  for delete to assistant_writer using (expires_at < now());
grant select, delete on table public.activity_events to assistant_writer;

-- ============================================================
-- 5. Privileges
-- ============================================================
revoke all on function public.social_settings_touch() from public, anon, authenticated;
revoke all on function public.is_blocked_with(uuid) from public, anon;
revoke all on function public.blocked_between(uuid, uuid) from public, anon, authenticated;
revoke all on function public.block_user(uuid) from public, anon;
revoke all on function public.unblock_user(uuid) from public, anon;
revoke all on function public.get_blocked_users() from public, anon;
revoke all on function public.find_profile_by_username(text) from public, anon;
revoke all on function public.activity_payload_ok(text, jsonb) from public, anon;
revoke all on function public.record_activity(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.user_streaks_activity() from public, anon, authenticated;
revoke all on function public.food_logs_habit_activity() from public, anon, authenticated;
revoke all on function public.get_activity_feed(timestamptz, uuid, int) from public, anon;

grant execute on function public.is_blocked_with(uuid) to authenticated;       -- used by the requests policy
grant execute on function public.block_user(uuid) to authenticated;
grant execute on function public.unblock_user(uuid) to authenticated;
grant execute on function public.get_blocked_users() to authenticated;
grant execute on function public.find_profile_by_username(text) to authenticated;
grant execute on function public.activity_payload_ok(text, jsonb) to authenticated;
grant execute on function public.get_activity_feed(timestamptz, uuid, int) to authenticated;

commit;
