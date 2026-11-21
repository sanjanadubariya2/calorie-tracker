-- Migration 023: interactions on activity events (Phase 4, Task 5).
--
--   reactions      one per person per event, from a fixed positive set
--                  (like, celebrate, support, fire); changing it replaces it.
--   comments       optional, 1-280 characters, plain text. Deletable by their
--                  author and by the owner of the event they are on.
--   reports        on a comment or a profile (username/avatar). Three distinct
--                  reporters hide a comment until a moderator reviews it; a
--                  reporter stops seeing what they reported straight away.
--                  The queue is readable by service_role only (moderation_queue,
--                  resolve_report).
--   notifications  in-app only: a reaction or comment on my event.
--
-- Who can interact: only people who can see the event (can_view_activity:
-- the owner, or an accepted friend the owner shares that kind of event with,
-- with no block either way). Nobody reacts to their own events. Everything is
-- written by SECURITY DEFINER functions that take the actor from auth.uid(), so
-- nobody can act as someone else or change another person's rows. Per-user
-- rate limits cap reactions, comments and reports.
--
-- Rollback (local): drop the functions below and the five tables.

begin;

-- ============================================================
-- 1. Visibility (mirrors get_activity_feed in 021)
-- ============================================================
create or replace function public.can_view_activity(p_viewer uuid, p_event uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.activity_events e
    left join public.social_settings s on s.user_id = e.actor_id
    where e.id = p_event and e.expires_at > now()
      and (e.actor_id = p_viewer
           or (s.share_activity
               and case e.kind
                     when 'streak_milestone' then s.share_streaks
                     when 'habit_milestone' then s.share_habits
                     when 'achievement' then s.share_achievements
                     else s.share_challenges end
               and exists (select 1 from public.friendships f where f.status = 'accepted'
                           and ((f.requester_id = p_viewer and f.addressee_id = e.actor_id)
                             or (f.requester_id = e.actor_id and f.addressee_id = p_viewer)))
               and not public.blocked_between(p_viewer, e.actor_id))));
$$;

-- ============================================================
-- 2. Rate limits
-- ============================================================
create table if not exists public.social_rate_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  at timestamptz not null default now()
);
create index if not exists social_rate_log_idx on public.social_rate_log (user_id, action, at desc);
alter table public.social_rate_log enable row level security;
revoke all on table public.social_rate_log from anon, authenticated;

-- Records one action and raises P0429 if the user went over p_max in p_window.
create or replace function public.social_rate_check(p_user uuid, p_action text, p_max int, p_window interval)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('social_rate:' || p_user || ':' || p_action, 0));
  if (select count(*) from public.social_rate_log r
      where r.user_id = p_user and r.action = p_action and r.at > now() - p_window) >= p_max then
    raise exception 'Too many requests. Try again in a little while.' using errcode = 'P0429';
  end if;
  insert into public.social_rate_log (user_id, action) values (p_user, p_action);
  delete from public.social_rate_log r where r.user_id = p_user and r.action = p_action and r.at < now() - interval '1 day';
end;
$$;

-- ============================================================
-- 3. Tables
-- ============================================================
create table if not exists public.activity_reactions (
  event_id uuid not null references public.activity_events(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  reaction text not null check (reaction in ('like', 'celebrate', 'support', 'fire')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)                 -- one reaction per person per event
);
create index if not exists activity_reactions_user_idx on public.activity_reactions (user_id);

-- Plain text, 1-280 characters, at most 4 lines, no control characters.
create or replace function public.comment_body_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null
     and p = btrim(p)
     and char_length(p) between 1 and 280
     and p !~ '[\x01-\x09\x0b-\x1f\x7f]'
     and coalesce(array_length(string_to_array(p, E'\n'), 1), 1) <= 4;
$$;

create table if not exists public.activity_comments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.activity_events(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (public.comment_body_ok(body)),
  status text not null default 'visible' check (status in ('visible', 'hidden', 'removed')),
  created_at timestamptz not null default now()
);
create index if not exists activity_comments_event_idx on public.activity_comments (event_id, created_at);
create index if not exists activity_comments_author_idx on public.activity_comments (author_id, created_at desc);

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_kind text not null check (target_kind in ('comment', 'profile')),
  comment_id uuid references public.activity_comments(id) on delete set null,
  target_user_id uuid references auth.users(id) on delete set null,
  snapshot text check (char_length(snapshot) <= 300),         -- what was reported, kept for review
  reason text not null check (reason in ('spam', 'harassment', 'inappropriate', 'other')),
  note text check (note is null or char_length(note) <= 200),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text check (reviewed_by is null or char_length(reviewed_by) <= 80)
);
create unique index if not exists content_reports_comment_once
  on public.content_reports (reporter_id, comment_id) where target_kind = 'comment' and comment_id is not null;
