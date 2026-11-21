# Phase 4: production readiness

This runbook is for whoever reviews and deploys the Phase 4 release, and for the people who will moderate reports and run its jobs. It records the decisions from the final hardening review (migration 027), how to operate the release, and what still has to happen before production.

**Status, 2026-11-21:** everything is verified on the local Supabase stack only. Nothing has been deployed, no production migration has been run, and no production data has changed. In the checklists, a box is ticked only when the step was actually verified, and the place it was verified is stated.

## 1. Decisions

### 1.1 One activity policy (streaks, achievements and everything else)

**The problem.** Before 027, two rules disagreed:
- The streak (migration 004) and challenge progress (022) counted every logged date, including entries made weeks later.
- Achievements (024) counted only on-time days.

So someone backfilling ten days would see a 10-day streak, and their friends would get a "7-day streak" post, while the 7-day achievement stayed locked.

**The policy.** A logged day counts towards anything that is counted, awarded or announced only if a meal for it was logged on that day or the next. "Day" means the user's time zone, or the range UTC-12 to UTC+14 when no time zone is stored.

- **What it covers:** the streak, badges, achievements, habit milestones, challenge progress, feed posts and notifications all use the one definition, `public.active_days()`.
- **Late entries:** they stay in the food history, the daily totals and the reports. They just don't build streaks or unlock anything.
- **The one-day grace:** "Yesterday's dinner, logged this morning" counts.
- **Why it can't be faked:** `food_logs.created_at` is set by the server for every app write, since 024.

**Existing records.** 027 recomputes every stored streak once.
- Every row that changes is written to `streak_policy_audit`, with the old and new current streak, longest streak and last date. Nothing is rewritten silently, and the values can be restored.
- Badges are a high-water mark: they never go down.
- Achievements and feed posts already earned are kept.
- Locally, 4 of the existing streak rows changed.

**Tests.** UTC+14, UTC-11 and no-time-zone boundaries; an entry two local days late; the one-day grace; a backfill building no streak; badges not lowered; the streak and achievements using identical days; a late entry inside a running challenge not counting. These are in `028_social_hardening.test.sql` and the updated 004, 021, 022 and 024 tests.

### 1.2 Comment audience

**Before:** anyone who could see an event could read every comment on it, including friends of the event owner who don't know the commenter.

**Now:** a comment is shown to:
- the event's owner;
- the comment's author;
- the author's own friends who can see the event.

Event visibility (sharing settings, friendship) and blocks are enforced exactly as before. A blocked pair never sees each other's comments. When the owner stops sharing, the whole thread disappears for everyone except the owner. Counts, reports and comment notifications all use the same check, `can_view_comment`, and you can only report a comment you can read.

The comment box says who will read the comment before you post:
- on someone else's milestone: "Visible to @owner and to your friends who can see this milestone. Others won't see it."
- on your own: "Visible to your friends who can see this milestone."

The tests cover owner, author, the author's friend, an owner's friend who doesn't know the author, a friend blocked by the author, a stranger, the owner stopping sharing, counts, and reporting.

### 1.3 Moderation

- **Who moderates.** Moderators are named database logins that belong to the `content_moderator` group role. The group itself can't log in.
- **Not reachable from the API.** The API's `authenticator` role is not a member of `content_moderator`, so no JWT can ever reach it; a test checks this.
- **service_role is out.** `service_role` can't read the queue or moderate. It's the role behind the API key, which every server holds, so it isn't treated as a moderator. `resolve_report` is removed.
- **How decisions are made.** All decisions go through `moderate_report(report, action, note)`, which:
  - refuses anyone without a real grant (`pg_has_role(session_user, 'content_moderator', 'USAGE')`);
  - refuses already-resolved reports and actions that don't fit the report;
  - writes every decision to `moderation_actions`, recording which login made it.
- **What moderators can see and change.** They can read reports, comments and the decision log. They can change content only through `moderate_report`.

### 1.4 Older app builds

Builds from before Phase 4 call `get_friend_summaries` and draw calorie bars from `today_kcal`, `avg7_kcal` and `daily_target_kcal`.

- Returning rows without those fields (025) made old builds show "0 / 0 kcal", which looks like real data.
- So since 027 the old function refuses with `P0426` ("This version of the app is no longer supported. Please update."). Old builds show their existing "Couldn't load your friends and requests" message and an empty list.
- No nutrition value is returned to anyone but its owner, and no fake zero is sent.
- New builds call `get_friend_list`.

