-- Migration 027: Phase 4 hardening (production-readiness review).
--
-- 1. One activity policy. A logged day counts towards anything that is
--    counted, awarded or announced (streak, badges, achievements, habit
--    milestones, challenge progress, feed, notifications) only if a meal for
--    it was logged on that day or the next, in the user's time zone
--    (UTC-12..+14 when unknown). Late entries stay in the food history and
--    reports. Before: the streak (004) and challenges (022) also counted
--    entries made days later, so a backfill could announce a streak that
--    achievements (024) refused. Streak rows are recomputed once under the
--    new rule; every changed row is recorded in streak_policy_audit (old and
--    new values), and badges, achievements and feed posts already earned are
--    never taken away.
-- 2. Narrower comment audience. A comment is shown to the event's owner, its
--    author, and the author's own friends who can see the event; no longer
--    to friends of the owner who don't know the author. Event visibility and
--    blocks are enforced as before.
-- 3. Moderation without service_role. Reports are reviewed by members of the
--    content_moderator role (personal database logins, never exposed through
--    the API: the API's authenticator role is not a member). Every decision
--    is written to moderation_actions. resolve_report (023) is removed.
-- 4. Old app builds. get_friend_list replaces get_friend_summaries; the old
--    function now refuses with P0426 ("update the app") instead of answering
--    with rows an old build would render as 0 kcal.
-- 5. Retention (social_maintainer role): purges expired events, finished push
--    deliveries, rate-limit entries, old notifications and dead push tokens.
-- 6. Push monitoring: push_health() for the delivery role.
--
-- Rollback (local): see backend/docs/phase4-social-wellness.md, "Rollback".

begin;

-- ============================================================
-- 1. One activity policy
-- ============================================================
-- A log is on time when it was created on its logged day or the next one.
create or replace function public.log_on_time(p_logged date, p_created timestamptz, p_tz text)
returns boolean language sql stable set search_path = '' as $$
  select case
    when p_tz is not null and public.is_valid_timezone(p_tz) then
      p_logged between (p_created at time zone p_tz)::date - 1 and (p_created at time zone p_tz)::date
    else
      p_logged between ((p_created at time zone 'utc') - interval '12 hours')::date - 1
                   and ((p_created at time zone 'utc') + interval '14 hours')::date
  end;
$$;

-- On-time active days (any meal; optionally only some meal types).
create or replace function public.active_days(p_user uuid, p_from date default null, p_to date default null,
                                              p_meals text[] default null)
returns setof date language sql stable security definer set search_path = '' as $$
  select distinct l.logged_date
  from public.food_logs l
  left join public.profiles p on p.user_id = l.user_id
  where l.user_id = p_user
    and l.logged_date <= (select b.today_max from public.user_today_bounds(p_user) b)
    and (p_from is null or l.logged_date >= p_from)
    and (p_to is null or l.logged_date <= p_to)
    and (p_meals is null or l.meal_type = any(p_meals))
    and public.log_on_time(l.logged_date, l.created_at, p.timezone)
  order by 1;
$$;

-- 024's helper now delegates to the shared definition.
create or replace function public.achievement_logged_days(p_user uuid)
returns setof date language sql stable security definer set search_path = '' as $$
  select d from public.active_days(p_user) d;
$$;

-- 004's streak, from on-time days. Unchanged otherwise (lock, deletion guard,
-- badges as a high-water mark).
create or replace function public.recalculate_user_streak(p_user uuid, p_reset_badges boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_last date;
  v_current int := 0;
  v_longest int := 0;
begin
  if p_user is null then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('user_streak:' || p_user::text, 0));
  if not exists (select 1 from auth.users u where u.id = p_user) then
    return;
  end if;

  with days as (
    select d from public.active_days(p_user) d
  ),
  grouped as (
    select d, d - (row_number() over (order by d))::int as grp from days
  ),
  runs as (
    select max(d) as run_end, count(*)::int as len from grouped group by grp
  )
  select
    (select r.run_end from runs r order by r.run_end desc limit 1),
    coalesce((select r.len from runs r order by r.run_end desc limit 1), 0),
    coalesce((select max(r.len) from runs r), 0)
  into v_last, v_current, v_longest;

  insert into public.user_streaks as s (user_id, current_streak, last_logged_date, longest_streak, badges_earned)
  values (p_user, v_current, v_last, v_longest, public.streak_milestone_count(v_longest))
  on conflict (user_id) do update
    set current_streak = excluded.current_streak,
        last_logged_date = excluded.last_logged_date,
        longest_streak = excluded.longest_streak,
        badges_earned = case when p_reset_badges then excluded.badges_earned
                             else greatest(s.badges_earned, excluded.badges_earned) end;
