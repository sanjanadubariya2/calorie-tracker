-- Migration 025: friends no longer see each other's calories.
--
-- Before: get_friend_summaries (002-005) returned every friend's calories
-- eaten today, their 7-day calorie average and their calorie target, to all
-- accepted friends, with no opt-out.
--
-- After: it returns only who the friend is (username, avatar) and their
-- current logging streak, and the streak only when that friend has opted in
-- to sharing streaks (social_settings from 021: share_activity and
-- share_streaks). Otherwise current_streak is null. No calorie, nutrition,
-- target, weight or health value is returned to anyone but its owner.
--
-- The signature (p_today date) and its validation are kept so older app
-- builds keep working; they read the missing calorie fields as 0.
--
-- Rollback (local): re-run get_friend_summaries from 005_nutrition_targets.sql
-- (after dropping this version: the return type differs).

begin;

drop function if exists public.get_friend_summaries(date);

create function public.get_friend_summaries(p_today date)
returns table (user_id uuid, username text, avatar_url text, current_streak int)
language plpgsql stable security definer set search_path = '' as $$
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
    raise exception 'p_today must be the caller''s current local date' using errcode = '22023';
  end if;

  return query
  select p.user_id, p.username, p.avatar_url,
         case when ss.share_activity and ss.share_streaks
              then public.effective_current_streak(
                     s.current_streak, s.last_logged_date,
                     (select b.today_min from public.user_today_bounds(p.user_id) b))
         end
  from public.friendships f
  join public.profiles p
    on p.user_id = case when f.requester_id = v_uid then f.addressee_id else f.requester_id end
  left join public.user_streaks s on s.user_id = p.user_id
  left join public.social_settings ss on ss.user_id = p.user_id
  where f.status = 'accepted' and (f.requester_id = v_uid or f.addressee_id = v_uid)
    and not public.blocked_between(v_uid, p.user_id)
  order by lower(coalesce(p.username, '')), p.user_id;
end;
$$;

revoke all on function public.get_friend_summaries(date) from public, anon;
grant execute on function public.get_friend_summaries(date) to authenticated;

commit;