**An app update is required for the friends list.** Decision: release the new build to the stores first, then apply 021–027. After that, prompt old builds to update (see the checklist). Logging, the dashboard, reports and the assistant are not affected in old builds.

### 1.5 Push notifications

**Token lifecycle:**
- A device registers only after the person turns push on and the OS grants permission.
- It re-registers at most once a day at app start, which keeps the device marked "seen".
- It unregisters on sign-out and when push is turned off.
- The server keeps at most 5 active devices per person, and moves a token to whoever signed in last on that device.
- A device is disabled when Expo reports `DeviceNotRegistered` (at send time or in a receipt), and when it hasn't been seen for 90 days.
- Disabled devices are deleted 30 days later.

**Delivery** (`push-deliver`):
- Claims use `FOR UPDATE SKIP LOCKED`, so several workers are safe.
- Rows stuck in "sending" for more than 10 minutes are reclaimed.
- Transient errors are retried with backoff (2, 4, 8 and 16 minutes, 5 attempts in all).
- Permanent errors (`InvalidCredentials`, `MessageTooBig`) fail immediately.
- Pushes already read in the app, no longer visible (for example after a block), or more than a day old are skipped, not sent.

**Monitoring.** `push-health` prints a JSON summary and exits with code 2 when any limit is exceeded:
- the oldest pending push is more than 15 minutes old;
- any push is stuck in "sending";
- more than 50 pushes failed in 24 hours;
- more than 100 devices were disabled in 24 hours.

A spike in disabled devices usually means broken credentials or a bad build.

### 1.6 Retention

`purge_social_data()` runs as `social_maintainer` via `social-cleanup`, daily. `--dry-run` reports counts without changing anything.

| Data | Removed | Never removed |
|---|---|---|
| `activity_events` | Past `expires_at` (180 days after creation). Their reactions, comments and notifications go with them through foreign-key cascades. | Live events, and expired events with a comment under an open report (kept until a moderator resolves it). |
| `push_outbox` | `sent`, `failed` and `skipped` rows older than 30 days. Pending rows that can never be sent (device disabled, or more than a day old) are first closed as `skipped`. | `pending` and `sending` rows that can still be delivered. |
| `social_rate_log` | Entries older than 2 days (the longest limit window is 1 day). | Anything still inside a limit window. |
| `notifications` | Read notifications older than 90 days, and any older than 365 days. | Unread notifications less than a year old. |
| `push_tokens` | Deleted 30 days after being disabled. Devices unseen for 90 days are disabled with the reason "stale". | Active devices. |
| `content_reports`, `moderation_actions`, `streak_policy_audit` | Never purged (audit). Report snapshots survive the comment's deletion. | — |

The tests assert each row in this table, and that nothing is left orphaned. Retention can't remove anything else because the role has no table privileges at all, only `purge_social_data()`.

## 2. Moderation procedure (SQL, repeatable)

**One-time setup per moderator.** Run as an admin in the SQL editor, with the password generated and handed over outside chat or email:

```sql
create role mod_alex login password '<generated>' in role content_moderator;
alter role mod_alex connection limit 2;
```

**Each review session.** Connect as the moderator through the pooler (`mod_alex.<project-ref>`) with psql or another SQL client. Never use the API keys.

```sql
-- 1. What needs review (oldest first). snapshot = the reported text or "@username avatar: <url>".
select id, created_at, target_kind, reason, note, snapshot, comment_status, open_reports
from public.moderation_queue order by created_at;

-- 2. Decide one report.
--    Comment reports: 'remove' | 'restore' (show it again, close its reports) | 'dismiss' (this report only)
--    Profile reports: 'clear_avatar' | 'reset_username' (becomes user_<id>; the person can pick another) | 'dismiss'
select public.moderate_report('<report id>', 'remove', 'Harassment, matches policy 3.2');

-- 3. Check the record.
select created_at, action, moderator, note from public.moderation_actions order by created_at desc limit 20;
```

**Rules:**
- A comment reported by three different people is hidden automatically until it's reviewed; `restore` brings it back.
- Escalate anything involving threats or self-harm outside this tool, per the support policy.
- To remove a moderator: `drop role mod_alex;`. Their past decisions stay in `moderation_actions`, under their login name.

## 3. Push configuration (required before push works)