end;
$$;

-- 022's challenge progress, from on-time days inside the challenge window.
create or replace function public.challenge_progress_days(p_challenge uuid, p_user uuid)
returns int language plpgsql stable security definer set search_path = '' as $$
declare
  c record;
  v_days int;
begin
  select ch.starts_on, ch.ends_on, t.metric into c
  from public.challenges ch join public.challenge_templates t on t.code = ch.template_code
  where ch.id = p_challenge;
  if not found then
    return 0;
  end if;
  if c.metric = 'logged_days' then
    select count(*) into v_days from public.active_days(p_user, c.starts_on, c.ends_on) d;
  elsif c.metric = 'breakfast_days' then
    select count(*) into v_days from public.active_days(p_user, c.starts_on, c.ends_on, array['breakfast']) d;
  elsif c.metric = 'main_meals_days' then
    select count(*) into v_days
    from public.active_days(p_user, c.starts_on, c.ends_on, array['breakfast']) b
    where b in (select d from public.active_days(p_user, c.starts_on, c.ends_on, array['lunch']) d)
      and b in (select d from public.active_days(p_user, c.starts_on, c.ends_on, array['dinner']) d);
  else
    select count(*) into v_days from public.challenge_checkins k
    where k.challenge_id = p_challenge and k.user_id = p_user and k.day between c.starts_on
      and least(c.ends_on, (select b.today_max from public.user_today_bounds(p_user) b));
  end if;
  return coalesce(v_days, 0);
end;
$$;

-- 021's habit milestones (days logged: 7, 30, 50, ...), from on-time days.
create or replace function public.food_logs_habit_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_now int;
  v_before int;
  m int;
begin
  for r in select distinct n.user_id from new_rows n order by 1 loop
    select count(*) into v_now from public.active_days(r.user_id) d;
    -- The same count without this statement's rows: only milestones crossed now are announced.
    select count(distinct l.logged_date) into v_before
    from public.food_logs l left join public.profiles p on p.user_id = l.user_id
    where l.user_id = r.user_id
      and l.id not in (select n.id from new_rows n)
      and l.logged_date <= (select b.today_max from public.user_today_bounds(r.user_id) b)
      and public.log_on_time(l.logged_date, l.created_at, p.timezone);
    foreach m in array array[7, 30, 50, 100, 200, 365] loop
      if v_before < m and v_now >= m then
        perform public.record_activity(r.user_id, 'habit_milestone', 'logged_days:' || m, jsonb_build_object('days', m));
      end if;
    end loop;
  end loop;
  return null;
end;
$$;

-- One-time recomputation, recorded. Badges never go down (high-water mark),
-- so the feed's streak announcements and achievements stay as earned.
create table if not exists public.streak_policy_audit (
  user_id uuid not null references auth.users(id) on delete cascade,
  policy text not null default 'on-time-v1',
  old_current int, old_longest int, old_last date,
  new_current int, new_longest int, new_last date,
  changed_at timestamptz not null default now(),
  primary key (user_id, policy)
);
alter table public.streak_policy_audit enable row level security;
revoke all on table public.streak_policy_audit from anon, authenticated;

do $$
declare
  u record;
  s record;
begin
  -- Statement-level user_streaks trigger (021) only announces newly reached
  -- badges; the high-water mark means this recomputation announces nothing.
  for u in select us.user_id, us.current_streak, us.longest_streak, us.last_logged_date
           from public.user_streaks us order by 1 loop
    perform public.recalculate_user_streak(u.user_id);
    select * into s from public.user_streaks where user_id = u.user_id;
    if s.current_streak is distinct from u.current_streak or s.longest_streak is distinct from u.longest_streak
       or s.last_logged_date is distinct from u.last_logged_date then
      insert into public.streak_policy_audit (user_id, old_current, old_longest, old_last, new_current, new_longest, new_last)
      values (u.user_id, u.current_streak, u.longest_streak, u.last_logged_date,
              s.current_streak, s.longest_streak, s.last_logged_date)
      on conflict do nothing;
    end if;
  end loop;
end;
$$;

