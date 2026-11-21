# Phase 4: social wellness

This document covers activity sharing, challenges, achievements, reactions and comments, and notifications. It's for developers and the person deploying the release. Everything below is implemented and tested against the local Supabase stack. Nothing has been applied to production.

## 1. Features

| Area | What a user gets |
|---|---|
| Friend privacy | Friends see your username, avatar, and your streak only if you share it. Friends never see calories, averages, targets, meals or weight. |
| Activity feed | Your own milestones and those of friends who opted in: streaks, logging-day totals, achievements, challenges joined and completed. Paged, pull-to-refresh, loading skeletons, empty and error states. |
| Sharing settings | A master opt-in, off by default, plus a switch per kind of event. Blocked people are listed and can be unblocked. |
| Blocking | Blocking ends the friendship and hides each person from the other's feed, search, requests, challenge member lists, comments, reactions and notifications. |
| Challenges | Eleven curated habit challenges: 4 daily and 7 weekly, all with rest days built in. They're measured from meal logs, or from a self-reported check-in once a day. Join this week's app challenges, start your own, or invite up to 9 friends. Participants are listed alphabetically, never ranked. Views: Discover, Joined, Completed. |
| Achievements | Fifteen badges in five groups (logging, consistency, habits, challenges, encouragement). Locked badges show progress. There's a history, a streak summary written without shame language, and a one-time celebration with reduced-motion support. |
| Interactions | Four positive reactions (like, celebrate, support, fire). Optional plain-text comments up to 280 characters. Reporting of comments and profiles. Owners can delete comments on their own events. |
| Notifications | An in-app notification center: paged, unread state, mark one or all read, deep links, preferences per category. Push is optional and off by default. |

## 2. Database migrations (apply in order)

| # | File | Summary |
|---|---|---|
| 021 | `021_social_activity.sql` | `social_settings` (opt-in), `user_blocks` with the block, unblock and list functions, and blocks enforced on friend requests and search. `activity_events` uses a payload whitelist, deduplication, 180-day expiry, milestone triggers, and `get_activity_feed` with keyset paging. |
| 022 | `022_challenges.sql` | Challenge templates, challenges, participants and check-ins. Progress is computed only by the server, logs entered after a challenge ends don't count, completion is idempotent, and joining, check-ins and participant lists are restricted. |
| 023 | `023_social_interactions.sql` | Reactions, comments, reports with a moderation queue, rate limits, and the first notifications (reactions and comments). |
| 024 | `024_achievements.sql` | Achievement definitions and per-user records. One evaluator awards from server records. A trigger forces `food_logs.created_at` to the server's time for client inserts and updates. Existing history is backfilled silently. |
| 025 | `025_friend_summary_privacy.sql` | `get_friend_summaries` no longer returns calories, averages or targets. A friend's streak is returned only when that friend shares it. |
| 026 | `026_notifications.sql` | All notification kinds, preferences, a gate that applies preferences and blocks, read-time visibility checks, push tokens, the push outbox, and the `notification_sender` role. |
| 027 | `027_social_hardening.sql` | One on-time activity policy for streaks, badges, achievements, habit milestones, challenges and the feed, with an audited one-time recomputation. A narrower comment audience. `content_moderator` with `moderate_report` and an audit log (replaces `resolve_report`). `get_friend_list` (old `get_friend_summaries` refuses with P0426). Retention (`social_maintainer`, `purge_social_data`) and `push_health`. |

Migrations 021–027 must ship together. See [phase4-production-readiness.md](phase4-production-readiness.md) for the deployment runbook. 021 and 022 were edited during Phase 4 (achievement writes moved to 024, check-in fixes, tighter grants), which is safe only because they have never been applied anywhere except locally.

## 3. API (Supabase RPC, called with the user's JWT)

The caller is always `auth.uid()`. No function accepts an acting user id, progress values or timestamps from the client.

Error codes:

| Code | Meaning |
|---|---|
| `28000` | Not signed in |
| `22023` | Invalid input (the message is user-facing) |
| `P0002` | Not found, or not visible to you |
| `55000` | The action is no longer possible (e.g. a challenge has ended) |
| `P0429` | Rate limited |
| `42501` | Not permitted |

### Feed, settings and blocks

