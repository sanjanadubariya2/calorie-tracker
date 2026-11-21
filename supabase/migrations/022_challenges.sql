-- Migration 022: wellness challenges (Phase 4, Task 3).
--
-- Only habits the app can measure, or that the user explicitly checks in:
--   logs        counted by the server from food_logs dates (any log, breakfast,
--               all three main meals). Never amounts: no calorie, deficit or
--               weight goals exist here.
--   checkin     self-reported once per day (water, a walk, bedtime, being
--               active), shown as self-reported. Check-ins are accepted only for
--               the participant, only for today or yesterday in their local
--               calendar, and only inside the challenge dates.
-- Targets always leave rest days (e.g. 5 of 7), templates are curated and
-- fixed, and participants are listed alphabetically, never ranked.
--
-- Progress is computed by the database only (clients cannot write it). A
-- participant completes at most once: active -> completed under a row lock,
-- and the feed event is idempotent. Logs created more than a day after a
-- challenge ended never count (no backfilling a finished challenge).
--
-- Rollback (local): drop the functions/triggers below and the four tables.

begin;

-- ============================================================
-- 1. Templates (curated)
-- ============================================================
create table if not exists public.challenge_templates (
  code text primary key check (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(code) <= 40),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  description text not null check (char_length(description) <= 300),
  metric text not null check (metric in ('logged_days', 'breakfast_days', 'main_meals_days', 'checkin_days')),
  cadence text not null check (cadence in ('daily', 'weekly')),
  duration_days int not null check (duration_days between 1 and 14),
  target_days int not null check (target_days >= 1),
  checkin_label text check (checkin_label is null or char_length(checkin_label) <= 80),
  safety_note text check (safety_note is null or char_length(safety_note) <= 200),
  app_featured boolean not null default false,       -- offered as an open weekly app challenge
  sort smallint not null default 100,
  active boolean not null default true,
  check (target_days <= duration_days),
  check ((cadence = 'daily') = (duration_days = 1)),
  check ((metric = 'checkin_days') = (checkin_label is not null))
);

insert into public.challenge_templates
  (code, title, description, metric, cadence, duration_days, target_days, checkin_label, safety_note, app_featured, sort)
values
  ('log-today', 'Log a meal today', 'Log at least one meal or snack today.', 'logged_days', 'daily', 1, 1, null, null, false, 10),
  ('breakfast-today', 'Log your breakfast today', 'Log a breakfast today, whatever it is.', 'breakfast_days', 'daily', 1, 1, null, null, false, 20),
  ('three-meals-today', 'Log breakfast, lunch and dinner', 'Log all three main meals today.', 'main_meals_days', 'daily', 1, 1, null, null, false, 30),
  ('walk-today', 'Take a walk today', 'A comfortable walk of about 20 minutes, at your own pace.', 'checkin_days', 'daily', 1, 1,
   'I took a walk today', 'Go at a comfortable pace. Skip it if you are unwell.', false, 40),
  ('log-5-days', 'Log meals on 5 days', 'Log at least one meal on 5 of the next 7 days.', 'logged_days', 'weekly', 7, 5, null,
   'Two days off are built in.', true, 50),
  ('breakfast-5-days', 'Log breakfast on 5 days', 'Log a breakfast on 5 of the next 7 days.', 'breakfast_days', 'weekly', 7, 5, null,
   'Two days off are built in.', true, 60),
  ('three-meals-4-days', 'Log all main meals on 4 days', 'Log breakfast, lunch and dinner on 4 of the next 7 days.',
   'main_meals_days', 'weekly', 7, 4, null, 'Three days off are built in.', false, 70),
  ('water-5-days', 'Drink water regularly', 'Sip water through the day on 5 of the next 7 days.', 'checkin_days', 'weekly', 7, 5,
   'I drank water regularly today', 'Drink to thirst; there is no need to force large amounts.', true, 80),
  ('walk-5-days', 'Walk on 5 days', 'A comfortable walk of about 20 minutes on 5 of the next 7 days.', 'checkin_days', 'weekly', 7, 5,
   'I took a walk today', 'Go at a comfortable pace. Rest days are part of the plan.', false, 90),
  ('bedtime-5-days', 'Keep a consistent bedtime', 'Go to bed at about the same time on 5 of the next 7 nights.', 'checkin_days',
   'weekly', 7, 5, 'I kept my usual bedtime', null, false, 100),
  ('active-3-days', 'Be active on 3 days', 'Any activity you enjoy on 3 days this week.', 'checkin_days', 'weekly', 7, 3,
   'I was active today', 'Choose what feels good. Four rest days are built in.', false, 110)