-- ============================================================
-- 2. Narrower comment audience
-- ============================================================
create or replace function public.are_friends(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.friendships f where f.status = 'accepted'
                 and ((f.requester_id = p_a and f.addressee_id = p_b) or (f.requester_id = p_b and f.addressee_id = p_a)));
$$;

-- Who may read a comment: the event owner, the author, or a friend of the
-- author, provided they can see the event, and no block with the author.
create or replace function public.can_view_comment(p_viewer uuid, p_comment uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.activity_comments c join public.activity_events e on e.id = c.event_id
    where c.id = p_comment and c.status = 'visible'
      and public.can_view_activity(p_viewer, c.event_id)
      and not public.blocked_between(p_viewer, c.author_id)
      and (p_viewer = e.actor_id or p_viewer = c.author_id or public.are_friends(p_viewer, c.author_id)));
$$;

create or replace function public.get_comments(p_event uuid)
returns table (id uuid, author_id uuid, author_username text, author_avatar_url text, is_mine boolean,
               can_delete boolean, body text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.can_view_activity(v_uid, p_event) then
    raise exception 'Activity not found' using errcode = 'P0002';
  end if;
  select e.actor_id into v_owner from public.activity_events e where e.id = p_event;
  return query
  select c.id, c.author_id, p.username, p.avatar_url, c.author_id = v_uid, c.author_id = v_uid or v_owner = v_uid,
         c.body, c.created_at
  from public.activity_comments c
  left join public.profiles p on p.user_id = c.author_id
  where c.event_id = p_event
    and public.can_view_comment(v_uid, c.id)
    and not exists (select 1 from public.content_reports cr where cr.comment_id = c.id and cr.reporter_id = v_uid)
  order by c.created_at, c.id
  limit 200;
end;
$$;

create or replace function public.get_activity_interactions(p_events uuid[])
returns table (event_id uuid, like_count int, celebrate_count int, support_count int, fire_count int,
               my_reaction text, comment_count int)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if cardinality(p_events) > 50 then
    raise exception 'At most 50 events at a time' using errcode = '22023';
  end if;
  return query
  select e.id,
         count(*) filter (where r.reaction = 'like')::int,
         count(*) filter (where r.reaction = 'celebrate')::int,
         count(*) filter (where r.reaction = 'support')::int,
         count(*) filter (where r.reaction = 'fire')::int,
         max(r.reaction) filter (where r.user_id = v_uid),
         (select count(*)::int from public.activity_comments c
          where c.event_id = e.id and public.can_view_comment(v_uid, c.id)
            and not exists (select 1 from public.content_reports cr where cr.comment_id = c.id and cr.reporter_id = v_uid))
  from unnest(coalesce(p_events, '{}')) as x(id)
  join public.activity_events e on e.id = x.id
  left join public.activity_reactions r on r.event_id = e.id and not public.blocked_between(v_uid, r.user_id)
  where public.can_view_activity(v_uid, e.id)
  group by e.id;
end;
$$;

-- Reports: a comment can be reported only by someone who can read it.
create or replace function public.report_content(p_kind text, p_target uuid, p_reason text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  c record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_reason is null or p_reason not in ('spam', 'harassment', 'inappropriate', 'other') then
    raise exception 'Choose a reason' using errcode = '22023';
  end if;
  if v_note is not null and (char_length(v_note) > 200 or v_note ~ '[\x01-\x09\x0b-\x1f\x7f]') then
    raise exception 'Notes are up to 200 characters' using errcode = '22023';
  end if;
  perform public.social_rate_check(v_uid, 'report', 20, interval '1 day');
  if p_kind = 'comment' then
    select ac.id, ac.author_id, ac.body into c from public.activity_comments ac where ac.id = p_target;
    if c.id is null or c.author_id = v_uid or not public.can_view_comment(v_uid, c.id) then
      raise exception 'Comment not found' using errcode = 'P0002';
    end if;
    insert into public.content_reports (reporter_id, target_kind, comment_id, target_user_id, snapshot, reason, note)
    values (v_uid, 'comment', c.id, c.author_id, c.body, p_reason, v_note)
    on conflict do nothing;
    update public.activity_comments ac set status = 'hidden'
    where ac.id = c.id and ac.status = 'visible'
      and (select count(distinct cr.reporter_id) from public.content_reports cr
           where cr.comment_id = c.id and cr.status = 'open') >= 3;
  elsif p_kind = 'profile' then
    if p_target is null or p_target = v_uid or not exists (select 1 from auth.users u where u.id = p_target) then
      raise exception 'User not found' using errcode = 'P0002';
    end if;
    insert into public.content_reports (reporter_id, target_kind, target_user_id, snapshot, reason, note)
    select v_uid, 'profile', p_target,
           left(coalesce('@' || p.username, '') || coalesce(' avatar: ' || p.avatar_url, ''), 300), p_reason, v_note
    from (select 1) x left join public.profiles p on p.user_id = p_target
    on conflict do nothing;
  else
    raise exception 'Unknown report type' using errcode = '22023';
  end if;
end;
$$;

-- Comment notifications go to the event owner, who can read every comment;
-- the rule above is applied on read anyway.
create or replace function public.notification_visible(p_viewer uuid, n public.notifications)
returns boolean language sql stable security definer set search_path = '' as $$
  select n.recipient_id = p_viewer
     and (n.actor_id is null or not public.blocked_between(p_viewer, n.actor_id))
     and case
       when n.kind = 'reaction' then public.are_friends(p_viewer, n.actor_id)
       when n.kind = 'comment' then public.are_friends(p_viewer, n.actor_id)
                                    and public.can_view_comment(p_viewer, n.comment_id)
       when n.kind = 'friend_milestone' then public.can_view_activity(p_viewer, n.event_id)
       when n.kind = 'friend_request' then exists (select 1 from public.friendships f
                                                   where f.id = n.friendship_id and f.addressee_id = p_viewer)
       when n.kind = 'friend_accepted' then exists (select 1 from public.friendships f
                                                    where f.id = n.friendship_id and f.status = 'accepted')
       when n.kind in ('challenge_invite', 'challenge_starting', 'challenge_completed') then
         exists (select 1 from public.challenge_participants cp
                 where cp.challenge_id = n.challenge_id and cp.user_id = p_viewer)
       else true end;
$$;

-- ============================================================
-- 3. Moderation
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'content_moderator') then
    create role content_moderator nologin;      -- a group: moderators log in as their own roles
  end if;
end;
$$;

create table if not exists public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.content_reports(id) on delete set null,
  target_kind text not null,
  comment_id uuid,
  target_user_id uuid,
  action text not null,
  moderator text not null,                      -- the database login that decided
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now()
);
alter table public.moderation_actions enable row level security;
revoke all on table public.moderation_actions from anon, authenticated;