| Function / table | Arguments | Returns |
|---|---|---|
| `get_activity_feed` | `p_before_at`, `p_before_id`, `p_limit` (1–50) | `id`, `actor_id`, `actor_username`, `actor_avatar_url`, `is_me`, `kind`, `payload`, `created_at` |
| table `social_settings` | upsert the `share_*` columns only | Your own row (RLS) |
| `block_user`, `unblock_user` | `p_user_id` (the other person) | — |
| `get_blocked_users` | — | `user_id`, `username`, `avatar_url`, `blocked_at` |
| `get_friend_list` | — | `user_id`, `username`, `avatar_url`, `current_streak` (null unless shared) |
| `get_friend_summaries` | `p_today` | Always refuses with `P0426` (update the app). Kept only so builds from before Phase 4 fail honestly. |

### Challenges

| Function | Arguments | Notes |
|---|---|---|
| `get_challenge_catalog` | — | Templates, plus this week's app challenge for each |
| `get_my_challenges` | — | Current challenges and history, refreshed by the server |
| `get_challenge_participants` | `p_challenge` | Members only. Alphabetical. App challenges list nobody. |
| `start_challenge` | `p_template`, `p_starts_on` (today to +7 days), `p_invite` (up to 9 friends) | Returns the challenge id |
| `join_challenge`, `decline_challenge`, `leave_challenge` | `p_challenge` | Joining is idempotent |
| `check_in_challenge` | `p_challenge`, `p_day` (today or yesterday) | Check-in challenges only. Returns progress. |

### Achievements

| Function | Arguments | Returns |
|---|---|---|
| `get_my_achievements` | — | Every definition, with `unlocked_at`, `seen_at` and `progress` |
| `get_streak_summary` | — | Current and longest streak, logged days, check-ins this week, challenge-week run, challenges completed |
| `mark_achievements_seen` | `p_codes` | Marks celebrations as shown |

### Interactions

| Function | Arguments | Notes |
|---|---|---|
| `set_reaction` | `p_event`, `p_reaction` | Visible events only, never your own. 60 per 10 minutes. |
| `remove_reaction` | `p_event` | — |
| `get_activity_interactions` | `p_events` (up to 50) | Counts, your reaction, comment count |
| `add_comment` | `p_event`, `p_body` | 1–280 characters, up to 4 lines. 5 per minute, 30 per hour. |
| `get_comments` | `p_event` | Comments you may read: all of them on your own events; otherwise your own, and those from your friends |
| `delete_comment` | `p_comment` | The author, or the owner of the event |
| `report_content` | `p_kind` (`comment` or `profile`), `p_target`, `p_reason`, `p_note` | 20 per day |

### Notifications

| Function / table | Arguments | Notes |
|---|---|---|
| `get_notifications` | `p_before_at`, `p_before_id`, `p_limit` (1–50) | Newest first, visibility re-checked |
| `get_unread_notification_count` | — | Capped at 100 |
| `mark_notifications_read` | `p_ids` (null means all) | — |
| table `notification_preferences` | upsert the category columns and `push_enabled` | — |
| `register_push_token` | `p_token`, `p_platform` | At most 5 active devices |
| `unregister_push_token` | `p_token` | — |

### Moderation and delivery (not for app users)

| Role | Functions and objects |
|---|---|
| `content_moderator` (group of personal logins) | `moderation_queue` (view), `moderation_actions` (audit log), `moderate_report(p_report, p_action, p_note)` |
| `social_maintainer` | `purge_social_data(p_dry_run)`, run with `python -m app.cli social-cleanup` |
| `notification_sender` | `claim_push_batch`, `record_push_result`, `pending_push_receipts`, `record_push_receipt`, `enqueue_challenge_reminders`, `push_health` |

Backend worker: `python -m app.cli push-deliver [--receipts] [--reminders]`, with `PUSH_DATABASE_URL` and an optional `EXPO_ACCESS_TOKEN`.

## 4. Frontend screens and navigation

The app still has the same five tabs; nothing new was added to the tab bar.

