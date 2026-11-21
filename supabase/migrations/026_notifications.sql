-- Migration 026: notification system (Phase 4, Task 6).
--
-- Extends the notifications table from 023 (reactions, comments) with:
--   friend_request, friend_accepted        friendships trigger
--   challenge_invite, challenge_completed  challenge_participants trigger
--   challenge_starting                     the day before / day of a challenge you
--                                          joined in advance (generated when you
--                                          open notifications, and by a daily job)
--   achievement_unlocked                   user_achievements trigger (not the
--                                          silent backfill)
--   friend_milestone                       a friend's streak milestone of 7+ days
--                                          that they share with you
-- Never for food logs or routine actions, and no reminders to log.
--
-- Every insert passes notifications_gate (BEFORE INSERT): it drops the row if
-- the recipient turned that category off, or if either person blocked the
-- other. Duplicates are impossible: (recipient, kind, dedupe_key) is unique.
-- Reads re-check visibility (blocks, unfriending, sharing settings, cancelled
-- requests) so stale rows never leak.
--
-- Push (opt-in, off by default): only direct, personal kinds (friend requests,
-- acceptances, challenge invitations and start reminders, comments) are
-- queued in push_outbox, at most 20 a day per person, and only to registered
-- Expo push tokens. Lock-screen text never includes comment text or health
-- data. A separate role, notification_sender, delivers the queue
-- (backend: python -m app.cli push-deliver); clients cannot read it.
--
-- Rollback (local): drop the triggers/functions below, push_outbox,
-- push_tokens, notification_preferences, the added columns, and restore the
-- 023 checks.

begin;

-- ============================================================
-- 1. Table changes
-- ============================================================
alter table public.notifications alter column event_id drop not null;
alter table public.notifications alter column actor_id drop not null;
alter table public.notifications add column if not exists challenge_id uuid references public.challenges(id) on delete cascade;
alter table public.notifications add column if not exists friendship_id uuid references public.friendships(id) on delete cascade;
alter table public.notifications add column if not exists dedupe_key text check (dedupe_key is null or char_length(dedupe_key) <= 120);
alter table public.notifications add column if not exists payload jsonb not null default '{}';

create or replace function public.notification_payload_ok(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object' and pg_column_size(p) <= 512
     and not exists (select 1 from jsonb_object_keys(p) k where k not in ('title', 'days', 'code', 'starts_on'));
$$;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications drop constraint if exists notifications_check;
alter table public.notifications drop constraint if exists notifications_check1;
alter table public.notifications drop constraint if exists notifications_kind_ok;
alter table public.notifications drop constraint if exists notifications_not_self;
alter table public.notifications drop constraint if exists notifications_targets;
alter table public.notifications drop constraint if exists notifications_payload_ok;
alter table public.notifications add constraint notifications_kind_ok check (kind in (
  'reaction', 'comment', 'friend_request', 'friend_accepted', 'challenge_invite', 'challenge_starting',
  'challenge_completed', 'achievement_unlocked', 'friend_milestone'));
alter table public.notifications add constraint notifications_not_self
  check (actor_id is null or actor_id <> recipient_id);
alter table public.notifications add constraint notifications_targets check (
  ((kind = 'comment') = (comment_id is not null))
  and (kind not in ('reaction', 'comment', 'friend_milestone') or (event_id is not null and actor_id is not null))
  and (kind not in ('friend_request', 'friend_accepted') or (friendship_id is not null and actor_id is not null))
  and (kind not in ('challenge_invite', 'challenge_starting', 'challenge_completed') or challenge_id is not null));
alter table public.notifications add constraint notifications_payload_ok check (public.notification_payload_ok(payload));

create unique index if not exists notifications_dedupe
  on public.notifications (recipient_id, kind, dedupe_key) where dedupe_key is not null;
create index if not exists notifications_recipient_unread_idx
  on public.notifications (recipient_id) where read_at is null;

-- ============================================================
-- 2. Preferences
-- ============================================================
create table if not exists public.notification_preferences (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  friend_requests boolean not null default true,
  challenges boolean not null default true,
  achievements boolean not null default true,
  reactions boolean not null default true,
  comments boolean not null default true,
  friend_milestones boolean not null default true,
  push_enabled boolean not null default false           -- push is opt-in
);
alter table public.notification_preferences enable row level security;
revoke all on table public.notification_preferences from anon, authenticated;
grant select, delete on table public.notification_preferences to authenticated;
grant insert (friend_requests, challenges, achievements, reactions, comments, friend_milestones, push_enabled),
      update (friend_requests, challenges, achievements, reactions, comments, friend_milestones, push_enabled)
  on table public.notification_preferences to authenticated;
drop policy if exists "Own notification preferences" on public.notification_preferences;
create policy "Own notification preferences" on public.notification_preferences for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create or replace function public.notification_category(p_kind text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_kind in ('friend_request', 'friend_accepted') then 'friend_requests'
    when p_kind in ('challenge_invite', 'challenge_starting', 'challenge_completed') then 'challenges'
    when p_kind = 'achievement_unlocked' then 'achievements'
    when p_kind = 'reaction' then 'reactions'
    when p_kind = 'comment' then 'comments'
    else 'friend_milestones' end;
$$;

create or replace function public.notification_wanted(p_user uuid, p_kind text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case public.notification_category(p_kind)
      when 'friend_requests' then np.friend_requests
      when 'challenges' then np.challenges
      when 'achievements' then np.achievements
      when 'reactions' then np.reactions
      when 'comments' then np.comments
      else np.friend_milestones end
    from public.notification_preferences np where np.user_id = p_user), true);
$$;

-- ============================================================
-- 3. Gate: preferences and blocks, for every insert
-- ============================================================
create or replace function public.notifications_gate()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from auth.users u where u.id = new.recipient_id)
     or not public.notification_wanted(new.recipient_id, new.kind)
     or (new.actor_id is not null and public.blocked_between(new.recipient_id, new.actor_id)) then
    return null;
  end if;
  return new;