drop function if exists public.resolve_report(uuid, text, text);

-- p_action, comment reports: 'remove' (comment removed for everyone), 'restore'
-- (shown again, reports dismissed), 'dismiss' (this report only).
-- Profile reports: 'clear_avatar', 'reset_username' (to user_<id>; the person
-- can choose a new one), 'dismiss'.
create or replace function public.moderate_report(p_report uuid, p_action text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.content_reports;
  v_mod text := session_user;
begin
  -- USAGE, not MEMBER: the role's creator holds an admin-only membership
  -- (PostgreSQL 16) and must not count as a moderator without a real grant.
  if not pg_has_role(session_user, 'content_moderator', 'usage') then
    raise exception 'Moderators only' using errcode = '42501';
  end if;
  select * into r from public.content_reports where id = p_report for update;
  if not found then
    raise exception 'Report not found' using errcode = 'P0002';
  end if;
  if r.status <> 'open' then
    raise exception 'Report already resolved' using errcode = '55000';
  end if;
  if r.target_kind = 'comment' and p_action in ('remove', 'restore') then
    update public.activity_comments set status = case when p_action = 'remove' then 'removed' else 'visible' end
    where id = r.comment_id;
    update public.content_reports set status = case when p_action = 'remove' then 'actioned' else 'dismissed' end,
      reviewed_at = now(), reviewed_by = left(v_mod, 80)
    where status = 'open' and (id = p_report or (r.comment_id is not null and comment_id = r.comment_id));
  elsif r.target_kind = 'profile' and p_action in ('clear_avatar', 'reset_username') then
    if p_action = 'clear_avatar' then
      update public.profiles set avatar_url = null where user_id = r.target_user_id;
    else
      update public.profiles set username = 'user_' || left(replace(r.target_user_id::text, '-', ''), 12)
      where user_id = r.target_user_id;
    end if;
    update public.content_reports set status = 'actioned', reviewed_at = now(), reviewed_by = left(v_mod, 80)
    where status = 'open' and target_kind = 'profile' and target_user_id = r.target_user_id;
  elsif p_action = 'dismiss' then
    update public.content_reports set status = 'dismissed', reviewed_at = now(), reviewed_by = left(v_mod, 80)
    where id = p_report;
  else
    raise exception 'Action % does not apply to a % report', p_action, r.target_kind using errcode = '22023';
  end if;
  insert into public.moderation_actions (report_id, target_kind, comment_id, target_user_id, action, moderator, note)
  values (p_report, r.target_kind, r.comment_id, r.target_user_id, p_action, v_mod, left(p_note, 500));
end;
$$;

revoke all on public.moderation_queue from service_role;
revoke select on table public.content_reports, public.activity_comments from service_role;
grant select on table public.content_reports, public.activity_comments to content_moderator;   -- the view runs as its caller
grant select on public.moderation_queue to content_moderator;
grant select on table public.moderation_actions to content_moderator;
grant usage on schema public to content_moderator;
-- RLS: moderators read every report, comment and decision (writes only via moderate_report).
drop policy if exists "Moderators read reports" on public.content_reports;
create policy "Moderators read reports" on public.content_reports for select to content_moderator using (true);
drop policy if exists "Moderators read comments" on public.activity_comments;
create policy "Moderators read comments" on public.activity_comments for select to content_moderator using (true);
drop policy if exists "Moderators read decisions" on public.moderation_actions;
create policy "Moderators read decisions" on public.moderation_actions for select to content_moderator using (true);

-- ============================================================
-- 4. Old app builds
-- ============================================================
create or replace function public.get_friend_list()
returns table (user_id uuid, username text, avatar_url text, current_streak int)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return query
  select p.user_id, p.username, p.avatar_url,
         case when ss.share_activity and ss.share_streaks
              then public.effective_current_streak(s.current_streak, s.last_logged_date,
                     (select b.today_min from public.user_today_bounds(p.user_id) b)) end
  from public.friendships f
  join public.profiles p on p.user_id = case when f.requester_id = v_uid then f.addressee_id else f.requester_id end
  left join public.user_streaks s on s.user_id = p.user_id
  left join public.social_settings ss on ss.user_id = p.user_id
  where f.status = 'accepted' and (f.requester_id = v_uid or f.addressee_id = v_uid)
    and not public.blocked_between(v_uid, p.user_id)
  order by lower(coalesce(p.username, '')), p.user_id;
end;
$$;

-- Builds before Phase 4 call this and draw calorie bars from it. Refusing
-- makes them show their "couldn't load friends" message instead of zeros.
create or replace function public.get_friend_summaries(p_today date)
returns table (user_id uuid, username text, avatar_url text, current_streak int)
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'This version of the app is no longer supported. Please update.' using errcode = 'P0426';
end;
$$;

-- ============================================================
-- 5. Retention
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'social_maintainer') then
    create role social_maintainer login noinherit connection limit 2;
  end if;