create unique index if not exists content_reports_profile_once
  on public.content_reports (reporter_id, target_user_id) where target_kind = 'profile' and status = 'open';
create index if not exists content_reports_open_idx on public.content_reports (created_at) where status = 'open';

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('reaction', 'comment')),
  event_id uuid not null references public.activity_events(id) on delete cascade,
  comment_id uuid references public.activity_comments(id) on delete cascade,
  reaction text check (reaction in ('like', 'celebrate', 'support', 'fire')),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (recipient_id <> actor_id),
  check ((kind = 'comment') = (comment_id is not null))
);
-- A changed reaction updates its notification instead of sending another.
create unique index if not exists notifications_reaction_once
  on public.notifications (recipient_id, actor_id, event_id) where kind = 'reaction';
create index if not exists notifications_recipient_idx on public.notifications (recipient_id, created_at desc);

-- Read-only to their owners; every write goes through the functions below.
alter table public.activity_reactions enable row level security;
alter table public.activity_comments enable row level security;
alter table public.content_reports enable row level security;
alter table public.notifications enable row level security;
revoke all on table public.activity_reactions, public.activity_comments, public.content_reports,
  public.notifications from anon, authenticated;
grant select on table public.activity_reactions, public.activity_comments, public.content_reports,
  public.notifications to authenticated;

drop policy if exists "Own reactions" on public.activity_reactions;
create policy "Own reactions" on public.activity_reactions for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "Own comments" on public.activity_comments;
create policy "Own comments" on public.activity_comments for select to authenticated
  using (author_id = (select auth.uid()));
drop policy if exists "Own reports" on public.content_reports;
create policy "Own reports" on public.content_reports for select to authenticated
  using (reporter_id = (select auth.uid()));
drop policy if exists "Own notifications" on public.notifications;
create policy "Own notifications" on public.notifications for select to authenticated
  using (recipient_id = (select auth.uid()));

-- A block clears notifications between the two people.
create or replace function public.user_blocks_cleanup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.notifications n
  where (n.recipient_id = new.blocker_id and n.actor_id = new.blocked_id)
     or (n.recipient_id = new.blocked_id and n.actor_id = new.blocker_id);
  return null;
end;
$$;
drop trigger if exists user_blocks_cleanup on public.user_blocks;
create trigger user_blocks_cleanup after insert on public.user_blocks
  for each row execute function public.user_blocks_cleanup();

