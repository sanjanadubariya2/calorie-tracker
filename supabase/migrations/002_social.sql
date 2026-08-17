-- Calorie Tracker — usernames, avatars, and friends
-- Run this in the Supabase SQL Editor after 001_init.sql. Safe to re-run.

-- ============================================================
-- Profiles: public identity fields
-- ============================================================
alter table profiles add column if not exists username text;
alter table profiles add column if not exists avatar_url text;

-- Usernames are case-insensitively unique, so @Sanjana and @sanjana can't both exist.
create unique index if not exists profiles_username_lower_idx
  on profiles (lower(username));

-- ============================================================
-- Friendships
-- ============================================================
create table if not exists friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid references auth.users(id) on delete cascade not null,
  addressee_id uuid references auth.users(id) on delete cascade not null,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  constraint no_self_friendship check (requester_id <> addressee_id)
);

-- One row per pair regardless of who asked first, so A→B blocks a later B→A.
create unique index if not exists friendships_pair_idx
  on friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

alter table friendships enable row level security;

drop policy if exists "Users can view their own friendships" on friendships;
create policy "Users can view their own friendships"
  on friendships for select
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

drop policy if exists "Users can send friend requests" on friendships;
create policy "Users can send friend requests"
  on friendships for insert
  with check (auth.uid() = requester_id);

-- Only the person who received the request may accept it.
drop policy if exists "Users can respond to friend requests" on friendships;
create policy "Users can respond to friend requests"
  on friendships for update
  using (auth.uid() = addressee_id)
  with check (auth.uid() = addressee_id);

drop policy if exists "Users can remove friendships" on friendships;
create policy "Users can remove friendships"
  on friendships for delete
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

-- ============================================================
-- Friend-facing reads
--
-- `profiles` stays locked to its owner — it holds age and weight. Friends see
-- each other only through these SECURITY DEFINER functions, which return
-- daily totals and never individual food entries.
-- ============================================================

create or replace function public.find_profile_by_username(p_username text)
returns table (user_id uuid, username text, avatar_url text)
language sql
security definer
set search_path = public
as $$
  select p.user_id, p.username, p.avatar_url
  from profiles p
  where lower(p.username) = lower(trim(p_username))
    and p.user_id <> auth.uid()
  limit 1;
$$;

-- p_today is the caller's local date; the server's current_date can be a day
-- off for anyone away from UTC.
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
language sql
security definer
set search_path = public
as $$
  with friends as (
    select case
             when f.requester_id = auth.uid() then f.addressee_id
             else f.requester_id
           end as fid
    from friendships f
    where f.status = 'accepted'
      and (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
  )
  select
    p.user_id,
    p.username,
    p.avatar_url,
    coalesce((
      select sum(l.calories) from food_logs l
      where l.user_id = p.user_id and l.logged_date = p_today
    ), 0) as today_kcal,
    coalesce((
      select avg(d.total) from (
        select sum(l2.calories) as total
        from food_logs l2
        where l2.user_id = p.user_id
          and l2.logged_date > p_today - 7
          and l2.logged_date <= p_today
        group by l2.logged_date
      ) d
    ), 0) as avg7_kcal,
    coalesce(s.current_streak, 0) as current_streak,
    p.daily_target_kcal
  from friends
  join profiles p on p.user_id = friends.fid
  left join user_streaks s on s.user_id = friends.fid;
$$;

create or replace function public.get_pending_requests()
returns table (friendship_id uuid, user_id uuid, username text, avatar_url text)
language sql
security definer
set search_path = public
as $$
  select f.id, p.user_id, p.username, p.avatar_url
  from friendships f
  join profiles p on p.user_id = f.requester_id
  where f.status = 'pending' and f.addressee_id = auth.uid();
$$;

revoke all on function public.find_profile_by_username(text) from public, anon;
revoke all on function public.get_friend_summaries(date) from public, anon;
revoke all on function public.get_pending_requests() from public, anon;

grant execute on function public.find_profile_by_username(text) to authenticated;
grant execute on function public.get_friend_summaries(date) to authenticated;
grant execute on function public.get_pending_requests() to authenticated;

-- ============================================================
-- Avatar storage
-- ============================================================
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Files live at avatars/<user_id>/<filename>, so the first path segment is the
-- ownership check.
drop policy if exists "Avatars are publicly readable" on storage.objects;
create policy "Avatars are publicly readable"
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists "Users can upload their own avatar" on storage.objects;
create policy "Users can upload their own avatar"
  on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can update their own avatar" on storage.objects;
create policy "Users can update their own avatar"
  on storage.objects for update
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can delete their own avatar" on storage.objects;
create policy "Users can delete their own avatar"
  on storage.objects for delete
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
