# Calorie Tracker

A Samsung Health-style calorie tracker — one codebase for Android and web,
free auth, free hosting, no Google Play fee required.

Manual food logging only (search + quick add) across 6 meal slots, macro
breakdown, 7-day trend, and streak badges. No exercise/calorie-burn tracking
by design.

## Stack

- **App**: Expo + Expo Router (React Native + React Native Web) — TypeScript
- **Backend/Auth**: Supabase (free tier) — Postgres + email/password auth
- **Food data**: Open Food Facts API (free, no key)
- **Web hosting**: Vercel / Netlify (free tier)
- **Android distribution**: EAS Build (free tier) → direct .apk download, no Play Store fee

## 1. Install

```bash
npm install
```

## 2. Run without any backend (mock mode)

The app ships with `EXPO_PUBLIC_MOCK_MODE=true` by default in `.env.example`.
Copy it and just run:

```bash
cp .env.example .env
npm run start      # then press "w" for web, or scan the QR code / press "a" for Android
```

You'll be signed in automatically with sample data (matching the reference
screenshots) — no Supabase project needed yet. Great for building/reviewing UI.

## 3. Connect real Supabase (when ready to go live)

1. Create a free project at [supabase.com](https://supabase.com).
2. In the Supabase SQL Editor, run `supabase/migrations/001_init.sql`. This
   creates `profiles`, `food_logs`, and `user_streaks` with Row Level
   Security so each user only ever sees their own rows.
3. In Supabase → Authentication → Providers, confirm Email is enabled. For a
   student project you likely want to turn **off** "Confirm email" under
   Authentication → Settings so signup is instant (re-enable for production).
4. Copy your Project URL and anon public key from Project Settings → API
   into `.env`:

```
EXPO_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-public-key
EXPO_PUBLIC_MOCK_MODE=false
```

5. Restart `npm run start`. The whole app — auth, food logs, streaks —
   switches from mock data to your real Supabase project with no code
   changes; every screen goes through `lib/api.ts`, which reads
   `EXPO_PUBLIC_MOCK_MODE` once.

### Keeping your free Supabase project awake

Free-tier Supabase projects pause after 7 days with no API traffic. For a
project you want live/demoable at any time, add a free cron ping:

- **Easiest**: a free [UptimeRobot](https://uptimerobot.com) HTTP monitor
  hitting `https://your-project-ref.supabase.co/rest/v1/` every few days.
- **Or**: a GitHub Actions workflow on a schedule trigger running `curl`
  against the same URL (works on public repos for free).

## 4. Deploy the web version

```bash
npx expo export --platform web
```

This outputs a static site to `dist/`. Deploy it:

- **Vercel**: `npx vercel dist --prod` (or connect the GitHub repo and set
  build command to the export command above, output directory `dist`).
- **Netlify**: drag-and-drop the `dist/` folder in the Netlify dashboard, or
  connect the repo with the same build command/output directory.

Remember to set `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`,
and `EXPO_PUBLIC_MOCK_MODE=false` as environment variables in your hosting
provider's dashboard — `.env` is git-ignored and won't be picked up there.

## 5. Build an Android APK (no Play Store, no $25 fee)

```bash
npm install -g eas-cli
eas login
eas build --profile apk --platform android
```

When the build finishes, EAS gives you a direct `.apk` download link. Host
that file on your own website (or the same Vercel/Netlify site) so users can
download and sideload it, or point them to the web build and let them "Add
to Home Screen" for a PWA-style install.

**Note on Android sideloading changes**: Google is rolling out a free,
identity-only "developer verification" requirement for all installed apps,
including sideloaded ones — separate from the $25 Play Console publishing
fee. It starts enforcing in a handful of countries from September 30, 2026
and expands globally through 2027. Direct APK distribution works as-is for
now; budget time for the (free) verification step as it reaches your users'
region.

If you later want a Play Store listing itself, that's the one place the $25
one-time Play Console fee applies — everything above works without it.

## Project structure

```
app/                    Expo Router screens (file-based routing)
  (auth)/                 Login, signup
  (tabs)/                  Today (dashboard), Profile
  onboarding/               Profile setup wizard
  modals/                    Add food (search + quick add)
components/             Reusable UI (calorie bar, macro card, meal list,
                        weekly chart, badges, food search, portion customizer)
lib/                    Supabase client, mock data store, unified data API,
                        auth context, BMR/TDEE calculations, Open Food Facts wrapper
supabase/migrations/    SQL schema + Row Level Security policies
constants/theme.ts      Colors, spacing, typography, meal slot definitions
```

## Building further with Claude Code

Each folder above maps to one of the five build phases from the original
plan (DB/auth → dashboard UI → food logging → profile/targets → build/deploy).
The code here already implements all five end to end; from here, point
Claude Code at individual files in `components/` or `app/` for follow-up
features (edit/delete a logged item, notifications, dark/light theme toggle,
etc.) rather than regenerating from scratch.