-- ============================================================
-- 4. Reactions
-- ============================================================
create or replace function public.set_reaction(p_event uuid, p_reaction text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_reaction is null or p_reaction not in ('like', 'celebrate', 'support', 'fire') then
    raise exception 'Unknown reaction' using errcode = '22023';
  end if;
  if not public.can_view_activity(v_uid, p_event) then
    raise exception 'Activity not found' using errcode = 'P0002';
  end if;
  select e.actor_id into v_owner from public.activity_events e where e.id = p_event;
  if v_owner = v_uid then
    raise exception 'You can''t react to your own activity' using errcode = '22023';
  end if;
  perform public.social_rate_check(v_uid, 'reaction', 60, interval '10 minutes');
  insert into public.activity_reactions (event_id, user_id, reaction) values (p_event, v_uid, p_reaction)
  on conflict (event_id, user_id) do update set reaction = excluded.reaction, updated_at = now()
    where public.activity_reactions.reaction <> excluded.reaction;
  insert into public.notifications (recipient_id, actor_id, kind, event_id, reaction)
  values (v_owner, v_uid, 'reaction', p_event, p_reaction)
  on conflict (recipient_id, actor_id, event_id) where kind = 'reaction'
  do update set reaction = excluded.reaction;
end;
$$;

create or replace function public.remove_reaction(p_event uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  delete from public.activity_reactions r where r.event_id = p_event and r.user_id = v_uid;
  delete from public.notifications n where n.event_id = p_event and n.actor_id = v_uid and n.kind = 'reaction';
end;
$$;

-- Counts for a page of events. Events the caller can't see are left out, and
-- so are reactions and comments from people blocked either way.
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
          where c.event_id = e.id and c.status = 'visible'
            and not public.blocked_between(v_uid, c.author_id)
            and not exists (select 1 from public.content_reports cr
                            where cr.comment_id = c.id and cr.reporter_id = v_uid))
  from unnest(coalesce(p_events, '{}')) as x(id)
  join public.activity_events e on e.id = x.id
  left join public.activity_reactions r on r.event_id = e.id and not public.blocked_between(v_uid, r.user_id)
  where public.can_view_activity(v_uid, e.id)
  group by e.id;
end;
$$;

-- ============================================================
-- 5. Comments
-- ============================================================
create or replace function public.add_comment(p_event uuid, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_body text := btrim(regexp_replace(coalesce(p_body, ''), E'\r\n?', E'\n', 'g'));
  v_owner uuid;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.comment_body_ok(v_body) then
    raise exception 'Comments are 1 to 280 characters of plain text' using errcode = '22023';
  end if;
  if not public.can_view_activity(v_uid, p_event) then
    raise exception 'Activity not found' using errcode = 'P0002';
  end if;
  perform public.social_rate_check(v_uid, 'comment_minute', 5, interval '1 minute');
  perform public.social_rate_check(v_uid, 'comment_hour', 30, interval '1 hour');
  if exists (select 1 from public.activity_comments c where c.author_id = v_uid and c.event_id = p_event
             and c.body = v_body and c.created_at > now() - interval '10 minutes') then
    raise exception 'You just posted that' using errcode = '22023';
  end if;
  if (select count(*) from public.activity_comments c where c.event_id = p_event) >= 200 then
    raise exception 'This activity has reached its comment limit' using errcode = '22023';
  end if;
  insert into public.activity_comments (event_id, author_id, body) values (p_event, v_uid, v_body)
  returning id into v_id;
  select e.actor_id into v_owner from public.activity_events e where e.id = p_event;
  if v_owner <> v_uid then
    insert into public.notifications (recipient_id, actor_id, kind, event_id, comment_id)
    values (v_owner, v_uid, 'comment', p_event, v_id);
  end if;
  return v_id;
end;
$$;

-- The author, or the owner of the event, may delete a comment.
create or replace function public.delete_comment(p_comment uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  delete from public.activity_comments c
  where c.id = p_comment
    and (c.author_id = v_uid
         or exists (select 1 from public.activity_events e where e.id = c.event_id and e.actor_id = v_uid));
  if not found then
    raise exception 'Comment not found' using errcode = 'P0002';
  end if;
end;
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
  where c.event_id = p_event and c.status = 'visible'
    and not public.blocked_between(v_uid, c.author_id)
    and not exists (select 1 from public.content_reports cr where cr.comment_id = c.id and cr.reporter_id = v_uid)
  order by c.created_at, c.id
  limit 200;
end;
$$;

-- ============================================================
-- 6. Reports and moderation
-- ============================================================
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
    select ac.id, ac.author_id, ac.body, ac.event_id into c from public.activity_comments ac where ac.id = p_target;
    if c.id is null or not public.can_view_activity(v_uid, c.event_id) or c.author_id = v_uid then
      raise exception 'Comment not found' using errcode = 'P0002';
    end if;
    insert into public.content_reports (reporter_id, target_kind, comment_id, target_user_id, snapshot, reason, note)
    values (v_uid, 'comment', c.id, c.author_id, c.body, p_reason, v_note)
    on conflict do nothing;
    -- Three different people: hidden for everyone until reviewed.
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

-- Moderator queue (service_role only).
create or replace view public.moderation_queue with (security_invoker = true) as
  select r.id, r.created_at, r.target_kind, r.reason, r.note, r.snapshot, r.comment_id, r.target_user_id,
         c.status as comment_status,
         (select count(*) from public.content_reports x
          where x.status = 'open' and x.target_kind = r.target_kind
            and x.comment_id is not distinct from r.comment_id and x.target_user_id is not distinct from r.target_user_id)
           as open_reports
  from public.content_reports r
  left join public.activity_comments c on c.id = r.comment_id
  where r.status = 'open';
revoke all on public.moderation_queue from public, anon, authenticated;
grant select on table public.content_reports, public.activity_comments to service_role;   -- the view runs as its caller
grant select on public.moderation_queue to service_role;

-- p_action: 'remove' (comment removed, reports actioned), 'restore' (comment
-- visible again, reports dismissed) or 'dismiss' (this report only).
create or replace function public.resolve_report(p_report uuid, p_action text, p_reviewer text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  select * into r from public.content_reports where id = p_report for update;
  if not found then
    raise exception 'Report not found' using errcode = 'P0002';
  end if;
  if p_action = 'remove' then
    update public.activity_comments set status = 'removed' where id = r.comment_id;
    update public.content_reports set status = 'actioned', reviewed_at = now(), reviewed_by = left(p_reviewer, 80)
    where status = 'open' and (id = p_report or (r.comment_id is not null and comment_id = r.comment_id));
  elsif p_action = 'restore' then
    update public.activity_comments set status = 'visible' where id = r.comment_id and status = 'hidden';
    update public.content_reports set status = 'dismissed', reviewed_at = now(), reviewed_by = left(p_reviewer, 80)
    where status = 'open' and (id = p_report or (r.comment_id is not null and comment_id = r.comment_id));
  elsif p_action = 'dismiss' then
    update public.content_reports set status = 'dismissed', reviewed_at = now(), reviewed_by = left(p_reviewer, 80)
    where id = p_report;
  else
    raise exception 'Unknown action' using errcode = '22023';
  end if;
end;
$$;

-- ============================================================
-- 7. Notifications
-- ============================================================
create or replace function public.get_notifications(p_limit int default 30)
returns table (id uuid, kind text, actor_id uuid, actor_username text, actor_avatar_url text, reaction text,
               event_id uuid, event_kind text, event_payload jsonb, comment_preview text, created_at timestamptz,
               is_read boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return query
  select n.id, n.kind, n.actor_id, p.username, p.avatar_url, n.reaction, n.event_id, e.kind, e.payload,
         case when n.kind = 'comment' then left(c.body, 80) end, n.created_at, n.read_at is not null
  from public.notifications n
  join public.activity_events e on e.id = n.event_id
  left join public.profiles p on p.user_id = n.actor_id
  left join public.activity_comments c on c.id = n.comment_id
  where n.recipient_id = v_uid
    and not public.blocked_between(v_uid, n.actor_id)
    and (n.kind <> 'comment' or c.status = 'visible')
    and exists (select 1 from public.friendships f where f.status = 'accepted'
                and ((f.requester_id = v_uid and f.addressee_id = n.actor_id)
                  or (f.requester_id = n.actor_id and f.addressee_id = v_uid)))
  order by n.created_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
end;
$$;

create or replace function public.get_unread_notification_count()
returns int language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return (select count(*)::int from public.get_notifications(100) n where not n.is_read);
end;
$$;

-- Marks the given notifications (or all, when null) as read. Only the caller's.
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  update public.notifications n set read_at = now()
  where n.recipient_id = auth.uid() and n.read_at is null and (p_ids is null or n.id = any(p_ids));
end;
$$;

-- ============================================================
-- 8. Privileges
-- ============================================================
revoke all on function public.can_view_activity(uuid, uuid) from public, anon, authenticated;
revoke all on function public.social_rate_check(uuid, text, int, interval) from public, anon, authenticated;
revoke all on function public.comment_body_ok(text) from public, anon;
revoke all on function public.user_blocks_cleanup() from public, anon, authenticated;
revoke all on function public.set_reaction(uuid, text) from public, anon;
revoke all on function public.remove_reaction(uuid) from public, anon;
revoke all on function public.get_activity_interactions(uuid[]) from public, anon;
revoke all on function public.add_comment(uuid, text) from public, anon;
revoke all on function public.delete_comment(uuid) from public, anon;
revoke all on function public.get_comments(uuid) from public, anon;
revoke all on function public.report_content(text, uuid, text, text) from public, anon;
revoke all on function public.resolve_report(uuid, text, text) from public, anon, authenticated;
revoke all on function public.get_notifications(int) from public, anon;
revoke all on function public.get_unread_notification_count() from public, anon;
revoke all on function public.mark_notifications_read(uuid[]) from public, anon;

grant execute on function public.comment_body_ok(text) to authenticated;          -- table CHECK
grant execute on function public.set_reaction(uuid, text) to authenticated;
grant execute on function public.remove_reaction(uuid) to authenticated;
grant execute on function public.get_activity_interactions(uuid[]) to authenticated;
grant execute on function public.add_comment(uuid, text) to authenticated;
grant execute on function public.delete_comment(uuid) to authenticated;
grant execute on function public.get_comments(uuid) to authenticated;
grant execute on function public.report_content(text, uuid, text, text) to authenticated;
grant execute on function public.resolve_report(uuid, text, text) to service_role;
grant execute on function public.get_notifications(int) to authenticated;
grant execute on function public.get_unread_notification_count() to authenticated;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

commit;