| Item | Where | Notes |
|---|---|---|
| EAS project | `app.json`, `extra.eas.projectId` (already set) | Expo push tokens are issued for this project. |
| Android: FCM V1 | Firebase project, then upload the service-account key to EAS (`eas credentials`, Android, "Google Service Account Key for FCM V1"). Also add `google-services.json` and set `android.googleServicesFile` in `app.json`. | Without this, Android never receives push. The package must be `com.calorietracker.app`. |
| iOS: APNs | Apple Developer account, then an APNs key (.p8) linked to the app identifier through `eas credentials`. Set `ios.bundleIdentifier` in `app.json`; it isn't set yet. | Push needs an Apple Developer account and a real device. |
| App build | `eas build --profile production` (or a development build) | `expo-notifications` is native, so an over-the-air update can't add it. |
| Optional: Expo access token | `EXPO_ACCESS_TOKEN` on the worker, with "enhanced push security" turned on in the Expo project | Prevents anyone else with a token from sending to your users. |
| Worker database URL | `PUSH_DATABASE_URL=postgresql://notification_sender.<ref>:<pw>@<pooler>:5432/postgres` | Set the password with `alter role notification_sender password '...'`. |

**Scheduled jobs**, on the worker host (cron, or a container scheduler):

| Schedule | Command | Alert when |
|---|---|---|
| Every minute | `python -m app.cli push-deliver --receipts` | The command fails |
| Daily, 06:00 UTC | `python -m app.cli push-deliver --reminders` | The command fails |
| Every 5 minutes | `python -m app.cli push-health` | Exit code 2 |
| Daily, 03:00 UTC | `python -m app.cli social-cleanup` (needs `SOCIAL_MAINTENANCE_DATABASE_URL`, as `social_maintainer`) | The command fails, or counts jump |

## 4. Real-device push test checklist (not yet run: needs the EAS build and credentials)

- [ ] iOS physical device: turning push on shows the OS prompt once. Choosing "Don't allow" shows the "blocked in device settings" message with a link, and the app keeps working.
- [ ] iOS: after allowing, a token appears in `push_tokens` for the account, with platform `ios`.
- [ ] Android 13+ physical device: same permission flow, and the token appears with platform `android`.
- [ ] Friend request from account A reaches account B's lock screen within about a minute with "@A wants to be friends."; tapping it opens Friends, then the Friends section.
- [ ] Challenge invitation push: tapping it opens the challenge.
- [ ] Comment push: the lock screen shows "@A commented on your milestone." and never the comment text; tapping it opens the comments.
- [ ] Reactions, achievements and friends' milestones do not push; they appear in the in-app center only.
- [ ] With the app in the foreground, a banner shows with no sound.
- [ ] Turning push off in settings removes the device's token row; nothing further arrives.
- [ ] Signing out removes the token; signing in as a different account on the same device doesn't deliver the first account's pushes.
- [ ] Uninstalling the app leads to `DeviceNotRegistered` on the next send or receipt, and the token is disabled.
- [ ] Twenty-one pushes in a day to one person: the 21st isn't queued.
- [ ] `push-health` is clean after the run, and an alert fires when the worker is stopped for more than 15 minutes.

## 5. Staging deployment checklist

Staging means a separate Supabase project restored from a production backup (or a branch), never production itself.

**Before:**
- [x] Migrations 001–027 apply in order to an empty database, with hosted-style default privileges. *Verified locally:* `bash supabase/tests/verify_migrations_scratch.sh`.
- [x] Re-applying 019–027 succeeds; a retried deployment won't fail. *Verified locally* by the same script. 019 was made re-runnable during this review.
- [x] Every pgTAP file passes on that freshly built database. *Verified locally:* 788 assertions.
- [ ] Production backup taken, and its restore tested (staging is created from it).
- [ ] Confirm that production has exactly migrations 013–018 applied, and nothing from 019 onwards, using `supabase_migrations.schema_migrations` or by checking the objects.

**Apply to staging, in order. Each step is one SQL editor run; stop at the first error.**
1. [ ] `019_template_component_attributes.sql`
2. [ ] `020_template_approval_level.sql`
3. [ ] `021_social_activity.sql` through `026_notifications.sql`, in order
4. [ ] `027_social_hardening.sql`. Then check `select count(*) from streak_policy_audit` and review a few rows.
5. [ ] Set passwords: `notification_sender`, `social_maintainer`. Create one moderator login.
6. [ ] Deploy the backend image (`docker build` of `backend/`); configure `PUSH_DATABASE_URL`, `SOCIAL_MAINTENANCE_DATABASE_URL` and the jobs from section 3 against staging.

**Verify on staging:**
- [ ] `pg_prove` or `supabase test db` against staging, if allowed (the tests roll back).
- [ ] Security audit queries return nothing (the checks in `027_phase4_security_audit.test.sql` can be run by hand).
- [ ] Two-account smoke test (below), on a staging build of the app.
- [ ] `social-cleanup --dry-run` counts look plausible; then run it for real once.
- [ ] `push-health` exits 0.