end;
$$;
drop trigger if exists notifications_gate on public.notifications;
create trigger notifications_gate before insert on public.notifications
  for each row execute function public.notifications_gate();

-- Internal helper for the generators below. Duplicates are no-ops.
create or replace function public.notify(p_recipient uuid, p_kind text, p_dedupe text, p_actor uuid default null,
  p_event uuid default null, p_challenge uuid default null, p_friendship uuid default null, p_payload jsonb default '{}')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_recipient is null or p_recipient = p_actor then
    return;
  end if;
  insert into public.notifications (recipient_id, actor_id, kind, event_id, challenge_id, friendship_id, dedupe_key, payload)
  values (p_recipient, p_actor, p_kind, p_event, p_challenge, p_friendship, p_dedupe, coalesce(p_payload, '{}'))
  on conflict (recipient_id, kind, dedupe_key) where dedupe_key is not null do nothing;
end;
$$;

-- ============================================================
-- 4. Generators
-- ============================================================
create or replace function public.notifications_on_friendship()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform public.notify(new.addressee_id, 'friend_request', 'friendship:' || new.id, new.requester_id,
                          p_friendship => new.id);
  elsif tg_op = 'UPDATE' and new.status = 'accepted' and old.status is distinct from 'accepted' then
    perform public.notify(new.requester_id, 'friend_accepted', 'friendship:' || new.id, new.addressee_id,
                          p_friendship => new.id);
    update public.notifications set read_at = coalesce(read_at, now())      -- answered
    where recipient_id = new.addressee_id and kind = 'friend_request' and friendship_id = new.id;
  end if;
  return null;
end;
$$;
drop trigger if exists notifications_on_friendship on public.friendships;
create trigger notifications_on_friendship after insert or update of status on public.friendships
  for each row execute function public.notifications_on_friendship();

create or replace function public.notifications_on_participant()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_title text := (select t.title from public.challenges ch join public.challenge_templates t on t.code = ch.template_code
                   where ch.id = new.challenge_id);