end;
$$;
grant usage on schema public to social_maintainer;

-- Deletes only what has ended:
--   activity_events  past expires_at, unless a comment on it has an open report
--                    (cascades to its reactions, comments and notifications)
--   push_outbox      sent/failed/skipped rows older than 30 days (never pending
--                    or sending); pending rows for disabled devices, or over a
--                    day old (undeliverable), are closed as skipped first
--   social_rate_log  entries older than 2 days (the longest window is 1 day)
--   notifications    read and older than 90 days, or any older than 365 days
--   push_tokens      disabled more than 30 days ago are deleted; devices not
--                    seen for 90 days are disabled ('stale')
create or replace function public.purge_social_data(p_dry_run boolean default false)
returns table (item text, affected bigint)
language plpgsql security definer set search_path = '' as $$
declare
  n bigint;
begin
  -- activity_events
  if p_dry_run then
    select count(*) into n from public.activity_events e where e.expires_at < now()
      and not exists (select 1 from public.activity_comments c join public.content_reports r on r.comment_id = c.id
                      where c.event_id = e.id and r.status = 'open');
  else
    with d as (delete from public.activity_events e where e.expires_at < now()
      and not exists (select 1 from public.activity_comments c join public.content_reports r on r.comment_id = c.id
                      where c.event_id = e.id and r.status = 'open') returning 1)
    select count(*) into n from d;
  end if;
  item := 'expired activity events'; affected := n; return next;

  -- push_outbox: pending rows that can never be sent are closed first: the
  -- device is gone, or the push is over a day old (the worker skips those too).
  if not p_dry_run then
    update public.push_outbox o set status = 'skipped', last_error = 'device disabled'
    from public.push_tokens t where t.id = o.token_id and t.disabled_at is not null and o.status = 'pending';
    update public.push_outbox set status = 'skipped', last_error = 'stale'
    where status = 'pending' and created_at < now() - interval '1 day';
  end if;
  if p_dry_run then
    select count(*) into n from public.push_outbox
    where status in ('sent', 'failed', 'skipped') and created_at < now() - interval '30 days';
  else
    with d as (delete from public.push_outbox
               where status in ('sent', 'failed', 'skipped') and created_at < now() - interval '30 days' returning 1)
    select count(*) into n from d;
  end if;
  item := 'finished push deliveries'; affected := n; return next;

  if p_dry_run then
    select count(*) into n from public.social_rate_log where at < now() - interval '2 days';
  else
    with d as (delete from public.social_rate_log where at < now() - interval '2 days' returning 1)
    select count(*) into n from d;
  end if;
  item := 'rate-limit entries'; affected := n; return next;

  if p_dry_run then
    select count(*) into n from public.notifications
    where (read_at is not null and created_at < now() - interval '90 days') or created_at < now() - interval '365 days';
  else
    with d as (delete from public.notifications
               where (read_at is not null and created_at < now() - interval '90 days')
                  or created_at < now() - interval '365 days' returning 1)
    select count(*) into n from d;
  end if;
  item := 'old notifications'; affected := n; return next;

  if p_dry_run then
    select count(*) into n from public.push_tokens where disabled_at is null and last_seen_at < now() - interval '90 days';
  else
    with d as (update public.push_tokens set disabled_at = now(), disabled_reason = 'stale'
               where disabled_at is null and last_seen_at < now() - interval '90 days' returning 1)
    select count(*) into n from d;
  end if;
  item := 'stale devices disabled'; affected := n; return next;

  if p_dry_run then
    select count(*) into n from public.push_tokens where disabled_at < now() - interval '30 days';
  else
    -- Their outbox rows are finished (skipped above), so the cascade removes only history.
    with d as (delete from public.push_tokens where disabled_at < now() - interval '30 days' returning 1)
    select count(*) into n from d;
  end if;
  item := 'disabled devices deleted'; affected := n; return next;