**Two-account smoke test (A and B, on two devices or simulators):**
1. [ ] A searches B's username and sends a request. B sees it in the notification center (and as a push, if on) and accepts. A gets "accepted".
2. [ ] B's Friends list shows A with "Streak not shared" and no calories anywhere.
3. [ ] A logs a meal; the first-meal celebration shows once.
4. [ ] A turns on activity sharing. B's Activity feed shows A's milestone; B reacts 🎉 and comments. A receives both. A can't react to their own milestone.
5. [ ] The comment box shows its audience line before B posts. A third account C, a friend of A but not of B, doesn't see B's comment.
6. [ ] A starts "Walk on 5 days" tomorrow and invites B. B gets the invitation, joins, and (with the reminders job) gets the "starts tomorrow" reminder. A check-in the next day increments the dots.
7. [ ] B reports A's comment; a moderator removes it through `moderate_report`; it disappears for everyone, and `moderation_actions` has the row.
8. [ ] B blocks A: the friendship ends, A's posts and notifications disappear for B, and neither can send the other a request.
9. [ ] An old app build (from before Phase 4) opens its Friends tab: it shows the "couldn't load" message, not 0 kcal.
10. [ ] Both accounts sign out. Their push tokens are gone.

**Rollback (staging rehearsal):**
- [ ] Restore from the backup taken before the migrations. That is the supported rollback. 027 rewrites stored streaks (audited) and 024 backfills achievements, so a partial manual rollback isn't recommended.
- [ ] If only 027 must be undone: restore streaks from `streak_policy_audit` (`update user_streaks set current_streak = old_current, longest_streak = old_longest, last_logged_date = old_last ...`), then re-run the function definitions from 021–026. Rehearse this on staging before relying on it.

## 6. Production deployment checklist (requires explicit approval for each step)

- [ ] Staging checklist above completed and signed off.
- [ ] New app build (with `expo-notifications`) approved in both stores and released, with the FCM and APNs credentials in EAS. Old builds will lose the friends list from step 4.
- [ ] Maintenance window announced, if wanted (the migrations are short; 024 and 027 loop over users).
- [ ] Production backup taken immediately before; point-in-time recovery confirmed available.
- [ ] Apply 019–027 in order (as on staging), stopping at any error.
- [ ] Set role passwords and create moderator logins (secrets outside version control and chat).
- [ ] Deploy the worker and scheduler, then confirm the first `push-health` run passes.
- [ ] Two-account smoke test on production with internal test accounts, then delete those accounts.
- [ ] Monitor for 24 hours: `push-health`, database errors, `streak_policy_audit` count, report volume.
- [ ] Ask old builds to update (store listing notes; optionally an in-app prompt in a later build).

## 7. Remaining production dependencies from Phases 0–3

These are not part of Phase 4, but production depends on them:
- [ ] Migrations 019 and 020 (Phase 3) are still to be applied. They are in the plan above.
- [ ] Food catalogue data: INDB reload (for `cooking_oil_uncertain`), the USDA staples load, the `classify-foods` attribute run, recipes, and the 40 meal templates. The templates are approved for provisional use only, not individually verified. Each is a separate step that needs approval.
- [ ] Backend secrets in the hosting environment: Gemini API key, `ASSISTANT_DATABASE_URL` (`assistant_writer` password), `CATALOGUE_DATABASE_URL` (`catalogue_writer`), and the purge jobs for meal images and assistant conversations.
- [ ] Hosted default privileges: Phase 4 objects revoke access explicitly, and that is verified with hosted-style defaults. Objects from Phases 0–3 were tested on the local stack's stricter defaults, so run the security audit queries against staging to confirm nothing from earlier phases is executable or readable by `anon` there.

## 8. Known limitations

- **No moderator UI.** Moderation is the SQL procedure above, so moderators need database logins.
- **Push is untested on real devices.** It's configured in code, but FCM, APNs and the EAS build are outstanding, and `ios.bundleIdentifier` isn't set.
- **"Starting soon" push needs the daily reminder job.** The in-app reminder is created when the notification center is opened.
- **Old builds lose the friends list** until people update. A minimum-version prompt can only be added to future builds.
- **Late entries don't build streaks.** People who routinely log several days late will see shorter streaks than before; the footnotes on the Achievements screen explain the rule.
- **Smaller comment audiences:** people with no friend in a thread see only the event owner's comments.
- **Mock mode** doesn't simulate the activity policy or log-based challenge progress.
