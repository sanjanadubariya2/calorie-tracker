-- Migration 024: achievements (Phase 4, Task 4).
--
-- Definitions are curated rows; user_achievements records each unlock once
-- (primary key), written only by evaluate_achievements(), which recomputes
-- every metric from server data. Unlocks are never revoked: a missed day or a
-- broken streak takes nothing away, and "Back on track" rewards returning.
--
-- Honest activity only
--   * A logged day counts towards achievements only if a log for it was
--     created on that day or the next (in the user's time zone; UTC-12..+14
--     when it is unknown). Logs entered weeks later still count for the
--     existing streak display (migration 004), but they cannot unlock anything.
--   * food_logs.created_at is now set by the server for client roles (it was
--     writable by clients, which would have let a backdated log pass as
--     on time). This also protects the challenge late-log cutoff in 022.
--   * Check-ins are the self-reported, once-a-day ones from 022; challenge
--     completions and reactions are server records (022, 023).
--
-- Unlocks after this migration are announced in the activity feed
-- (kind 'achievement', idempotent) and shown once in a celebration (seen_at).
-- Existing history is backfilled silently: no feed posts, no celebrations.
--
-- Rollback (local): drop the triggers and functions below and the two tables;
-- drop trigger food_logs_server_created_at.

begin;

-- ============================================================
-- 1. created_at belongs to the server
-- ============================================================
create or replace function public.food_logs_server_created_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.created_at := now();
    else
      new.created_at := old.created_at;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists food_logs_server_created_at on public.food_logs;
create trigger food_logs_server_created_at before insert or update on public.food_logs
  for each row execute function public.food_logs_server_created_at();

-- ============================================================
-- 2. Definitions and records
-- ============================================================
create table if not exists public.achievement_definitions (
  code text primary key check (code ~ '^[a-z0-9_]{2,40}$'),
  title text not null check (char_length(title) between 1 and 60),
  description text not null check (char_length(description) <= 200),
  category text not null check (category in ('logging', 'consistency', 'habits', 'challenges', 'social')),
  icon text not null check (char_length(icon) <= 8),
  metric text not null check (metric in ('logged_days', 'days_in_window', 'comeback', 'checkin_days',
                                         'challenges_completed', 'challenge_week_run', 'reactions_given',
                                         'reactions_received')),
  threshold int not null check (threshold >= 1),
  window_days int check (window_days is null or window_days between 1 and 60),
  sort smallint not null default 100,
  active boolean not null default true,
  check ((metric = 'days_in_window') = (window_days is not null)),
  check (window_days is null or threshold <= window_days)
);

insert into public.achievement_definitions (code, title, description, category, icon, metric, threshold, window_days, sort)
values
  ('first_day_logged', 'First meal logged', 'Log your first meal or snack.', 'logging', '🍽️', 'logged_days', 1, null, 10),
  ('first_week', 'First consistent week', 'Log meals on 5 days within a 7-day stretch.', 'consistency', '🌱',
   'days_in_window', 5, 7, 20),
  ('consistency_7', '7-day consistency', 'Log meals 7 days in a row.', 'consistency', '🔥', 'days_in_window', 7, 7, 30),
  ('consistency_30', '30-day consistency', 'Log meals on 25 days within a 30-day stretch. Days off are fine.',
   'consistency', '🏆', 'days_in_window', 25, 30, 40),
  ('logged_50', '50 days logged', 'Log meals on 50 different days.', 'logging', '📅', 'logged_days', 50, null, 50),
  ('logged_100', '100 days logged', 'Log meals on 100 different days.', 'logging', '💯', 'logged_days', 100, null, 60),
  ('comeback', 'Back on track', 'Pick logging back up after a few days off.', 'consistency', '🌤️', 'comeback', 1, null, 70),
  ('first_checkin', 'First habit check-in', 'Check in to a habit challenge.', 'habits', '✅', 'checkin_days', 1, null, 80),
  ('checkins_10', 'Habit builder', 'Check in to habit challenges on 10 days.', 'habits', '💧', 'checkin_days', 10, null, 90),
  ('first_challenge', 'First challenge completed', 'Complete a challenge.', 'challenges', '🎯',
   'challenges_completed', 1, null, 100),
  ('five_challenges', '5 challenges completed', 'Complete five challenges.', 'challenges', '🏅',
   'challenges_completed', 5, null, 110),
  ('challenge_weeks_3', 'Challenge regular', 'Complete a challenge in 3 weeks in a row.', 'challenges', '📆',
   'challenge_week_run', 3, null, 120),
  ('first_encouragement', 'First encouragement', 'React to a friend''s milestone.', 'social', '👏',
   'reactions_given', 1, null, 130),
  ('encourager_25', 'Encourager', 'Cheer on friends'' milestones 25 times.', 'social', '🤝', 'reactions_given', 25, null, 140),
  ('encouraged_10', 'Cheered on', 'Receive 10 reactions from friends.', 'social', '🎉', 'reactions_received', 10, null, 150)