- **Friends tab**, with three sections (Activity, Challenges, Friends) and a notification bell with an unread badge.
  - **Activity:**
    - the feed, with reactions and comments on each card;
    - a Visibility button that opens the sharing and blocking settings.
  - **Challenges:** Discover (this week's challenges and templates), Joined (progress, check-in, invitations), Completed (completed and ended). Opening a challenge shows its details and members.
  - **Friends:**
    - **your social profile:** username, avatar, and privacy badges for calories (only you) and activity (private or shared with friends);
    - **finding people:** search by username, invite link, requests;
    - **friends list:** alphabetical. Each friend shows their streak if shared, or "Streak not shared". Every row has an options button (remove, block, report) as well as long-press.
- **Notification center:** a sheet that opens from the bell, with a settings sheet for categories and push opt-in. Tapping a notification deep-links to the friends list, the relevant challenge, the event's comments, or achievements.
- **Achievements:** a modal opened from the dashboard's badge card or from Profile. The dashboard also shows the celebration after a new unlock.
- **Profile tab:** a new "Privacy & notifications" card linking to sharing settings and notification settings.
- **Push taps:** taps on push notifications go to the same deep-link targets. Signing out removes the device's push token.

## 5. Test results (local stack, 2026-11-21)

| Suite | Result |
|---|---|
| pgTAP (database, RLS, security audit) | 728 passed (23 files) |
| Concurrency scripts (022, 024) | All checks pass, with no errors from any session |
| Backend unit tests | 656 passed, 25 skipped (need the INDB workbook or live credentials) |
| Backend integration tests (local stack) | 18 passed, 6 skipped (4 need a local `ASSISTANT_DATABASE_URL`, 2 need a live Gemini key) |
| Frontend Jest | 426 passed (30 suites) |
| TypeScript, ESLint | Clean |
| Expo export (web, Android) | Both bundle |
| Docker build (backend) | Builds; the image imports the worker and CLI |

The integration tests include `test_phase4_live.py`, an end-to-end run through real Auth, PostgREST and RLS, and `test_push_live.py`, which runs the worker as `notification_sender` with Expo mocked.

## 6. Known limitations

- **No moderator UI.** Reports are reviewed in SQL by named moderator logins; see the production-readiness runbook.
- **Push hasn't been tested on real devices.** It needs an EAS development or production build. Android also needs FCM credentials uploaded to EAS, and iOS needs an APNs key. Expo Go may deliver pushes in development only.
- **Start reminders need a job.** The "starting soon" reminder for push depends on a daily `push-deliver --reminders` run. The in-app version is created when the notification center is opened.
- **Comment visibility:** since 027, a comment is shown to the event's owner, its author, and the author's friends who can see the event. People with no friend in the thread see only the owner's comments.
- **Mock mode** keeps social data in memory, and log-based challenge progress isn't simulated there.
- **Older app builds** (from before Phase 4) can't load the friends list: it refuses with an "update the app" error rather than show zeros. Everything else in those builds keeps working.

## 7. Deployment (needs explicit approval; nothing has been run against production)

1. Back up the production database.
2. Apply migrations 019–026 in order in the SQL editor: 019 and 020 from Phase 3, then 021–026. 024 backfills achievements silently (no feed posts or notifications) and is the only step that writes data.
3. Set a password for the delivery role, outside version control: `alter role notification_sender password '<generated>';`
4. Configure the worker host (container or cron):
   - `PUSH_DATABASE_URL=postgresql://notification_sender.<project-ref>:<pw>@<pooler-host>:5432/postgres`
   - optional `EXPO_ACCESS_TOKEN`
   - schedule `python -m app.cli push-deliver --receipts` every minute, and `push-deliver --reminders` once a day.
5. Upload the FCM and APNs credentials to EAS, then build the app with EAS. The new native module `expo-notifications` requires a new build, not an over-the-air update.
6. Smoke test with two test accounts: friend request, feed opt-in, reaction, challenge invite, push.

## 8. Remaining production-readiness checklist

- [ ] Approval to apply 019–026, plus a dry run on a staging copy of production.
- [ ] Decide on comments: keep them, restrict them to the event owner's friends, or turn them off until there's a moderator workflow.
- [ ] Assign a moderator and a response time for reports, or build an admin screen.
- [ ] Set up FCM and APNs credentials and EAS builds, then test push on real iOS and Android devices.
- [ ] Schedule and monitor the worker: alert on rising `failed` outbox rows or disabled tokens.
- [ ] Purge jobs for expired `activity_events` (the `assistant_writer` policy exists), old `push_outbox` rows and `social_rate_log`.
- [ ] Update privacy policy text for sharing, comments, reports and push tokens.
- [ ] Load-test the feed and notification queries on production-sized data (pgTAP checks 20,000 events in under 250 ms locally).
- [ ] Production data steps still pending from earlier phases: the classifier run, staples, recipes and templates.