on conflict (code) do nothing;

alter table public.challenge_templates enable row level security;
revoke all on table public.challenge_templates from anon, authenticated;
grant select on table public.challenge_templates to authenticated;
drop policy if exists "Signed-in users read active templates" on public.challenge_templates;
create policy "Signed-in users read active templates" on public.challenge_templates
  for select to authenticated using (active);

-- ============================================================
-- 2. Challenges, participants, check-ins
-- ============================================================
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  template_code text not null references public.challenge_templates(code),
  kind text not null check (kind in ('individual', 'group', 'app')),
  creator_id uuid references auth.users(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  check ((kind = 'app') = (creator_id is null)),
  check (ends_on >= starts_on and ends_on - starts_on <= 13)
);
create unique index if not exists challenges_app_week_key on public.challenges (template_code, starts_on) where kind = 'app';
create index if not exists challenges_creator_idx on public.challenges (creator_id) where creator_id is not null;

create table if not exists public.challenge_participants (
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('invited', 'active', 'completed', 'left', 'declined')),
  invited_by uuid references auth.users(id) on delete set null,
  joined_at timestamptz,
  completed_at timestamptz,
  left_at timestamptz,
  progress_days int not null default 0 check (progress_days >= 0),
  progress_updated_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (challenge_id, user_id),                     -- one participation per user per challenge
  check ((status = 'completed') = (completed_at is not null))
);
create index if not exists challenge_participants_user_idx on public.challenge_participants (user_id, status);

create table if not exists public.challenge_checkins (
  challenge_id uuid not null,
  user_id uuid not null,
  day date not null,
  created_at timestamptz not null default now(),
  primary key (challenge_id, user_id, day),                -- at most one check-in per day
  foreign key (challenge_id, user_id) references public.challenge_participants (challenge_id, user_id) on delete cascade
);

alter table public.challenges enable row level security;
alter table public.challenge_participants enable row level security;
alter table public.challenge_checkins enable row level security;
revoke all on table public.challenges, public.challenge_participants, public.challenge_checkins from anon, authenticated;
-- Read-only for clients; every write goes through the functions below.
grant select on table public.challenges, public.challenge_participants, public.challenge_checkins to authenticated;

-- Membership check without RLS recursion.
create or replace function public.is_challenge_member(p_challenge uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.challenge_participants cp
                 where cp.challenge_id = p_challenge and cp.user_id = auth.uid());
$$;

drop policy if exists "See open app challenges and your own" on public.challenges;
create policy "See open app challenges and your own" on public.challenges
  for select to authenticated using (kind = 'app' or public.is_challenge_member(id));
drop policy if exists "See your own participation" on public.challenge_participants;
create policy "See your own participation" on public.challenge_participants
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "See your own check-ins" on public.challenge_checkins;
create policy "See your own check-ins" on public.challenge_checkins
  for select to authenticated using (user_id = (select auth.uid()));

-- ============================================================
-- 3. Progress (server-side only)
-- ============================================================
-- Qualifying days for one participant, inside the challenge dates, never past
-- the participant's own today. Logs created more than a day after the end of
-- the challenge are ignored, so a finished challenge can't be backfilled.
create or replace function public.challenge_progress_days(p_challenge uuid, p_user uuid)
returns int language plpgsql stable security definer set search_path = '' as $$
declare
  c record;
  v_end date;
  v_cutoff timestamptz;
  v_days int;
