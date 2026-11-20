-- Calorie Tracker — personalised nutrition targets and daily status
-- Run after 004_server_streaks.sql. Safe to re-run.
--
-- Before: the app computed the calorie target on the device (fixed activity
-- factor 1.375) and wrote any value it liked into profiles.daily_target_kcal.
-- Macro targets were a hard-coded 55/25/20 split recomputed on each screen, and
-- each screen aggregated daily totals its own way.
--
-- After:
--   * profiles stores activity_level and a macro split (carb/fat/protein %).
--   * The database computes daily_target_kcal (trigger). Client values are
--     ignored, so there is one copy of the formula that can't be bypassed.
--   * nutrition_target_history records every target change, so a past day is
--     judged against the target in force on that day.
--   * get_daily_status(date) and get_daily_totals(start, end) are the shared
--     source of daily numbers for the app and future backend services.
--   * get_friend_summaries evaluates a friend's "today" in the friend's own
--     time zone (when known).
--
-- Formula (formula_version 1), mirrored for previews in lib/calculations.ts:
--   BMR    = 10*kg + 6.25*cm - 5*age + (male ? 5 : -161)        Mifflin-St Jeor
--   TDEE   = BMR * activity factor
--              sedentary 1.2 | light 1.375 | moderate 1.55 | active 1.725 | very_active 1.9
--   target = round(TDEE + goal adjustment)    lose -500 | maintain 0 | gain +300
--            never below 1200 kcal (MIN_DAILY_TARGET_KCAL)
--   macro grams = round(target * pct / 100 / kcal-per-gram)     carb 4 | fat 9 | protein 4
--
-- Existing users default to activity 'light' (the old fixed factor) and
-- 55/25/20, so their targets only change if they were below the 1200 floor or
-- had been written with a non-formula value.

begin;

-- ============================================================
-- 1. Profile preferences
-- ============================================================
alter table public.profiles add column if not exists activity_level text not null default 'light';
alter table public.profiles add column if not exists macro_carb_pct smallint not null default 55;
alter table public.profiles add column if not exists macro_fat_pct smallint not null default 25;
alter table public.profiles add column if not exists macro_protein_pct smallint not null default 20;

-- New columns only ever hold valid defaults, so these validate immediately.
alter table public.profiles drop constraint if exists profiles_activity_level_valid;
alter table public.profiles
  add constraint profiles_activity_level_valid
  check (activity_level in ('sedentary', 'light', 'moderate', 'active', 'very_active'));

-- Each macro 10–70 % of calories, summing to exactly 100.
alter table public.profiles drop constraint if exists profiles_macro_split_valid;
alter table public.profiles
  add constraint profiles_macro_split_valid
  check (
    macro_carb_pct between 10 and 70
    and macro_fat_pct between 10 and 70
    and macro_protein_pct between 10 and 70
    and macro_carb_pct + macro_fat_pct + macro_protein_pct = 100
  );

-- Body measurements: the same bounds the onboarding form already enforces
-- (app/onboarding/profile-setup.tsx). Added NOT VALID so legacy rows can't
-- abort the migration; validated below only if every row passes.
alter table public.profiles drop constraint if exists profiles_body_valid;
alter table public.profiles
  add constraint profiles_body_valid
  check (
    age > 0 and age < 120
    and height_cm > 0 and height_cm < 250
    and weight_kg > 0 and weight_kg < 400
  )
  not valid;

do $$
declare
  v_bad int;
begin
  select count(*) into v_bad from public.profiles
  where not (age > 0 and age < 120 and height_cm > 0 and height_cm < 250
             and weight_kg > 0 and weight_kg < 400);
  if v_bad = 0 then
    alter table public.profiles validate constraint profiles_body_valid;
  else
    raise warning 'profiles_body_valid left NOT VALID: % profile(s) have out-of-range age/height/weight', v_bad;
  end if;
end;
$$;