begin
  if tg_op = 'INSERT' and new.status = 'invited' then
    perform public.notify(new.user_id, 'challenge_invite', 'challenge:' || new.challenge_id, new.invited_by,
                          p_challenge => new.challenge_id, p_payload => jsonb_build_object('title', v_title));
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    if old.status = 'invited' then                                          -- answered
      update public.notifications set read_at = coalesce(read_at, now())
      where recipient_id = new.user_id and kind = 'challenge_invite' and challenge_id = new.challenge_id;
    end if;
    if new.status = 'completed' then
      perform public.notify(new.user_id, 'challenge_completed', 'challenge:' || new.challenge_id,
                            p_challenge => new.challenge_id, p_payload => jsonb_build_object('title', v_title));
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists notifications_on_participant on public.challenge_participants;
create trigger notifications_on_participant after insert or update of status on public.challenge_participants
  for each row execute function public.notifications_on_participant();

-- Unlocks after 024's silent backfill (which sets seen_at) only.
create or replace function public.notifications_on_achievement()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.seen_at is null then
    perform public.notify(new.user_id, 'achievement_unlocked', new.code, p_payload =>
      (select jsonb_build_object('title', d.title, 'code', d.code) from public.achievement_definitions d where d.code = new.code));
  end if;
  return null;
end;
$$;
drop trigger if exists notifications_on_achievement on public.user_achievements;
create trigger notifications_on_achievement after insert on public.user_achievements
  for each row execute function public.notifications_on_achievement();

-- A friend's shared streak milestone (7+ days), to friends who can see it.
create or replace function public.notifications_on_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  f uuid;
begin
  if new.kind = 'streak_milestone' and coalesce((new.payload ->> 'days')::int, 0) >= 7 then
    for f in select case when fr.requester_id = new.actor_id then fr.addressee_id else fr.requester_id end
             from public.friendships fr
             where fr.status = 'accepted' and (fr.requester_id = new.actor_id or fr.addressee_id = new.actor_id) loop
      if public.can_view_activity(f, new.id) then
        perform public.notify(f, 'friend_milestone', 'event:' || new.id, new.actor_id, p_event => new.id,
                              p_payload => jsonb_build_object('days', (new.payload ->> 'days')::int));
      end if;
    end loop;
  end if;
  return null;
end;
$$;
drop trigger if exists notifications_on_activity on public.activity_events;
create trigger notifications_on_activity after insert on public.activity_events
  for each row execute function public.notifications_on_activity();

-- Challenge start reminders for people who joined before the start day.
create or replace function public.challenge_start_reminders(p_user uuid default null)
returns int language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select cp.user_id, ch.id, ch.starts_on, t.title
    from public.challenge_participants cp
    join public.challenges ch on ch.id = cp.challenge_id
    join public.challenge_templates t on t.code = ch.template_code
    where cp.status = 'active' and ch.kind <> 'app'
      and (p_user is null or cp.user_id = p_user)
      and ch.starts_on > cp.joined_at::date
      and ch.starts_on between (select b.today_min from public.user_today_bounds(cp.user_id) b)
                           and (select b.today_max from public.user_today_bounds(cp.user_id) b) + 1
  loop
    perform public.notify(r.user_id, 'challenge_starting', 'challenge:' || r.id, p_challenge => r.id,
                          p_payload => jsonb_build_object('title', r.title, 'starts_on', r.starts_on));
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ============================================================
-- 5. Visibility on read
-- ============================================================
create or replace function public.notification_visible(p_viewer uuid, n public.notifications)
returns boolean language sql stable security definer set search_path = '' as $$
  select n.recipient_id = p_viewer
     and (n.actor_id is null or not public.blocked_between(p_viewer, n.actor_id))
     and case
       when n.kind in ('reaction', 'comment') then
         exists (select 1 from public.friendships f where f.status = 'accepted'
                 and ((f.requester_id = p_viewer and f.addressee_id = n.actor_id)
                   or (f.requester_id = n.actor_id and f.addressee_id = p_viewer)))
         and (n.kind <> 'comment' or exists (select 1 from public.activity_comments c
                                              where c.id = n.comment_id and c.status = 'visible'))
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

drop function if exists public.get_notifications(int);
create or replace function public.get_notifications(p_before_at timestamptz default null, p_before_id uuid default null,
                                                    p_limit int default 30)