on conflict (code) do update set title = excluded.title, description = excluded.description, category = excluded.category,
  icon = excluded.icon, metric = excluded.metric, threshold = excluded.threshold, window_days = excluded.window_days,
  sort = excluded.sort;

alter table public.achievement_definitions enable row level security;
revoke all on table public.achievement_definitions from anon, authenticated;
grant select on table public.achievement_definitions to authenticated;
drop policy if exists "Definitions are readable" on public.achievement_definitions;
create policy "Definitions are readable" on public.achievement_definitions for select to authenticated using (true);

create table if not exists public.user_achievements (
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null references public.achievement_definitions(code),
  unlocked_at timestamptz not null default now(),
  seen_at timestamptz,
  primary key (user_id, code)                  -- each achievement is unlocked once
);
alter table public.user_achievements enable row level security;
revoke all on table public.user_achievements from anon, authenticated;
grant select on table public.user_achievements to authenticated;
drop policy if exists "Own achievements" on public.user_achievements;
create policy "Own achievements" on public.user_achievements for select to authenticated
  using (user_id = (select auth.uid()));

-- ============================================================
-- 3. Metrics (server data only)
-- ============================================================
-- Days with a log created on that day or the next, in the user's calendar.
create or replace function public.achievement_logged_days(p_user uuid)
returns setof date language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
  v_max date;
begin
  select p.timezone into v_tz from public.profiles p where p.user_id = p_user;
  if v_tz is not null and not public.is_valid_timezone(v_tz) then
    v_tz := null;
  end if;
  select b.today_max into v_max from public.user_today_bounds(p_user) b;
  return query
  select distinct l.logged_date
  from public.food_logs l
  where l.user_id = p_user and l.logged_date <= v_max
    and case when v_tz is not null
          then l.logged_date between (l.created_at at time zone v_tz)::date - 1 and (l.created_at at time zone v_tz)::date
          else l.logged_date between ((l.created_at at time zone 'utc') - interval '12 hours')::date - 1
                                 and ((l.created_at at time zone 'utc') + interval '14 hours')::date
        end
  order by 1;
end;
$$;

