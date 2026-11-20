-- Calorie Tracker — server-authoritative streaks
-- Run after 003_social_security.sql. Safe to re-run.
--
-- Before: the client computed streaks in lib/api.ts bumpStreak() using UTC
-- dates, bumped them even for backdated logs, never lowered them when logs
-- were deleted, and wrote arbitrary values straight into user_streaks.
--
-- After: user_streaks is written only by a trigger on food_logs, which
-- recalculates from the user's distinct logged dates. Clients can only read it.
--
-- Streak semantics
--   * A day is active if it has at least one food log; several logs = one day.
--   * A run is a sequence of consecutive active calendar dates.
--   * Stored (by the trigger):
--       last_logged_date  most recent active date (dates in the future for the
--                         user are ignored — see "Date bounds" below)
--       current_streak    length of the run that ends on last_logged_date
--       longest_streak    longest run in the user's history (new column)
--       badges_earned     number of milestones reached, never decreases
--   * Effective, returned when read (get_my_streak, get_friend_summaries):
--       current_streak if last_logged_date is today or yesterday in the user's
--       local calendar, otherwise 0. Applying decay when the value is read means
--       a stored value never goes stale overnight.
--   * Backdating recalculates history. A log on an isolated past date doesn't
--     change the current run; a log that fills a gap joins two runs, because
--     the user genuinely was active on that day.
--
-- Time zones
--   The app writes food_logs.logged_date using the device's local date. To
--   evaluate "today/yesterday" for any user (including for a friend viewing
--   them), the server needs that user's zone, so profiles gains a nullable
--   IANA `timezone`, which the app sets from the device. When it is not set
--   yet, the server does NOT assume UTC. It uses the bounds that are correct
--   somewhere on Earth (UTC-12 … UTC+14):
--     earliest possible today = (UTC now - 12h)::date  — used for decay, so a
--                                streak is never zeroed early (at most one
--                                extra day of leniency)
--     latest possible today   = (UTC now + 14h)::date  — used to cap counted
--                                dates, so a real local "today" is never ignored
--
-- Badges
--   Milestones (consecutive days): 3, 7, 14, 30, 60, 100, 180, 365.
--   badges_earned = number of milestones the longest run has reached, kept as
--   a high-water mark, so a badge is never awarded twice and is not revoked
--   by later deletions.

begin;

-- ============================================================
-- 1. Schema additions (non-destructive)
-- ============================================================

-- Validates an IANA time zone name against the server's tz database.
create or replace function public.is_valid_timezone(p_tz text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_tz is null or length(p_tz) > 64 then
    return false;
  end if;
  perform now() at time zone p_tz;
  return true;
exception when others then
  return false;
end;
$$;

alter table public.profiles add column if not exists timezone text;
alter table public.profiles drop constraint if exists profiles_timezone_valid;
alter table public.profiles
  add constraint profiles_timezone_valid
  check (timezone is null or public.is_valid_timezone(timezone));

-- Remember whether this is the first application (no longest_streak yet), so
-- the backfill in section 7 resets legacy badge counts only once. Re-runs keep
-- the high-water mark.
do $$
begin
  perform set_config(
    'calorie_tracker.streak_first_run',
    (not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'user_streaks' and column_name = 'longest_streak'
    ))::text,
    true
  );
end;
$$;

alter table public.user_streaks add column if not exists longest_streak int not null default 0;

-- ============================================================
-- 2. Helpers
-- ============================================================

-- Inclusive range of dates that can be "today" for this user right now. With a
-- known zone the range is a single day. Without one it covers every zone on Earth.
create or replace function public.user_today_bounds(p_user uuid, out today_min date, out today_max date)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_utc timestamp := now() at time zone 'utc';
begin
  select p.timezone into v_tz from public.profiles p where p.user_id = p_user;
  if v_tz is not null and public.is_valid_timezone(v_tz) then
    today_min := (now() at time zone v_tz)::date;
    today_max := today_min;
  else
    today_min := (v_utc - interval '12 hours')::date;
    today_max := (v_utc + interval '14 hours')::date;
  end if;
end;
$$;

-- Number of milestones reached by a run of p_days.
create or replace function public.streak_milestone_count(p_days int)
returns int
language sql
immutable
set search_path = ''
as $$
  select count(*)::int
  from unnest(array[3, 7, 14, 30, 60, 100, 180, 365]) as m(days)
  where m.days <= coalesce(p_days, 0);
$$;

-- The streak a user has *now*: the stored run if it ended today or yesterday.
create or replace function public.effective_current_streak(p_run int, p_last date, p_today date)
returns int
language sql
immutable
set search_path = ''
as $$
  select case
           when p_last is not null and p_today is not null and p_last >= p_today - 1
             then coalesce(p_run, 0)
           else 0
         end;
$$;