returns table (id uuid, kind text, actor_id uuid, actor_username text, actor_avatar_url text, reaction text,
               event_id uuid, event_kind text, event_payload jsonb, challenge_id uuid, friendship_id uuid,
               payload jsonb, comment_preview text, created_at timestamptz, is_read boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_before_id is not null and p_before_at is null then
    raise exception 'p_before_at is required with p_before_id' using errcode = '22023';
  end if;
  perform public.challenge_start_reminders(v_uid);
  return query
  select n.id, n.kind, n.actor_id, p.username, p.avatar_url, n.reaction, n.event_id, e.kind, e.payload,
         n.challenge_id, n.friendship_id, n.payload,
         case when n.kind = 'comment' then left(c.body, 80) end, n.created_at, n.read_at is not null
  from public.notifications n
  left join public.activity_events e on e.id = n.event_id
  left join public.profiles p on p.user_id = n.actor_id
  left join public.activity_comments c on c.id = n.comment_id
  where n.recipient_id = v_uid
    and (p_before_at is null
         or (n.created_at, n.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
    and public.notification_visible(v_uid, n)
  order by n.created_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 50);
end;
$$;

create or replace function public.get_unread_notification_count()
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  perform public.challenge_start_reminders(v_uid);
  return (select count(*)::int from (
    select 1 from public.notifications n
    where n.recipient_id = v_uid and n.read_at is null and public.notification_visible(v_uid, n)
    limit 100) x);
end;
$$;

-- ============================================================
-- 6. Push tokens and outbox
-- ============================================================
create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique check (token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$'),
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_reason text check (disabled_reason is null or char_length(disabled_reason) <= 80)
);
create index if not exists push_tokens_user_idx on public.push_tokens (user_id) where disabled_at is null;
alter table public.push_tokens enable row level security;
revoke all on table public.push_tokens from anon, authenticated;
grant select on table public.push_tokens to authenticated;
drop policy if exists "Own push tokens" on public.push_tokens;
create policy "Own push tokens" on public.push_tokens for select to authenticated using (user_id = (select auth.uid()));

create table if not exists public.push_outbox (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  token_id uuid not null references public.push_tokens(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  ticket_id text check (ticket_id is null or char_length(ticket_id) <= 100),
  last_error text check (last_error is null or char_length(last_error) <= 200),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  receipt_checked_at timestamptz,
  unique (notification_id, token_id)                       -- one push per notification per device
);
create index if not exists push_outbox_due_idx on public.push_outbox (next_attempt_at) where status = 'pending';
create index if not exists push_outbox_user_idx on public.push_outbox (user_id, created_at desc);
alter table public.push_outbox enable row level security;
revoke all on table public.push_outbox from anon, authenticated;

create or replace function public.push_kind(p_kind text)
returns boolean language sql immutable set search_path = '' as $$
  select p_kind in ('friend_request', 'friend_accepted', 'challenge_invite', 'challenge_starting', 'comment');
$$;

create or replace function public.notifications_push_enqueue()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if public.push_kind(new.kind)
     and exists (select 1 from public.notification_preferences np where np.user_id = new.recipient_id and np.push_enabled)
     and (select count(*) from public.push_outbox o
          where o.user_id = new.recipient_id and o.created_at > now() - interval '1 day') < 20 then
    insert into public.push_outbox (notification_id, token_id, user_id)
    select new.id, t.id, new.recipient_id from public.push_tokens t
    where t.user_id = new.recipient_id and t.disabled_at is null
    on conflict do nothing;
  end if;
  return null;
end;
$$;
drop trigger if exists notifications_push_enqueue on public.notifications;
create trigger notifications_push_enqueue after insert on public.notifications
  for each row execute function public.notifications_push_enqueue();

-- Registers this device for the caller. A token that moved to another account
-- (shared device, new sign-in) follows the person now signed in.
create or replace function public.register_push_token(p_token text, p_platform text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$'
     or p_platform is null or p_platform not in ('ios', 'android') then
    raise exception 'Invalid push token' using errcode = '22023';
  end if;
  perform public.social_rate_check(v_uid, 'push_register', 20, interval '1 day');
  insert into public.push_tokens (user_id, token, platform) values (v_uid, p_token, p_platform)
  on conflict (token) do update set user_id = v_uid, platform = excluded.platform, last_seen_at = now(),
    disabled_at = null, disabled_reason = null;
  -- Keep at most 5 active devices.
  update public.push_tokens set disabled_at = now(), disabled_reason = 'replaced'
  where user_id = v_uid and disabled_at is null
    and id not in (select id from public.push_tokens where user_id = v_uid and disabled_at is null
                   order by last_seen_at desc limit 5);
end;
$$;

create or replace function public.unregister_push_token(p_token text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  delete from public.push_tokens where token = p_token and user_id = auth.uid();
end;
$$;

-- Lock-screen text: names and challenge titles only; never comment text.
create or replace function public.push_message(n public.notifications, out title text, out body text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_who text := coalesce('@' || (select p.username from public.profiles p where p.user_id = n.actor_id), 'A friend');
  v_title text := coalesce(n.payload ->> 'title', 'a challenge');
begin
  case n.kind
    when 'friend_request' then title := 'New friend request'; body := v_who || ' wants to be friends.';
    when 'friend_accepted' then title := 'Friend request accepted'; body := v_who || ' accepted your request.';
    when 'challenge_invite' then title := 'Challenge invitation'; body := v_who || ' invited you to “' || v_title || '”.';
    when 'challenge_starting' then title := 'Challenge starting soon'; body := '“' || v_title || '” starts soon.';
    when 'comment' then title := 'New comment'; body := v_who || ' commented on your milestone.';
    else title := 'Calorie Tracker'; body := 'You have a new notification.';
  end case;
end;
$$;

-- Worker API (notification_sender role). Claims due pushes, skipping ones that
-- were already read in the app, are no longer visible, or are over a day old.
create or replace function public.claim_push_batch(p_limit int default 100)
returns table (outbox_id uuid, token text, title text, body text, data jsonb)
language plpgsql security definer set search_path = '' as $$
begin
  update public.push_outbox set status = 'pending'
  where status = 'sending' and claimed_at < now() - interval '10 minutes';     -- a crashed worker
  update public.push_outbox o set status = 'skipped', last_error = 'stale or read'
  from public.notifications n
  where n.id = o.notification_id and o.status = 'pending'
    and (n.read_at is not null or o.created_at < now() - interval '1 day'
         or not public.notification_visible(n.recipient_id, n));
  return query
  with due as (
    select o.id from public.push_outbox o
    join public.push_tokens t on t.id = o.token_id and t.disabled_at is null
    where o.status = 'pending' and o.next_attempt_at <= now()
    order by o.created_at
    limit least(greatest(coalesce(p_limit, 100), 1), 100)
    for update of o skip locked
  ), claimed as (
    update public.push_outbox o set status = 'sending', attempts = o.attempts + 1, claimed_at = now()
    from due where o.id = due.id
    returning o.id, o.notification_id, o.token_id
  )
  select c.id, t.token, m.title, m.body,
         jsonb_strip_nulls(jsonb_build_object('notification_id', n.id, 'kind', n.kind, 'event_id', n.event_id,
                                              'challenge_id', n.challenge_id))
  from claimed c
  join public.push_tokens t on t.id = c.token_id
  join public.notifications n on n.id = c.notification_id
  cross join lateral public.push_message(n) m;
end;
$$;

-- p_error: Expo's error code ('DeviceNotRegistered', 'MessageRateExceeded', ...) or a transport error.
create or replace function public.record_push_result(p_outbox uuid, p_ok boolean, p_ticket text default null,
                                                     p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  o public.push_outbox;
begin
  select * into o from public.push_outbox where id = p_outbox for update;
  if not found then
    return;
  end if;
  if p_ok then
    update public.push_outbox set status = 'sent', ticket_id = left(p_ticket, 100), sent_at = now(), last_error = null
    where id = p_outbox;
  elsif p_error = 'DeviceNotRegistered' then
    update public.push_tokens set disabled_at = now(), disabled_reason = 'DeviceNotRegistered' where id = o.token_id;
    update public.push_outbox set status = 'failed', last_error = 'DeviceNotRegistered' where id = p_outbox;
  elsif o.attempts >= 5 or p_error in ('InvalidCredentials', 'MessageTooBig') then
    update public.push_outbox set status = 'failed', last_error = left(p_error, 200) where id = p_outbox;
  else
    update public.push_outbox set status = 'pending', last_error = left(p_error, 200),
      next_attempt_at = now() + make_interval(mins => power(2, o.attempts)::int)
    where id = p_outbox;
  end if;
end;
$$;

create or replace function public.pending_push_receipts(p_limit int default 300)
returns table (outbox_id uuid, ticket_id text)
language sql stable security definer set search_path = '' as $$
  select o.id, o.ticket_id from public.push_outbox o
  where o.status = 'sent' and o.ticket_id is not null and o.receipt_checked_at is null
    and o.sent_at < now() - interval '15 minutes' and o.sent_at > now() - interval '1 day'
  order by o.sent_at limit least(greatest(coalesce(p_limit, 300), 1), 1000);
$$;

create or replace function public.record_push_receipt(p_outbox uuid, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_token uuid;
begin
  update public.push_outbox set receipt_checked_at = now(),
    status = case when p_ok then status else 'failed' end,
    last_error = case when p_ok then last_error else left(p_error, 200) end
  where id = p_outbox returning token_id into v_token;
  if not p_ok and p_error = 'DeviceNotRegistered' then
    update public.push_tokens set disabled_at = now(), disabled_reason = 'DeviceNotRegistered' where id = v_token;
  end if;
end;
$$;

-- Daily job: start reminders for everyone (in-app ones are also made on read).
create or replace function public.enqueue_challenge_reminders()
returns int language sql security definer set search_path = '' as $$
  select public.challenge_start_reminders(null);
$$;

-- ============================================================
-- 7. The delivery role
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'notification_sender') then
    create role notification_sender login noinherit connection limit 5;
  end if;
end;
$$;
-- Set its password outside version control:
--   alter role notification_sender password '<generated secret>';
grant usage on schema public to notification_sender;

-- ============================================================
-- 8. Privileges
-- ============================================================
revoke all on function public.notification_payload_ok(jsonb) from public, anon;
revoke all on function public.notification_category(text) from public, anon, authenticated;
revoke all on function public.notification_wanted(uuid, text) from public, anon, authenticated;
revoke all on function public.notifications_gate() from public, anon, authenticated;
revoke all on function public.notify(uuid, text, text, uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.notifications_on_friendship() from public, anon, authenticated;
revoke all on function public.notifications_on_participant() from public, anon, authenticated;
revoke all on function public.notifications_on_achievement() from public, anon, authenticated;
revoke all on function public.notifications_on_activity() from public, anon, authenticated;
revoke all on function public.challenge_start_reminders(uuid) from public, anon, authenticated;
revoke all on function public.notification_visible(uuid, public.notifications) from public, anon, authenticated;
revoke all on function public.get_notifications(timestamptz, uuid, int) from public, anon;
revoke all on function public.get_unread_notification_count() from public, anon;
revoke all on function public.push_kind(text) from public, anon, authenticated;
revoke all on function public.notifications_push_enqueue() from public, anon, authenticated;
revoke all on function public.register_push_token(text, text) from public, anon;
revoke all on function public.unregister_push_token(text) from public, anon;
revoke all on function public.push_message(public.notifications) from public, anon, authenticated;
revoke all on function public.claim_push_batch(int) from public, anon, authenticated;
revoke all on function public.record_push_result(uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function public.pending_push_receipts(int) from public, anon, authenticated;
revoke all on function public.record_push_receipt(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.enqueue_challenge_reminders() from public, anon, authenticated;

grant execute on function public.notification_payload_ok(jsonb) to authenticated;             -- table CHECK
grant execute on function public.get_notifications(timestamptz, uuid, int) to authenticated;
grant execute on function public.get_unread_notification_count() to authenticated;
grant execute on function public.register_push_token(text, text) to authenticated;
grant execute on function public.unregister_push_token(text) to authenticated;
grant execute on function public.claim_push_batch(int) to notification_sender;
grant execute on function public.record_push_result(uuid, boolean, text, text) to notification_sender;
grant execute on function public.pending_push_receipts(int) to notification_sender;
grant execute on function public.record_push_receipt(uuid, boolean, text) to notification_sender;
grant execute on function public.enqueue_challenge_reminders() to notification_sender;

commit;