-- All metric values for one user, as a jsonb map (metric or "days_in_window:N").
-- p_current_windows: windows end today (progress) instead of the best ever (unlock).
create or replace function public.achievement_metrics(p_user uuid, p_current_windows boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_days date[];
  v_today date;
  m jsonb := '{}';
  w int;
begin
  select array_agg(d order by d) into v_days from public.achievement_logged_days(p_user) d;
  v_days := coalesce(v_days, '{}');
  select b.today_max into v_today from public.user_today_bounds(p_user) b;
  m := m || jsonb_build_object('logged_days', cardinality(v_days));

  for w in select distinct window_days from public.achievement_definitions where window_days is not null loop
    m := m || jsonb_build_object('days_in_window:' || w,
      case when p_current_windows then
        (select count(*) from unnest(v_days) d where d between v_today - w + 1 and v_today)
      else coalesce((
        select max(n) from (
          select count(*) over (order by (d - date '2000-01-01') range between (w - 1) preceding and current row) as n
          from unnest(v_days) d) x), 0)
      end);
  end loop;

  -- A return after 3 or more days without logs.
  m := m || jsonb_build_object('comeback', (
    select count(*) from (select d - lag(d) over (order by d) as gap from unnest(v_days) d) g where g.gap >= 4));

  m := m || jsonb_build_object('checkin_days', (
    select count(distinct k.day) from public.challenge_checkins k where k.user_id = p_user));

  m := m || jsonb_build_object('challenges_completed', (
    select count(*) from public.challenge_participants cp where cp.user_id = p_user and cp.status = 'completed'));

  -- Longest run of consecutive ISO weeks with a completed challenge (by end date).
  m := m || jsonb_build_object('challenge_week_run', coalesce((
    select max(len) from (
      select count(*) as len from (
        select wk, wk - (row_number() over (order by wk))::int * 7 as grp
        from (select distinct date_trunc('week', ch.ends_on)::date as wk
              from public.challenge_participants cp join public.challenges ch on ch.id = cp.challenge_id
              where cp.user_id = p_user and cp.status = 'completed') weeks) g
      group by grp) runs), 0));

  -- Reactions on friends' events (one per event at most, own events excluded by 023).
  m := m || jsonb_build_object('reactions_given', (
    select count(*) from public.activity_reactions r where r.user_id = p_user));
  m := m || jsonb_build_object('reactions_received', (
    select count(*) from public.activity_reactions r join public.activity_events e on e.id = r.event_id
    where e.actor_id = p_user and r.user_id <> p_user));
  return m;
end;
$$;

create or replace function public.achievement_value(p_metrics jsonb, d public.achievement_definitions)
returns int language sql immutable set search_path = '' as $$
  select coalesce((p_metrics ->> case when d.metric = 'days_in_window' then 'days_in_window:' || d.window_days
                                      else d.metric end)::int, 0);
$$;

-- ============================================================
-- 4. Awarding
-- ============================================================
-- Unlocks whatever the user has reached. Idempotent and safe under concurrency:
-- a per-user advisory lock serializes evaluations, and the primary key makes a
-- second unlock of the same code a no-op. Announces only rows it inserted.
create or replace function public.evaluate_achievements(p_user uuid, p_announce boolean default true)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_metrics jsonb;
  d public.achievement_definitions;
  v_new int := 0;
begin
  if p_user is null or not exists (select 1 from auth.users u where u.id = p_user) then
    return 0;                                     -- e.g. during account deletion cascades
  end if;
  perform pg_advisory_xact_lock(hashtextextended('achievements:' || p_user, 0));
  if not exists (select 1 from public.achievement_definitions ad where ad.active
                 and not exists (select 1 from public.user_achievements ua where ua.user_id = p_user and ua.code = ad.code)) then
    return 0;                                     -- everything unlocked already
  end if;
  v_metrics := public.achievement_metrics(p_user, false);
  for d in select * from public.achievement_definitions ad where ad.active
           and not exists (select 1 from public.user_achievements ua where ua.user_id = p_user and ua.code = ad.code)
           order by ad.sort loop
    if public.achievement_value(v_metrics, d) >= d.threshold then
      insert into public.user_achievements (user_id, code, seen_at)
      values (p_user, d.code, case when p_announce then null else now() end)
      on conflict do nothing;
      if found then
        v_new := v_new + 1;
        if p_announce then
          perform public.record_activity(p_user, 'achievement', d.code,
            jsonb_build_object('code', d.code, 'title', d.title));
        end if;
      end if;
    end if;
  end loop;
  return v_new;
end;
$$;

-- Triggers: meal logs (insert and date changes), check-ins, challenge
-- completions, reactions (both the reactor and the event owner).
create or replace function public.achievements_on_food_logs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  u uuid;
begin
  for u in select distinct n.user_id from new_rows n order by 1 loop
    perform public.evaluate_achievements(u);
  end loop;
  return null;
end;
$$;
drop trigger if exists achievements_on_food_logs_insert on public.food_logs;
create trigger achievements_on_food_logs_insert after insert on public.food_logs
  referencing new table as new_rows for each statement execute function public.achievements_on_food_logs();
drop trigger if exists achievements_on_food_logs_update on public.food_logs;
create trigger achievements_on_food_logs_update after update on public.food_logs
  referencing new table as new_rows for each statement execute function public.achievements_on_food_logs();

create or replace function public.achievements_on_row()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'challenge_checkins' then
    perform public.evaluate_achievements(new.user_id);
  elsif tg_table_name = 'challenge_participants' then
    if new.status = 'completed' and old.status is distinct from 'completed' then
      perform public.evaluate_achievements(new.user_id);
    end if;
  elsif tg_table_name = 'activity_reactions' then
    perform public.evaluate_achievements(new.user_id);
    perform public.evaluate_achievements((select e.actor_id from public.activity_events e where e.id = new.event_id));
  end if;
  return null;
end;
$$;
drop trigger if exists achievements_on_checkin on public.challenge_checkins;
create trigger achievements_on_checkin after insert on public.challenge_checkins
  for each row execute function public.achievements_on_row();
drop trigger if exists achievements_on_completion on public.challenge_participants;
create trigger achievements_on_completion after update of status on public.challenge_participants
  for each row execute function public.achievements_on_row();
drop trigger if exists achievements_on_reaction on public.activity_reactions;
create trigger achievements_on_reaction after insert or update of reaction on public.activity_reactions
  for each row execute function public.achievements_on_row();

-- ============================================================
-- 5. Reads
-- ============================================================
-- Every achievement with my unlock time, and progress towards the locked ones
-- (window metrics: the current window ending today).
create or replace function public.get_my_achievements()
returns table (code text, title text, description text, category text, icon text, threshold int,
               window_days int, unlocked_at timestamptz, seen_at timestamptz, progress int, sort smallint)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_metrics jsonb;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  v_metrics := public.achievement_metrics(v_uid, true);
  return query
  select d.code, d.title, d.description, d.category, d.icon, d.threshold, d.window_days, ua.unlocked_at, ua.seen_at,
         case when ua.code is not null then d.threshold
              else least(public.achievement_value(v_metrics, d), d.threshold) end,
         d.sort
  from public.achievement_definitions d
  left join public.user_achievements ua on ua.user_id = v_uid and ua.code = d.code
  where d.active or ua.code is not null
  order by d.sort, d.code;
end;
$$;

-- Streaks for the achievements screen. The meal-logging streak is the existing
-- one from 004 (with its decay rule); the others come from challenge data.
create or replace function public.get_streak_summary()
returns table (current_streak int, longest_streak int, last_logged_date date, logged_days int,
               checkins_this_week int, challenge_week_run int, challenges_completed int)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_today date;
  v_metrics jsonb;
  v_run int := 0;
  wk date;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select b.today_min into v_today from public.user_today_bounds(v_uid) b;
  v_metrics := public.achievement_metrics(v_uid, true);
  -- Current run of challenge weeks: this week (if already completed) or last week, backwards.
  wk := date_trunc('week', v_today)::date;
  if not exists (select 1 from public.challenge_participants cp join public.challenges ch on ch.id = cp.challenge_id
                 where cp.user_id = v_uid and cp.status = 'completed' and date_trunc('week', ch.ends_on)::date = wk) then
    wk := wk - 7;
  end if;
  while exists (select 1 from public.challenge_participants cp join public.challenges ch on ch.id = cp.challenge_id
                where cp.user_id = v_uid and cp.status = 'completed' and date_trunc('week', ch.ends_on)::date = wk) loop
    v_run := v_run + 1;
    wk := wk - 7;
  end loop;
  return query
  select public.effective_current_streak(s.current_streak, s.last_logged_date, v_today),
         coalesce(s.longest_streak, 0), s.last_logged_date,
         (v_metrics ->> 'logged_days')::int,
         (select count(distinct k.day)::int from public.challenge_checkins k
          where k.user_id = v_uid and k.day >= date_trunc('week', v_today)::date),
         v_run,
         (v_metrics ->> 'challenges_completed')::int
  from (select 1) x left join public.user_streaks s on s.user_id = v_uid;
end;
$$;

-- Marks unlocks as celebrated, so each celebration shows once.
create or replace function public.mark_achievements_seen(p_codes text[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  update public.user_achievements ua set seen_at = now()
  where ua.user_id = auth.uid() and ua.seen_at is null and ua.code = any(coalesce(p_codes, '{}'));
end;
$$;

-- ============================================================
-- 6. Privileges
-- ============================================================
revoke all on function public.food_logs_server_created_at() from public, anon, authenticated;
revoke all on function public.achievement_logged_days(uuid) from public, anon, authenticated;
revoke all on function public.achievement_metrics(uuid, boolean) from public, anon, authenticated;
revoke all on function public.achievement_value(jsonb, public.achievement_definitions) from public, anon, authenticated;
revoke all on function public.evaluate_achievements(uuid, boolean) from public, anon, authenticated;
revoke all on function public.achievements_on_food_logs() from public, anon, authenticated;
revoke all on function public.achievements_on_row() from public, anon, authenticated;
revoke all on function public.get_my_achievements() from public, anon;
revoke all on function public.get_streak_summary() from public, anon;
revoke all on function public.mark_achievements_seen(text[]) from public, anon;
grant execute on function public.get_my_achievements() to authenticated;
grant execute on function public.get_streak_summary() to authenticated;
grant execute on function public.mark_achievements_seen(text[]) to authenticated;

-- ============================================================
-- 7. Silent backfill of existing history
-- ============================================================
do $$
declare
  u uuid;
begin
  for u in select p.user_id from public.profiles p order by 1 loop
    perform public.evaluate_achievements(u, false);
  end loop;
end;
$$;

commit;