-- ============================================================
-- 2. The formula (single source of truth)
-- ============================================================
create or replace function public.activity_factor(p_level text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case p_level
           when 'sedentary'   then 1.2
           when 'light'       then 1.375
           when 'moderate'    then 1.55
           when 'active'      then 1.725
           when 'very_active' then 1.9
         end::numeric;
$$;

create or replace function public.compute_daily_target(
  p_weight_kg numeric,
  p_height_cm numeric,
  p_age int,
  p_gender text,
  p_goal text,
  p_activity_level text
)
returns int
language sql
immutable
set search_path = ''
as $$
  select greatest(
    1200,  -- MIN_DAILY_TARGET_KCAL; keep in step with lib/calculations.ts
    round(
      (10 * p_weight_kg + 6.25 * p_height_cm - 5 * p_age
         + case when p_gender = 'male' then 5 else -161 end)
      * public.activity_factor(p_activity_level)
      + case p_goal when 'lose' then -500 when 'gain' then 300 else 0 end
    )
  )::int;
$$;

-- Macro grams for a target and split. Returns (carbs_g, fat_g, protein_g).
create or replace function public.macro_targets(
  p_target_kcal int,
  p_carb_pct int,
  p_fat_pct int,
  p_protein_pct int,
  out carbs_g int,
  out fat_g int,
  out protein_g int
)
language sql
immutable
set search_path = ''
as $$
  select round(p_target_kcal * p_carb_pct / 100.0 / 4)::int,
         round(p_target_kcal * p_fat_pct / 100.0 / 9)::int,
         round(p_target_kcal * p_protein_pct / 100.0 / 4)::int;
$$;

-- ============================================================
-- 3. Target history
-- ============================================================
create table if not exists public.nutrition_target_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- First local calendar date this target applies to.
  effective_from date not null,
  daily_target_kcal int not null check (daily_target_kcal > 0),
  macro_carb_pct smallint not null,
  macro_fat_pct smallint not null,
  macro_protein_pct smallint not null,
  activity_level text not null,
  goal text not null,
  formula_version smallint not null default 1,
  created_at timestamptz not null default now(),
  constraint nutrition_target_history_one_per_day unique (user_id, effective_from)
);

-- The unique (user_id, effective_from) index also serves "latest row on or
-- before date X" lookups.

alter table public.nutrition_target_history enable row level security;

drop policy if exists "Users can view their own target history" on public.nutrition_target_history;
create policy "Users can view their own target history"
  on public.nutrition_target_history for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Written only by the profiles trigger below.
revoke all on table public.nutrition_target_history from anon, authenticated;
grant select on table public.nutrition_target_history to authenticated;

-- ============================================================
-- 4. Profile triggers
-- ============================================================

-- BEFORE: compute the target. Whatever the client sent is overwritten.
create or replace function public.profiles_compute_target()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.daily_target_kcal := public.compute_daily_target(
    new.weight_kg, new.height_cm, new.age, new.gender, new.goal, new.activity_level);
  return new;
end;
$$;

-- Fires on every write (not only body/goal columns) so that a row whose stored
-- target predates this migration is corrected the next time it is saved for
-- any reason, before the history trigger records it.
drop trigger if exists profiles_compute_target on public.profiles;
create trigger profiles_compute_target
  before insert or update on public.profiles
  for each row execute function public.profiles_compute_target();

-- AFTER: record the target in force from the user's local today. One row per
-- user per day; several edits on the same day keep the last.
create or replace function public.profiles_record_target_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from date;
begin
  if tg_op = 'UPDATE'
     and new.daily_target_kcal = old.daily_target_kcal
     and new.macro_carb_pct = old.macro_carb_pct
     and new.macro_fat_pct = old.macro_fat_pct
     and new.macro_protein_pct = old.macro_protein_pct
     and new.activity_level = old.activity_level
     and new.goal = old.goal
     and exists (select 1 from public.nutrition_target_history h where h.user_id = new.user_id) then
    -- Nothing that affects targets changed (e.g. a username edit). A user
    -- without any history yet always gets a first row, which is what the
    -- backfill below relies on for targets that already matched the formula.
    return null;
  end if;

  select b.today_min into v_from from public.user_today_bounds(new.user_id) b;

  insert into public.nutrition_target_history as h
    (user_id, effective_from, daily_target_kcal, macro_carb_pct, macro_fat_pct,
     macro_protein_pct, activity_level, goal, formula_version)
  values
    (new.user_id, v_from, new.daily_target_kcal, new.macro_carb_pct, new.macro_fat_pct,
     new.macro_protein_pct, new.activity_level, new.goal, 1)
  on conflict (user_id, effective_from) do update
    set daily_target_kcal = excluded.daily_target_kcal,
        macro_carb_pct    = excluded.macro_carb_pct,
        macro_fat_pct     = excluded.macro_fat_pct,
        macro_protein_pct = excluded.macro_protein_pct,
        activity_level    = excluded.activity_level,
        goal              = excluded.goal,
        formula_version   = excluded.formula_version,
        created_at        = now();
  return null;
end;
$$;

drop trigger if exists profiles_record_target_history on public.profiles;
create trigger profiles_record_target_history
  after insert or update on public.profiles
  for each row execute function public.profiles_record_target_history();