end;
$$;

-- ============================================================
-- 6. Push monitoring
-- ============================================================
create or replace function public.push_health()
returns table (pending bigint, oldest_pending_minutes int, stuck_sending bigint, sent_24h bigint, failed_24h bigint,
               devices_disabled_24h bigint, active_devices bigint)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from public.push_outbox where status = 'pending'),
    (select coalesce(extract(epoch from now() - min(created_at))::int / 60, 0) from public.push_outbox where status = 'pending'),
    (select count(*) from public.push_outbox where status = 'sending' and claimed_at < now() - interval '10 minutes'),
    (select count(*) from public.push_outbox where status = 'sent' and sent_at > now() - interval '1 day'),
    (select count(*) from public.push_outbox where status = 'failed' and created_at > now() - interval '1 day'),
    (select count(*) from public.push_tokens where disabled_at > now() - interval '1 day'),
    (select count(*) from public.push_tokens where disabled_at is null);
$$;

-- ============================================================
-- 7. Privileges
-- ============================================================
revoke all on function public.log_on_time(date, timestamptz, text) from public, anon, authenticated;
revoke all on function public.active_days(uuid, date, date, text[]) from public, anon, authenticated;
revoke all on function public.are_friends(uuid, uuid) from public, anon, authenticated;
revoke all on function public.can_view_comment(uuid, uuid) from public, anon, authenticated;
revoke all on function public.moderate_report(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.get_friend_list() from public, anon;
revoke all on function public.get_friend_summaries(date) from public, anon;
revoke all on function public.purge_social_data(boolean) from public, anon, authenticated;
revoke all on function public.push_health() from public, anon, authenticated;
grant execute on function public.moderate_report(uuid, text, text) to content_moderator;
grant execute on function public.get_friend_list() to authenticated;
grant execute on function public.get_friend_summaries(date) to authenticated;
grant execute on function public.purge_social_data(boolean) to social_maintainer;
grant execute on function public.push_health() to notification_sender;

commit;
