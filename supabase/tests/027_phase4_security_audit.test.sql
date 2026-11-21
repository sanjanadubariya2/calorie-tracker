-- Phase 4 security audit: every social table has RLS and no anon access;
-- clients can't write social state directly; every SECURITY DEFINER function
-- pins search_path, and none is callable by anon; internal helpers aren't
-- callable by signed-in users either; nothing social exposes health data.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

create temp table social_tables(name text);
insert into social_tables values ('social_settings'), ('user_blocks'), ('activity_events'), ('challenge_templates'),
  ('challenges'), ('challenge_participants'), ('challenge_checkins'), ('social_rate_log'), ('activity_reactions'),
  ('activity_comments'), ('content_reports'), ('notifications'), ('achievement_definitions'), ('user_achievements'),
  ('notification_preferences'), ('push_tokens'), ('push_outbox'), ('streak_policy_audit'), ('moderation_actions');

select is((select array_agg(t.name order by t.name) from social_tables t
           join pg_class c on c.relname = t.name and c.relnamespace = 'public'::regnamespace
           where not c.relrowsecurity), null, 'RLS is enabled on every Phase 4 table');

select is((select array_agg(distinct table_name::text) from information_schema.role_table_grants
           where grantee = 'anon' and table_schema = 'public' and table_name in (select name from social_tables)), null,
  'anon has no privilege on any Phase 4 table');

-- Signed-in users may only INSERT/UPDATE the settings tables (their own rows, by RLS), never social records.
select is((select array_agg(distinct table_name::text order by table_name::text) from information_schema.role_table_grants
           where grantee = 'authenticated' and table_schema = 'public' and table_name in (select name from social_tables)
             and privilege_type in ('INSERT', 'UPDATE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')), null,
  'No table-wide write grant to authenticated on Phase 4 tables');
select is((select array_agg(distinct table_name::text order by table_name::text) from information_schema.column_privileges
           where grantee = 'authenticated' and table_schema = 'public' and table_name in (select name from social_tables)
             and privilege_type in ('INSERT', 'UPDATE')),
  array['notification_preferences', 'social_settings'],
  'Column-level writes exist only for the two preference tables');
select is((select array_agg(column_name::text order by column_name::text) from information_schema.column_privileges
           where grantee = 'authenticated' and table_name in ('notification_preferences', 'social_settings')
             and privilege_type in ('INSERT', 'UPDATE') and column_name = 'user_id'), null,
  'Clients never choose the user_id of a preference row');

-- Functions
create temp table phase4_funcs as
select p.oid, p.proname, p.prosecdef, p.proconfig
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in (
    'is_blocked_with', 'blocked_between', 'block_user', 'unblock_user', 'get_blocked_users', 'find_profile_by_username',
    'record_activity', 'get_activity_feed', 'is_challenge_member', 'challenge_progress_days', 'refresh_challenge_participant',
    'ensure_app_challenges', 'start_challenge', 'join_challenge', 'decline_challenge', 'leave_challenge', 'check_in_challenge',
    'get_challenge_catalog', 'get_my_challenges', 'get_challenge_participants', 'can_view_activity', 'social_rate_check',
    'set_reaction', 'remove_reaction', 'get_activity_interactions', 'add_comment', 'delete_comment', 'get_comments',
    'report_content', 'resolve_report', 'get_notifications', 'get_unread_notification_count', 'mark_notifications_read',
    'achievement_logged_days', 'achievement_metrics', 'evaluate_achievements', 'get_my_achievements', 'get_streak_summary',
    'mark_achievements_seen', 'get_friend_summaries', 'notification_wanted', 'notify', 'challenge_start_reminders',
    'notification_visible', 'register_push_token', 'unregister_push_token', 'push_message', 'claim_push_batch',
    'record_push_result', 'pending_push_receipts', 'record_push_receipt', 'enqueue_challenge_reminders',
    'log_on_time', 'active_days', 'are_friends', 'can_view_comment', 'moderate_report', 'get_friend_list',
    'purge_social_data', 'push_health');

select is((select array_agg(proname order by proname) from phase4_funcs where prosecdef
           and not coalesce(proconfig @> array['search_path=""'], false)), null,
  'Every SECURITY DEFINER function pins an empty search_path');
select is((select array_agg(proname order by proname) from phase4_funcs where has_function_privilege('anon', oid, 'execute')),
  null, 'anon can execute none of them');
select is((select array_agg(proname order by proname) from phase4_funcs
           where has_function_privilege('authenticated', oid, 'execute')
             and proname in ('record_activity', 'challenge_progress_days', 'refresh_challenge_participant',
                             'ensure_app_challenges', 'can_view_activity', 'social_rate_check', 'resolve_report',
                             'achievement_logged_days', 'achievement_metrics', 'evaluate_achievements', 'blocked_between',
                             'notification_wanted', 'notify', 'challenge_start_reminders', 'notification_visible',
                             'push_message', 'claim_push_batch', 'record_push_result', 'pending_push_receipts',
                             'record_push_receipt', 'enqueue_challenge_reminders', 'log_on_time', 'active_days',
                             'are_friends', 'can_view_comment', 'moderate_report', 'purge_social_data',
                             'push_health')), null,
  'Internal helpers and worker functions are not callable by signed-in users');
select is((select array_agg(proname::text order by proname) from phase4_funcs
           where has_function_privilege('notification_sender', oid, 'execute')),
  array['claim_push_batch', 'enqueue_challenge_reminders', 'pending_push_receipts', 'push_health', 'record_push_receipt',
        'record_push_result'],
  'The delivery role can call only its six functions');
select is((select array_agg(proname::text order by proname) from phase4_funcs
           where has_function_privilege('social_maintainer', oid, 'execute')), array['purge_social_data'],
  'The retention role can call only the purge');
select is((select array_agg(proname::text order by proname) from phase4_funcs
           where has_function_privilege('content_moderator', oid, 'execute')), array['moderate_report'],
  'Moderators can call only moderate_report');
select ok(not has_function_privilege('service_role', 'public.moderate_report(uuid, text, text)', 'execute'),
  'service_role cannot moderate');
select is((select array_agg(r order by r) from unnest(array['content_moderator', 'notification_sender', 'social_maintainer']) r
           where pg_has_role('authenticator', r, 'member')), null,
  'None of the operational roles is reachable through the API (authenticator is not a member)');
select is((select count(*)::int from information_schema.role_table_grants
           where grantee in ('notification_sender', 'social_maintainer')), 0,
  'The delivery and retention roles have no table privileges');

-- No social read function returns health or nutrition columns.
select is((select array_agg(distinct f.proname || '.' || a.n order by f.proname || '.' || a.n)
           from phase4_funcs f join pg_proc p on p.oid = f.oid,
                unnest(p.proargnames, p.proargmodes) as a(n, m)
           where a.m = 't' and a.n ~* '(kcal|calor|weight|height|^age$|protein|carb|^fat|food|meal|target_kcal|daily_target|gender|goal)'), null,
  'No social function returns calories, nutrition, body or goal data');

select * from finish();
rollback;