-- ============================================================
-- 5. Backfill existing profiles
--
-- Recompute every target with the formula (fires both triggers, which also
-- writes the first history row). Rows that fail a constraint still NOT VALID
-- (username format from 003, body bounds above) would make the UPDATE fail,
-- so they are skipped and counted instead.
-- ============================================================
do $$
declare
  v_changed int;
  v_skipped int;
begin
  select count(*) into v_changed from public.profiles p
  where p.daily_target_kcal is distinct from public.compute_daily_target(
          p.weight_kg, p.height_cm, p.age, p.gender, p.goal, p.activity_level);

  update public.profiles p
  set daily_target_kcal = p.daily_target_kcal   -- touches the column, fires the triggers
  where (p.username is null or p.username ~ '^[a-z0-9_]{3,20}$')
    and p.age > 0 and p.age < 120
    and p.height_cm > 0 and p.height_cm < 250
    and p.weight_kg > 0 and p.weight_kg < 400
    and not exists (select 1 from public.nutrition_target_history h where h.user_id = p.user_id);

  select count(*) into v_skipped from public.profiles p
  where not exists (select 1 from public.nutrition_target_history h where h.user_id = p.user_id);

  raise notice '005 backfill: % profile target(s) differed from the formula; % profile(s) skipped (fail a pending constraint)',
    v_changed, v_skipped;
end;
$$;

-- No earlier target was ever recorded, so for dates before a user's first
-- history row, get_daily_status uses that first row (see section 6).

-- ============================================================
-- 6. Daily status — the shared source of daily numbers
--
-- SECURITY INVOKER: runs as the caller, so RLS on profiles, food_logs and
-- nutrition_target_history applies on top of the explicit auth.uid() filter.
-- There is no user-id parameter.
--
-- Date semantics: p_date is a local calendar date, the same one food_logs
-- stores. When omitted, it means "today" in the user's stored time zone; with
-- no zone stored, the date must be passed explicitly (the app always does).
--
-- Target for a date: the latest history row on or before it, else the earliest
-- row, else the profile's current values. Targets are NULL if the user has no
-- profile yet. Consumption is always returned, as 0 when nothing was logged.
-- Remaining values are target - consumed and may be negative (over target).
-- ============================================================
create or replace function public.get_daily_status(p_date date default null)
returns table (
  status_date date,
  target_kcal int,
  target_carbs_g int,
  target_fat_g int,
  target_protein_g int,
  macro_carb_pct smallint,
  macro_fat_pct smallint,
  macro_protein_pct smallint,
  consumed_kcal numeric,
  consumed_carbs_g numeric,
  consumed_fat_g numeric,
  consumed_protein_g numeric,
  remaining_kcal numeric,
  remaining_carbs_g numeric,
  remaining_fat_g numeric,
  remaining_protein_g numeric,
  entry_count int
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_date date := p_date;
  v_tz text;
  v_target int;
  v_carb smallint;
  v_fat smallint;
  v_protein smallint;
  v_kcal numeric := 0;
  v_c numeric := 0;
  v_f numeric := 0;
  v_p numeric := 0;
  v_n int := 0;
  v_tc int;
  v_tf int;
  v_tp int;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if v_date is null then
    select pr.timezone into v_tz from public.profiles pr where pr.user_id = v_uid;
    if v_tz is null or not public.is_valid_timezone(v_tz) then
      raise exception 'p_date is required until the profile has a time zone' using errcode = '22023';
    end if;
    v_date := (now() at time zone v_tz)::date;
  end if;

  select h.daily_target_kcal, h.macro_carb_pct, h.macro_fat_pct, h.macro_protein_pct
    into v_target, v_carb, v_fat, v_protein
  from public.nutrition_target_history h
  where h.user_id = v_uid
  order by (h.effective_from <= v_date) desc,      -- rows in force first
           case when h.effective_from <= v_date then h.effective_from end desc,
           h.effective_from asc                   -- else the earliest row
  limit 1;

  if v_target is null then
    select pr.daily_target_kcal, pr.macro_carb_pct, pr.macro_fat_pct, pr.macro_protein_pct
      into v_target, v_carb, v_fat, v_protein
    from public.profiles pr where pr.user_id = v_uid;
  end if;

  select coalesce(sum(l.calories), 0), coalesce(sum(l.carbs_g), 0),
         coalesce(sum(l.fat_g), 0), coalesce(sum(l.protein_g), 0), count(*)::int
    into v_kcal, v_c, v_f, v_p, v_n
  from public.food_logs l
  where l.user_id = v_uid and l.logged_date = v_date;

  if v_target is not null then
    select m.carbs_g, m.fat_g, m.protein_g into v_tc, v_tf, v_tp
    from public.macro_targets(v_target, v_carb, v_fat, v_protein) m;
  end if;

  return query select
    v_date, v_target, v_tc, v_tf, v_tp, v_carb, v_fat, v_protein,
    v_kcal, v_c, v_f, v_p,
    v_target - v_kcal, v_tc - v_c, v_tf - v_f, v_tp - v_p,
    v_n;
end;
$$;

-- Per-day, per-meal sums for a date range (reports, weekly chart). Same
-- invoker/RLS model. The range is capped so one call can't scan years.
create or replace function public.get_daily_totals(p_start date, p_end date)
returns table (
  logged_date date,
  meal_type text,
  calories numeric,
  carbs_g numeric,
  fat_g numeric,
  protein_g numeric,
  entry_count int
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_start is null or p_end is null or p_end < p_start or p_end - p_start > 400 then
    raise exception 'Date range must be given, ordered, and at most 400 days' using errcode = '22023';
  end if;

  return query
  select l.logged_date, l.meal_type,
         sum(l.calories), sum(l.carbs_g), sum(l.fat_g), sum(l.protein_g), count(*)::int
  from public.food_logs l
  where l.user_id = v_uid
    and l.logged_date between p_start and p_end
  group by l.logged_date, l.meal_type
  order by l.logged_date, l.meal_type;
end;
$$;

-- ============================================================
-- 7. Friend summaries: "today" in the friend's own time zone
--
-- Identical to 004 except that today_kcal and the 7-day window are evaluated
-- on the friend's local date when their profile has a time zone (falling back
-- to the viewer's p_today when it doesn't). The p_today window check, the
-- aggregate-only output and the streak decay are unchanged.
-- ============================================================
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
  ),
  friend_days as (
    select p.user_id as fid,
           case when p.timezone is not null and public.is_valid_timezone(p.timezone)
                then (now() at time zone p.timezone)::date
                else p_today
           end as fday
    from friends
    join public.profiles p on p.user_id = friends.fid
  )
  select
    p.user_id,
    p.username,
    p.avatar_url,
    coalesce((
      select sum(l.calories) from public.food_logs l
      where l.user_id = p.user_id and l.logged_date = fd.fday
    ), 0)::numeric,
    coalesce((
      select avg(d.total) from (
        select sum(l2.calories) as total
        from public.food_logs l2
        where l2.user_id = p.user_id
          and l2.logged_date > fd.fday - 7
          and l2.logged_date <= fd.fday
        group by l2.logged_date
      ) d
    ), 0)::numeric,
    public.effective_current_streak(
      s.current_streak,
      s.last_logged_date,
      (select b.today_min from public.user_today_bounds(p.user_id) b)
    ),
    p.daily_target_kcal
  from friend_days fd
  join public.profiles p on p.user_id = fd.fid
  left join public.user_streaks s on s.user_id = fd.fid;