-- ============================================================
-- 3. Recalculation
--
-- The only code that writes user_streaks. It takes the user id from its caller,
-- the food_logs trigger, which passes ids from the affected rows. It is never
-- exposed to clients.
--
-- Concurrency: a transaction-scoped advisory lock per user serializes
-- recalculations. Under READ COMMITTED every statement after the lock takes a
-- fresh snapshot, so a transaction that waited sees the logs committed by the
-- one before it, and the last writer always computes from complete data.
-- user_streaks.user_id is unique, so the upsert can never create a second row.
-- ============================================================
create or replace function public.recalculate_user_streak(p_user uuid, p_reset_badges boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max date;
  v_last date;
  v_current int := 0;
  v_longest int := 0;
begin
  if p_user is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('user_streak:' || p_user::text, 0));

  -- Account deletion cascades auth.users -> food_logs, which fires the delete
  -- trigger. The user row is already gone by then; writing a streak row for it
  -- would violate the FK and abort the account deletion.
  if not exists (select 1 from auth.users u where u.id = p_user) then
    return;
  end if;

  select b.today_max into v_max from public.user_today_bounds(p_user) b;

  -- Gaps-and-islands: consecutive dates share (date - row_number).
  with days as (
    select distinct l.logged_date as d
    from public.food_logs l
    where l.user_id = p_user
      and l.logged_date <= v_max
  ),
  grouped as (
    select d, d - (row_number() over (order by d))::int as grp
    from days
  ),
  runs as (
    select max(d) as run_end, count(*)::int as len
    from grouped
    group by grp
  )
  select
    (select r.run_end from runs r order by r.run_end desc limit 1),
    coalesce((select r.len from runs r order by r.run_end desc limit 1), 0),
    coalesce((select max(r.len) from runs r), 0)
  into v_last, v_current, v_longest;

  insert into public.user_streaks as s
    (user_id, current_streak, last_logged_date, longest_streak, badges_earned)
  values
    (p_user, v_current, v_last, v_longest, public.streak_milestone_count(v_longest))
  on conflict (user_id) do update
    set current_streak   = excluded.current_streak,
        last_logged_date = excluded.last_logged_date,
        longest_streak   = excluded.longest_streak,
        badges_earned    = case
                             when p_reset_badges then excluded.badges_earned
                             else greatest(s.badges_earned, excluded.badges_earned)
                           end;
end;
$$;

-- Statement-level trigger function: recalculates each affected user once per
-- statement, however many rows the statement touched. Users are processed in
-- sorted order so two multi-user statements can't deadlock on the advisory locks.
create or replace function public.food_logs_recalculate_streaks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if tg_op = 'INSERT' then
    for v_user in select distinct n.user_id from new_rows n order by 1 loop
      perform public.recalculate_user_streak(v_user);
    end loop;
  elsif tg_op = 'DELETE' then
    for v_user in select distinct o.user_id from old_rows o order by 1 loop
      perform public.recalculate_user_streak(v_user);
    end loop;
  else -- UPDATE: both the old and the new owner/date matter
    for v_user in
      select u from (
        select n.user_id as u from new_rows n
        union
        select o.user_id from old_rows o
      ) x order by 1
    loop
      perform public.recalculate_user_streak(v_user);
    end loop;
  end if;
  return null;
end;
$$;

-- Transition tables only allow one event per trigger, hence three triggers.
drop trigger if exists food_logs_streak_insert on public.food_logs;
create trigger food_logs_streak_insert
  after insert on public.food_logs
  referencing new table as new_rows
  for each statement execute function public.food_logs_recalculate_streaks();

drop trigger if exists food_logs_streak_delete on public.food_logs;
create trigger food_logs_streak_delete
  after delete on public.food_logs
  referencing old table as old_rows
  for each statement execute function public.food_logs_recalculate_streaks();

drop trigger if exists food_logs_streak_update on public.food_logs;
create trigger food_logs_streak_update
  after update on public.food_logs
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.food_logs_recalculate_streaks();

-- ============================================================
-- 4. Lock clients out of user_streaks writes
-- ============================================================
drop policy if exists "Users can insert their own streak" on public.user_streaks;
drop policy if exists "Users can update their own streak" on public.user_streaks;
-- "Users can view their own streak" (SELECT, owner only) is kept.

revoke all on table public.user_streaks from anon;
revoke all on table public.user_streaks from authenticated;
grant select on table public.user_streaks to authenticated;

-- ============================================================
-- 5. Read API
-- ============================================================

