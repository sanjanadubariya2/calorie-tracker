-- Calorie Tracker — social authorization & privacy hardening
-- Run after 002_social.sql. Safe to re-run. Does not modify or delete any
-- existing friendship, profile, or food log row.
--
-- Fixes:
--   1. INSERT on friendships no longer lets a user create an *accepted*
--      friendship (status was unconstrained by the old policy).
--   2. Direct UPDATE on friendships is gone. The old policy let the addressee
--      rewrite requester_id and so befriend any third user. Accepting and
--      declining now go through respond_to_friend_request().
--   3. get_friend_summaries() only accepts a date that can be "today"
--      somewhere on Earth, so it can no longer be replayed over past dates to
--      rebuild a friend's daily calorie history.
--   4. Hardening: username format check, friendship lookup indexes,
--      search_path = '' on every SECURITY DEFINER function, explicit
--      EXECUTE grants, least-privilege table grants on friendships.
--
-- Error codes raised by the functions below (clients branch on these):
--   28000  caller is not authenticated
--   22023  missing/invalid argument (incl. a date outside the allowed window)
--   P0002  request not found, or the caller is not the party allowed to act
--          on it (deliberately indistinguishable, so ids can't be probed)
--   55000  request exists but is no longer pending

begin;

-- ============================================================
-- 1. Friendships: least-privilege grants
--
-- RLS decides *which rows* a role may touch; grants decide *which operations*
-- it may attempt at all. Supabase grants ALL on public tables to anon and
-- authenticated by default, so tighten that here:
--   * anon: nothing.
--   * authenticated: SELECT and DELETE (still filtered by RLS), and INSERT on
--     requester_id/addressee_id only — id, status and created_at always come
--     from their defaults, so a client cannot supply status = 'accepted'.
--   * no UPDATE: status changes only happen inside the functions below.
-- ============================================================
revoke all on table public.friendships from anon;
revoke all on table public.friendships from authenticated;
grant select, delete on table public.friendships to authenticated;
grant insert (requester_id, addressee_id) on table public.friendships to authenticated;

-- ============================================================
-- 2. Friendships: RLS policies
-- ============================================================

-- Requests can only be created by their requester, only as pending, and never
-- to oneself. The status check backs up the column grant above: if someone
-- later re-grants INSERT on every column, this policy still holds.
-- The no_self_friendship CHECK and the friendships_pair_idx unique index from
-- 002 stay in force and are not touched.
drop policy if exists "Users can send friend requests" on public.friendships;
create policy "Users can send friend requests"
  on public.friendships for insert
  to authenticated
  with check (
    (select auth.uid()) = requester_id
    and status = 'pending'
    and requester_id <> addressee_id
  );

-- Replaced by respond_to_friend_request(). With no UPDATE policy and no UPDATE
-- grant, direct updates are refused twice over.
drop policy if exists "Users can respond to friend requests" on public.friendships;

-- Unchanged from 002, listed here so the full policy set is visible in one place:
--   "Users can view their own friendships"  SELECT  requester or addressee
--   "Users can remove friendships"          DELETE  requester or addressee
--     (used for unfriending; also lets either side drop a pending request)

-- ============================================================
-- 3. Friendships: lookup indexes
--
-- friendships_pair_idx is on least()/greatest() expressions, which can't serve
-- "where addressee_id = me and status = 'pending'" or the RLS filter
-- "requester_id = me or addressee_id = me".
-- ============================================================
create index if not exists friendships_addressee_status_idx
  on public.friendships (addressee_id, status);
create index if not exists friendships_requester_status_idx
  on public.friendships (requester_id, status);

-- ============================================================
-- 4. Profiles: username format
--
-- Mirrors USERNAME_PATTERN in lib/social.ts. The app stores usernames
-- lower-cased; enforcing that here also keeps them consistent with the
-- lower(username) unique index.
--
-- Added NOT VALID first so new writes are checked immediately, then validated
-- only if every existing row passes. If any legacy row fails, the migration
-- still succeeds and raises a WARNING listing the count. Fix those rows and run
-- `alter table public.profiles validate constraint profiles_username_format;`.
-- Until then, a non-conforming user can't save their profile until they pick a
-- valid username, because CHECK applies to every UPDATE of the row.
-- ============================================================
alter table public.profiles drop constraint if exists profiles_username_format;
alter table public.profiles
  add constraint profiles_username_format
  check (username is null or username ~ '^[a-z0-9_]{3,20}$')
  not valid;

do $$
declare
  v_bad int;
begin
  select count(*) into v_bad
  from public.profiles
  where username is not null and username !~ '^[a-z0-9_]{3,20}$';

  if v_bad = 0 then
    alter table public.profiles validate constraint profiles_username_format;
  else
    raise warning
      'profiles_username_format left NOT VALID: % existing username(s) do not match ^[a-z0-9_]{3,20}$',
      v_bad;
  end if;
end;
$$;

-- ============================================================
-- 5. respond_to_friend_request — accept or decline an incoming request
--
-- Only the addressee may act, only while the request is pending, and only the
-- status column changes. Declining deletes the row instead of storing a
-- 'declined' status. That keeps the 002 schema and its status CHECK unchanged,
-- and lets the two people connect later. The trade-off is that a declined
-- requester can ask again; there is no block list.
-- ============================================================
create or replace function public.respond_to_friend_request(p_request_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_req public.friendships%rowtype;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_request_id is null or p_accept is null then
    raise exception 'p_request_id and p_accept are required' using errcode = '22023';
  end if;

  -- Lock the row so a concurrent cancel/decline can't interleave.
  select * into v_req
  from public.friendships f
  where f.id = p_request_id
  for update;

  if not found or v_req.addressee_id <> v_uid then
    raise exception 'Friend request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'Friend request is no longer pending' using errcode = '55000';
  end if;

  if p_accept then
    update public.friendships f
    set status = 'accepted'
    where f.id = v_req.id;
  else
    delete from public.friendships f
    where f.id = v_req.id;
  end if;
end;
$$;

-- ============================================================
-- 6. cancel_friend_request — requester withdraws a pending request
-- ============================================================
create or replace function public.cancel_friend_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_req public.friendships%rowtype;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_request_id is null then
    raise exception 'p_request_id is required' using errcode = '22023';
  end if;

  select * into v_req
  from public.friendships f
  where f.id = p_request_id
  for update;

  if not found or v_req.requester_id <> v_uid then
    raise exception 'Friend request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'Friend request is no longer pending' using errcode = '55000';
  end if;

  delete from public.friendships f
  where f.id = v_req.id;
end;
$$;

-- ============================================================
-- 7. get_friend_summaries — clamp the date
--
-- Date semantics: the app works in the *device's local* calendar date.
-- food_logs.logged_date is written from the client's local date
-- (app/modals/add-food.tsx), and friends.tsx passes its local today as p_today.
-- The server's current_date is UTC, so it can't simply be substituted.
--
-- Civil time zones run from UTC-12 to UTC+14, so at any instant the local date
-- anywhere is between (UTC now - 12h)::date and (UTC now + 14h)::date. That
-- window is usually 2 days and never more than 3. Any p_today outside it can't
-- be a real "today" and is refused with 22023.
--
-- What a friend can still learn: today_kcal for the dates in that window, plus
-- the existing 7-day average. That matches what the feature shows. Someone
-- who calls the function every day can still record the values going forward;
-- that's inherent to sharing daily totals and can't be prevented server-side.
--
-- The output columns are unchanged: aggregates only, never individual
-- entries, age, height, weight, gender or goal.
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
    coalesce(s.current_streak, 0)::int,
    p.daily_target_kcal
  from friends
  join public.profiles p on p.user_id = friends.fid
  left join public.user_streaks s on s.user_id = friends.fid;
end;
$$;

-- ============================================================
-- 8. Request listings
--
-- profiles is owner-only, so the other party's username/avatar can only come
-- from a definer function. Both listings use LEFT JOIN so a request from or to
-- someone with no profile row still appears, and can be declined or cancelled
-- instead of silently blocking the pair forever.
-- ============================================================
create or replace function public.get_pending_requests()
returns table (friendship_id uuid, user_id uuid, username text, avatar_url text)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.requester_id, p.username, p.avatar_url
  from public.friendships f
  left join public.profiles p on p.user_id = f.requester_id
  where f.status = 'pending'
    and f.addressee_id = auth.uid()
  order by f.created_at desc;
$$;

create or replace function public.get_outgoing_requests()
returns table (friendship_id uuid, user_id uuid, username text, avatar_url text)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.addressee_id, p.username, p.avatar_url
  from public.friendships f
  left join public.profiles p on p.user_id = f.addressee_id
  where f.status = 'pending'
    and f.requester_id = auth.uid()
  order by f.created_at desc;
$$;

-- Same behaviour as 002; only the search_path hardening and qualified names change.
create or replace function public.find_profile_by_username(p_username text)
returns table (user_id uuid, username text, avatar_url text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, p.username, p.avatar_url
  from public.profiles p
  where lower(p.username) = lower(trim(p_username))
    and p.user_id <> auth.uid()
  limit 1;
$$;

-- ============================================================
-- 9. Function execution privileges
--
-- Supabase's default privileges grant EXECUTE on new functions to anon, so
-- every social function is explicitly revoked from public/anon and granted
-- to authenticated only.
-- ============================================================
revoke all on function public.respond_to_friend_request(uuid, boolean) from public, anon;
revoke all on function public.cancel_friend_request(uuid) from public, anon;
revoke all on function public.get_friend_summaries(date) from public, anon;
revoke all on function public.get_pending_requests() from public, anon;
revoke all on function public.get_outgoing_requests() from public, anon;
revoke all on function public.find_profile_by_username(text) from public, anon;

grant execute on function public.respond_to_friend_request(uuid, boolean) to authenticated;
grant execute on function public.cancel_friend_request(uuid) to authenticated;
grant execute on function public.get_friend_summaries(date) to authenticated;
grant execute on function public.get_pending_requests() to authenticated;
grant execute on function public.get_outgoing_requests() to authenticated;
grant execute on function public.find_profile_by_username(text) to authenticated;

commit;

-- ============================================================
-- Rollback notes (manual — do not run as part of this migration)
--
-- Rolling back reopens the vulnerabilities above, so prefer a forward fix.
-- If a rollback is ever unavoidable:
--   1. Re-run supabase/migrations/002_social.sql. It recreates the old INSERT
--      and UPDATE policies and the three original functions (create or replace).
--   2. grant update, insert on table public.friendships to authenticated;
--   3. drop function if exists public.respond_to_friend_request(uuid, boolean);
--      drop function if exists public.cancel_friend_request(uuid);
--      drop function if exists public.get_outgoing_requests();
--   4. Optional: alter table public.profiles drop constraint profiles_username_format;
--      drop index if exists public.friendships_addressee_status_idx;
--      drop index if exists public.friendships_requester_status_idx;
-- The app code from this change calls the new functions, so a database
-- rollback also needs the matching frontend rollback.
-- ============================================================