end;
$$;

-- ============================================================
-- 8. Function privileges
-- ============================================================
revoke all on function public.profiles_compute_target() from public, anon, authenticated;
revoke all on function public.profiles_record_target_history() from public, anon, authenticated;

revoke all on function public.get_daily_status(date) from public, anon;
grant execute on function public.get_daily_status(date) to authenticated;
revoke all on function public.get_daily_totals(date, date) from public, anon;
grant execute on function public.get_daily_totals(date, date) to authenticated;
revoke all on function public.get_friend_summaries(date) from public, anon;
grant execute on function public.get_friend_summaries(date) to authenticated;

-- Pure helpers: callable by signed-in users (e.g. future previews); expose nothing.
revoke all on function public.activity_factor(text) from public, anon;
grant execute on function public.activity_factor(text) to authenticated;
revoke all on function public.compute_daily_target(numeric, numeric, int, text, text, text) from public, anon;
grant execute on function public.compute_daily_target(numeric, numeric, int, text, text, text) to authenticated;
revoke all on function public.macro_targets(int, int, int, int) from public, anon;
grant execute on function public.macro_targets(int, int, int, int) to authenticated;

commit;

-- ============================================================
-- Rollback notes (manual)
--   drop trigger if exists profiles_compute_target on public.profiles;
--   drop trigger if exists profiles_record_target_history on public.profiles;
--   drop function if exists public.get_daily_status(date);
--   drop function if exists public.get_daily_totals(date, date);
--   Re-run get_friend_summaries from 004_server_streaks.sql.
--   The added columns and nutrition_target_history are harmless to keep; the
--   app from this change reads them, so roll the app back too.
-- ============================================================