-- The caller's streak with decay applied. Returns no row if the user has never
-- logged anything. The shape matches lib/types.ts UserStreak.
create or replace function public.get_my_streak()
returns table (
  id uuid,
  user_id uuid,
  current_streak int,
  last_logged_date date,
  longest_streak int,
  badges_earned int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_today date;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select b.today_min into v_today from public.user_today_bounds(v_uid) b;

  return query
  select s.id,
         s.user_id,
         public.effective_current_streak(s.current_streak, s.last_logged_date, v_today),
         s.last_logged_date,
         s.longest_streak,
         s.badges_earned
  from public.user_streaks s
  where s.user_id = v_uid;
end;
$$;

-- Same as 003, except current_streak now has decay applied in the *friend's*
-- time zone, so a streak that lapsed days ago no longer shows as live. The date
-- window and the aggregate-only output are unchanged.
create or replace function public.get_friend_summaries(p_today date)
returns table (
  user_id uuid,
  username text,
  avatar_url text,
  today_kcal numeric,
  avg7_kcal numeric,
  current_streak int,
  daily_target_kcal int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_utc timestamp := now() at time zone 'utc';
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_today is null
     or p_today < (v_utc - interval '12 hours')::date
     or p_today > (v_utc + interval '14 hours')::date then
    raise exception 'p_today must be the caller''s current local date'
      using errcode = '22023';
  end if;

  return query
  with friends as (
    select case
             when f.requester_id = v_uid then f.addressee_id
             else f.requester_id
           end as fid
    from public.friendships f
    where f.status = 'accepted'
      and (f.requester_id = v_uid or f.addressee_id = v_uid)
  )
  select
    p.user_id,
    p.username,
    p.avatar_url,
    coalesce((
      select sum(l.calories) from public.food_logs l
      where l.user_id = p.user_id and l.logged_date = p_today
    ), 0)::numeric,
    coalesce((
      select avg(d.total) from (
        select sum(l2.calories) as total
        from public.food_logs l2
        where l2.user_id = p.user_id
          and l2.logged_date > p_today - 7
          and l2.logged_date <= p_today
        group by l2.logged_date
      ) d
    ), 0)::numeric,
    public.effective_current_streak(
      s.current_streak,
      s.last_logged_date,
      (select b.today_min from public.user_today_bounds(p.user_id) b)
    ),
    p.daily_target_kcal
  from friends
  join public.profiles p on p.user_id = friends.fid
  left join public.user_streaks s on s.user_id = friends.fid;
end;
$$;

-- ============================================================
-- 6. Function privileges
--
-- Internal functions run only inside the trigger or other definer functions,
-- so no client role can call them directly. The two helpers used in the CHECK
-- constraint and expressions stay executable because they're pure and expose
-- nothing.
-- ============================================================
revoke all on function public.recalculate_user_streak(uuid, boolean) from public, anon, authenticated;
revoke all on function public.food_logs_recalculate_streaks() from public, anon, authenticated;
revoke all on function public.user_today_bounds(uuid) from public, anon, authenticated;

revoke all on function public.get_my_streak() from public, anon;
grant execute on function public.get_my_streak() to authenticated;

revoke all on function public.get_friend_summaries(date) from public, anon;
grant execute on function public.get_friend_summaries(date) to authenticated;

-- is_valid_timezone runs inside the profiles CHECK constraint as the writing
-- role, so authenticated needs EXECUTE.
revoke all on function public.is_valid_timezone(text) from public, anon;
grant execute on function public.is_valid_timezone(text) to authenticated;
revoke all on function public.streak_milestone_count(int) from public, anon;
grant execute on function public.streak_milestone_count(int) to authenticated;
revoke all on function public.effective_current_streak(int, date, date) from public, anon;
grant execute on function public.effective_current_streak(int, date, date) to authenticated;

-- ============================================================
-- 7. Backfill
--
-- Recalculate every user who has logs or a streak row. On the first
-- application, badges are *reset* to the milestone count: the old client logic
-- incremented badges_earned on almost every logged day, so those values have
-- no meaning. On re-runs, badges keep their high-water mark.
-- Users with a streak row but no logs end up with 0 / null / 0 / (badges).
-- ============================================================
do $$
declare
  v_user uuid;
  v_reset boolean := coalesce(current_setting('calorie_tracker.streak_first_run', true), 'false')::boolean;
begin
  for v_user in
    select u from (
      select l.user_id as u from public.food_logs l
      union
      select s.user_id from public.user_streaks s
    ) x order by 1
  loop
    perform public.recalculate_user_streak(v_user, v_reset);
  end loop;
end;
$$;

commit;

-- ============================================================
-- Rollback notes (manual — do not run as part of this migration)
--
-- Rolling back puts streak writes back in client hands. If it is unavoidable:
--   drop trigger if exists food_logs_streak_insert on public.food_logs;
--   drop trigger if exists food_logs_streak_delete on public.food_logs;
--   drop trigger if exists food_logs_streak_update on public.food_logs;
--   drop function if exists public.food_logs_recalculate_streaks();
--   drop function if exists public.recalculate_user_streak(uuid, boolean);
--   drop function if exists public.get_my_streak();
--   Re-run the get_friend_summaries definition from 003_social_security.sql.
--   Recreate the INSERT/UPDATE policies on user_streaks from 001_init.sql and
--   grant insert, update on public.user_streaks to authenticated;
-- The added columns (profiles.timezone, user_streaks.longest_streak) are
-- harmless to keep. The app from this change reads get_my_streak(), so it
-- must be rolled back together with the database.
-- ============================================================