begin
  select ch.starts_on, ch.ends_on, t.metric into c
  from public.challenges ch join public.challenge_templates t on t.code = ch.template_code
  where ch.id = p_challenge;
  if not found then
    return 0;
  end if;
  v_end := least(c.ends_on, (select b.today_max from public.user_today_bounds(p_user) b));
  if v_end < c.starts_on then
    return 0;
  end if;
  v_cutoff := (c.ends_on + 2)::timestamptz;      -- end of the day after, in any time zone (UTC+14 slack)
  if c.metric = 'logged_days' then
    select count(distinct l.logged_date) into v_days from public.food_logs l
    where l.user_id = p_user and l.logged_date between c.starts_on and v_end and l.created_at < v_cutoff;
  elsif c.metric = 'breakfast_days' then
    select count(distinct l.logged_date) into v_days from public.food_logs l
    where l.user_id = p_user and l.meal_type = 'breakfast' and l.logged_date between c.starts_on and v_end
      and l.created_at < v_cutoff;
  elsif c.metric = 'main_meals_days' then
    select count(*) into v_days from (
      select l.logged_date from public.food_logs l
      where l.user_id = p_user and l.meal_type in ('breakfast', 'lunch', 'dinner')
        and l.logged_date between c.starts_on and v_end and l.created_at < v_cutoff
      group by l.logged_date having count(distinct l.meal_type) = 3) d;
  else
    select count(*) into v_days from public.challenge_checkins k
    where k.challenge_id = p_challenge and k.user_id = p_user and k.day between c.starts_on and v_end;
  end if;
  return coalesce(v_days, 0);
end;
$$;

-- Recomputes one participant and completes them at most once. Only an
-- 'active' participant changes; the transition is made under a row lock.
create or replace function public.refresh_challenge_participant(p_challenge uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  p record;
  v_days int;
  v_target int;
  v_title text;
begin
  select cp.status into p from public.challenge_participants cp
  where cp.challenge_id = p_challenge and cp.user_id = p_user
  for update;
  if not found or p.status <> 'active' then
    return;
  end if;
  v_days := public.challenge_progress_days(p_challenge, p_user);
  select t.target_days, t.title into v_target, v_title
  from public.challenges ch join public.challenge_templates t on t.code = ch.template_code where ch.id = p_challenge;
  if v_days >= v_target then
    update public.challenge_participants
    set progress_days = v_days, progress_updated_at = now(), status = 'completed', completed_at = now()
    where challenge_id = p_challenge and user_id = p_user and status = 'active';
    perform public.record_activity(p_user, 'challenge_completed', 'challenge:' || p_challenge,
      jsonb_build_object('challenge_id', p_challenge, 'title', v_title, 'target_days', v_target));
    -- Challenge achievements are awarded by evaluate_achievements (024) from this update.
  else
    update public.challenge_participants set progress_days = v_days, progress_updated_at = now()
    where challenge_id = p_challenge and user_id = p_user;
  end if;
end;
$$;

-- Food logs change: refresh the user's active, log-based challenges.
create or replace function public.food_logs_challenge_progress()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  for r in
    select distinct cp.challenge_id, cp.user_id
    from public.challenge_participants cp
    join public.challenges ch on ch.id = cp.challenge_id
    join public.challenge_templates t on t.code = ch.template_code
    where cp.status = 'active' and t.metric <> 'checkin_days'
      and cp.user_id in (select n.user_id from new_rows n)
    order by 1, 2
  loop
    perform public.refresh_challenge_participant(r.challenge_id, r.user_id);
  end loop;
  return null;
end;
$$;
drop trigger if exists food_logs_challenge_insert on public.food_logs;
create trigger food_logs_challenge_insert after insert on public.food_logs
  referencing new table as new_rows
  for each statement execute function public.food_logs_challenge_progress();
drop trigger if exists food_logs_challenge_update on public.food_logs;
create trigger food_logs_challenge_update after update on public.food_logs
  referencing new table as new_rows
  for each statement execute function public.food_logs_challenge_progress();

-- ============================================================
-- 4. Actions
-- ============================================================
-- Open app challenges for the current week (Monday start), created on demand.
create or replace function public.ensure_app_challenges()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_monday date := date_trunc('week', (now() at time zone 'utc'))::date;
begin
  insert into public.challenges (template_code, kind, creator_id, starts_on, ends_on)
  select t.code, 'app', null, v_monday, v_monday + t.duration_days - 1
  from public.challenge_templates t
  where t.active and t.app_featured
  on conflict do nothing;
end;
$$;

-- Starts an individual challenge, or a group challenge with friends.
create or replace function public.start_challenge(p_template text, p_starts_on date default null,
                                                  p_invite uuid[] default '{}')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  t public.challenge_templates;
  v_today_min date;
  v_today_max date;
  v_start date;
  v_id uuid;
  v_invite uuid[] := array(select distinct x from unnest(coalesce(p_invite, '{}')) x where x is not null);
  f uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into t from public.challenge_templates where code = p_template and active;
  if not found then
    raise exception 'Unknown challenge' using errcode = 'P0002';
  end if;
  select b.today_min, b.today_max into v_today_min, v_today_max from public.user_today_bounds(v_uid) b;
  v_start := coalesce(p_starts_on, v_today_max);
  if v_start < v_today_min or v_start > v_today_max + 7 then
    raise exception 'A challenge starts today or within the next week' using errcode = '22023';
  end if;
  if cardinality(v_invite) > 9 or v_uid = any(v_invite) then
    raise exception 'Invite up to 9 friends' using errcode = '22023';
  end if;
  foreach f in array v_invite loop
    if public.blocked_between(v_uid, f) or not exists (
         select 1 from public.friendships fr where fr.status = 'accepted'
           and ((fr.requester_id = v_uid and fr.addressee_id = f) or (fr.requester_id = f and fr.addressee_id = v_uid))) then
      raise exception 'You can only invite friends' using errcode = '22023';
    end if;
  end loop;
  if (select count(*) from public.challenge_participants cp join public.challenges ch on ch.id = cp.challenge_id
      where cp.user_id = v_uid and cp.status = 'active' and ch.ends_on >= v_today_min) >= 10 then
    raise exception 'You already have 10 active challenges' using errcode = '22023';
  end if;

  insert into public.challenges (template_code, kind, creator_id, starts_on, ends_on)
  values (t.code, case when cardinality(v_invite) > 0 then 'group' else 'individual' end, v_uid,
          v_start, v_start + t.duration_days - 1)
  returning id into v_id;
  insert into public.challenge_participants (challenge_id, user_id, status, joined_at)
  values (v_id, v_uid, 'active', now());
  insert into public.challenge_participants (challenge_id, user_id, status, invited_by)
  select v_id, x, 'invited', v_uid from unnest(v_invite) x;
  perform public.record_activity(v_uid, 'challenge_joined', 'challenge:' || v_id,
    jsonb_build_object('challenge_id', v_id, 'title', t.title, 'target_days', t.target_days));
  perform public.refresh_challenge_participant(v_id, v_uid);
  return v_id;
end;
$$;

-- Joins an open app challenge, or accepts an invitation. Idempotent.
create or replace function public.join_challenge(p_challenge uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  c record;
  p record;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select ch.*, t.title, t.target_days into c
  from public.challenges ch join public.challenge_templates t on t.code = ch.template_code where ch.id = p_challenge;
  select cp.status into p from public.challenge_participants cp
  where cp.challenge_id = p_challenge and cp.user_id = v_uid for update;
  if c.id is null or (c.kind <> 'app' and p.status is null) then
    raise exception 'Challenge not found' using errcode = 'P0002';     -- indistinguishable from "not invited"
  end if;
  if c.ends_on < (select b.today_min from public.user_today_bounds(v_uid) b) then
    raise exception 'This challenge has ended' using errcode = '55000';
  end if;
  if p.status in ('active', 'completed') then
    return;                                                              -- already in: no-op
  end if;
  if p.status is null then
    -- A concurrent join of the same app challenge may insert first: then that
    -- session does the rest and this one is a no-op.
    insert into public.challenge_participants (challenge_id, user_id, status, joined_at)
    values (p_challenge, v_uid, 'active', now())
    on conflict (challenge_id, user_id) do nothing;
    if not found then
      return;
    end if;
  else                                                                  -- invited, declined or left
    update public.challenge_participants set status = 'active', joined_at = now(), left_at = null
    where challenge_id = p_challenge and user_id = v_uid;
  end if;
  perform public.record_activity(v_uid, 'challenge_joined', 'challenge:' || p_challenge,
    jsonb_build_object('challenge_id', p_challenge, 'title', c.title, 'target_days', c.target_days));
  perform public.refresh_challenge_participant(p_challenge, v_uid);
end;
$$;

create or replace function public.decline_challenge(p_challenge uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  update public.challenge_participants set status = 'declined'
  where challenge_id = p_challenge and user_id = auth.uid() and status = 'invited';
  if not found then
    raise exception 'No pending invitation' using errcode = 'P0002';
  end if;
end;
$$;

-- Leaves an active challenge. A completed challenge stays completed.
create or replace function public.leave_challenge(p_challenge uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select status into v_status from public.challenge_participants
  where challenge_id = p_challenge and user_id = auth.uid() for update;
  if v_status is null then
    raise exception 'Challenge not found' using errcode = 'P0002';
  end if;
  if v_status = 'completed' then
    raise exception 'A completed challenge can''t be left' using errcode = '55000';
  end if;
  if v_status = 'active' then
    update public.challenge_participants set status = 'left', left_at = now()
    where challenge_id = p_challenge and user_id = auth.uid();
  end if;
end;
$$;

-- Self-reported check-in for today (or yesterday), once per day. Returns progress.
create or replace function public.check_in_challenge(p_challenge uuid, p_day date default null)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  c record;
  v_min date;
  v_max date;
  v_day date;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select ch.starts_on, ch.ends_on, t.metric, cp.status, cp.progress_days into c
  from public.challenges ch join public.challenge_templates t on t.code = ch.template_code
  join public.challenge_participants cp on cp.challenge_id = ch.id and cp.user_id = v_uid
    and cp.status in ('active', 'completed')
  where ch.id = p_challenge;
  if not found then
    raise exception 'Not an active participant' using errcode = 'P0002';
  end if;
  if c.metric <> 'checkin_days' then
    raise exception 'This challenge is tracked from your food logs' using errcode = '22023';
  end if;
  if c.status = 'completed' then
    return c.progress_days;          -- a repeated tap after completing: nothing to do
  end if;
  select b.today_min, b.today_max into v_min, v_max from public.user_today_bounds(v_uid) b;
  -- Without the device's date, "today" is the latest one possible (UTC+14 when
  -- the time zone is unknown), which can be past a challenge's last day.
  v_day := coalesce(p_day, least(v_max, c.ends_on));
  if v_day < v_min - 1 or v_day > v_max then
    raise exception 'Check in for today or yesterday only' using errcode = '22023';
  end if;
  if v_day < c.starts_on or v_day > c.ends_on then
    raise exception 'That day is outside the challenge' using errcode = '22023';
  end if;
  insert into public.challenge_checkins (challenge_id, user_id, day) values (p_challenge, v_uid, v_day)
  on conflict do nothing;
  perform public.refresh_challenge_participant(p_challenge, v_uid);
  return (select progress_days from public.challenge_participants where challenge_id = p_challenge and user_id = v_uid);
end;
$$;

-- ============================================================
-- 5. Reads
-- ============================================================
-- State shown to the user, derived from status and dates.
create or replace function public.challenge_state(p_status text, p_starts date, p_ends date, p_today date)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_status = 'completed' then 'completed'
    when p_status in ('left', 'declined', 'invited') then p_status
    when p_ends < p_today then 'expired'
    when p_starts > p_today then 'upcoming'
    else 'active' end;
$$;

-- Catalogue: templates to start, plus this week's open app challenges.
create or replace function public.get_challenge_catalog()
returns table (template_code text, title text, description text, metric text, cadence text, duration_days int,
               target_days int, checkin_label text, safety_note text, app_challenge_id uuid, starts_on date,
               ends_on date, participant_count int, my_state text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_today date;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  perform public.ensure_app_challenges();
  select b.today_min into v_today from public.user_today_bounds(v_uid) b;
  return query
  select t.code, t.title, t.description, t.metric, t.cadence, t.duration_days, t.target_days, t.checkin_label,
         t.safety_note, ch.id, ch.starts_on, ch.ends_on,
         (select count(*)::int from public.challenge_participants cp
          where cp.challenge_id = ch.id and cp.status in ('active', 'completed')),
         (select public.challenge_state(cp.status, ch.starts_on, ch.ends_on, v_today)
          from public.challenge_participants cp where cp.challenge_id = ch.id and cp.user_id = v_uid)
  from public.challenge_templates t
  left join public.challenges ch on ch.template_code = t.code and ch.kind = 'app'
    and ch.starts_on = date_trunc('week', (now() at time zone 'utc'))::date
  where t.active
  order by t.sort, t.code;
end;
$$;

-- My challenges (current and history), refreshed before returning.
create or replace function public.get_my_challenges()
returns table (challenge_id uuid, template_code text, title text, description text, metric text, cadence text,
               kind text, starts_on date, ends_on date, target_days int, progress_days int, state text,
               checkin_label text, safety_note text, checked_in_today boolean, participant_count int,
               invited_by_username text, completed_at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_today date;
  r record;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  for r in select cp.challenge_id from public.challenge_participants cp
           where cp.user_id = v_uid and cp.status = 'active' order by 1 loop
    perform public.refresh_challenge_participant(r.challenge_id, v_uid);
  end loop;
  select b.today_max into v_today from public.user_today_bounds(v_uid) b;
  return query
  select ch.id, t.code, t.title, t.description, t.metric, t.cadence, ch.kind, ch.starts_on, ch.ends_on, t.target_days,
         cp.progress_days, public.challenge_state(cp.status, ch.starts_on, ch.ends_on, v_today), t.checkin_label,
         t.safety_note,
         exists (select 1 from public.challenge_checkins k where k.challenge_id = ch.id and k.user_id = v_uid
                 and k.day = v_today),
         (select count(*)::int from public.challenge_participants x
          where x.challenge_id = ch.id and x.status in ('active', 'completed')),
         (select p.username from public.profiles p where p.user_id = cp.invited_by),
         cp.completed_at
  from public.challenge_participants cp
  join public.challenges ch on ch.id = cp.challenge_id
  join public.challenge_templates t on t.code = ch.template_code
  where cp.user_id = v_uid and cp.status <> 'declined'
    and (cp.invited_by is null or not public.blocked_between(v_uid, cp.invited_by))
  order by (cp.status = 'invited') desc, (cp.status = 'active' and ch.ends_on >= v_today) desc, ch.ends_on desc, ch.id;
end;
$$;

-- One challenge, for its members: other participants' progress as day counts,
-- listed alphabetically (never ranked). Blocked users are left out both ways.
create or replace function public.get_challenge_participants(p_challenge uuid)
returns table (user_id uuid, username text, avatar_url text, is_me boolean, state text, progress_days int,
               target_days int)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_today date;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.challenge_participants cp
                 where cp.challenge_id = p_challenge and cp.user_id = v_uid
                   and cp.status in ('invited', 'active', 'completed', 'left')) then
    raise exception 'Challenge not found' using errcode = 'P0002';
  end if;
  select b.today_max into v_today from public.user_today_bounds(v_uid) b;
  return query
  select cp.user_id, p.username, p.avatar_url, cp.user_id = v_uid,
         public.challenge_state(cp.status, ch.starts_on, ch.ends_on, v_today), cp.progress_days, t.target_days
  from public.challenge_participants cp
  join public.challenges ch on ch.id = cp.challenge_id
  join public.challenge_templates t on t.code = ch.template_code
  left join public.profiles p on p.user_id = cp.user_id
  where cp.challenge_id = p_challenge
    and ch.kind <> 'app'                                  -- app challenges: strangers are never listed
    and cp.status in ('invited', 'active', 'completed')
    and (cp.user_id = v_uid or not public.blocked_between(v_uid, cp.user_id))
  order by (cp.user_id = v_uid) desc, lower(coalesce(p.username, '')), cp.user_id;
end;
$$;

-- ============================================================
-- 6. Privileges
-- ============================================================
revoke all on function public.is_challenge_member(uuid) from public, anon;
revoke all on function public.challenge_progress_days(uuid, uuid) from public, anon, authenticated;
revoke all on function public.refresh_challenge_participant(uuid, uuid) from public, anon, authenticated;
revoke all on function public.food_logs_challenge_progress() from public, anon, authenticated;
revoke all on function public.ensure_app_challenges() from public, anon, authenticated;
revoke all on function public.start_challenge(text, date, uuid[]) from public, anon;
revoke all on function public.join_challenge(uuid) from public, anon;
revoke all on function public.decline_challenge(uuid) from public, anon;
revoke all on function public.leave_challenge(uuid) from public, anon;
revoke all on function public.check_in_challenge(uuid, date) from public, anon;
revoke all on function public.challenge_state(text, date, date, date) from public, anon;
revoke all on function public.get_challenge_catalog() from public, anon;
revoke all on function public.get_my_challenges() from public, anon;
revoke all on function public.get_challenge_participants(uuid) from public, anon;

grant execute on function public.is_challenge_member(uuid) to authenticated;          -- used by an RLS policy
grant execute on function public.start_challenge(text, date, uuid[]) to authenticated;
grant execute on function public.join_challenge(uuid) to authenticated;
grant execute on function public.decline_challenge(uuid) to authenticated;
grant execute on function public.leave_challenge(uuid) to authenticated;
grant execute on function public.check_in_challenge(uuid, date) to authenticated;
grant execute on function public.challenge_state(text, date, date, date) to authenticated;
grant execute on function public.get_challenge_catalog() to authenticated;
grant execute on function public.get_my_challenges() to authenticated;
grant execute on function public.get_challenge_participants(uuid) to authenticated;

commit;
