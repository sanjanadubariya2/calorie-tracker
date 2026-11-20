# Calorie Tracker API (FastAPI)

A small Python service alongside the Expo app. Today it exposes one
authenticated endpoint; it is the foundation for future server-side features.
The app works without it: it only calls this service when
`EXPO_PUBLIC_API_BASE_URL` is set.

```
backend/
  app/
    main.py                  application factory (uvicorn --factory), error handlers, CORS
    core/config.py           settings from env, validated at startup (fail closed)
    core/security.py         Supabase JWT verification + get_current_user dependency
    db/supabase.py           user-scoped PostgREST client (forwards the user's token)
    services/daily_status.py delegates to get_daily_status() in Postgres
    schemas/daily_status.py  Pydantic response model
    api/routes/              health.py, daily_status.py
  tests/                     unit tests (no network) + integration/ (real Supabase)
  Dockerfile, .dockerignore, .env.example, requirements*.txt, pytest.ini
```

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | `{"status": "ok"}`. Liveness only; reveals no configuration. |
| GET | `/v1/me/daily-status?date=YYYY-MM-DD` | Bearer | The caller's targets, consumption and remaining amounts for one local date. `date` is optional (defaults to today in the profile's time zone). |

`/v1/me/daily-status` responses:

| Status | When |
|---|---|
| 200 | `{"date", "targets": {kcal, carbs_g, fat_g, protein_g, macro_split} \| null, "consumed": {...,"entry_count"}, "remaining": {...} \| null}` |
| 400 | No `date` and the profile has no time zone yet |
| 401 | Missing, malformed, invalid, expired or non-user token (same generic body for all) |
| 422 | `date` is not a real `YYYY-MM-DD` date |
| 502 / 503 | The database errored / was unreachable (generic message, no upstream detail) |

There is no user-id parameter. Identity comes only from the verified token;
extra query parameters such as `?user_id=` are ignored. Interactive docs are
served at `/docs` outside production.

## How authentication works

The project's signing configuration was checked rather than assumed: the
Supabase JWKS endpoint (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`)
publishes an **EC P-256 key, ES256**, for both production and the local CLI
stack. So by default only ES256 is accepted. For each request:

1. Read `Authorization: Bearer <token>`; anything else is 401.
2. The header `alg` must be in `SUPABASE_JWT_ALGORITHMS` (default `ES256`).
   Verification is pinned to that algorithm, which blocks `alg: none` and
   HS256-with-the-public-key confusion.
3. The header `kid` selects a key from the cached JWKS (refreshed every 10 min;
   an unknown `kid` triggers at most one refetch per 30 s, for key rotation).
   The key's own algorithm must match.
4. Signature, `exp` (30 s leeway), `iat`, `iss` (= `<SUPABASE_URL>/auth/v1`) and
   `aud` (= `authenticated`) are verified and required.
5. `role` must be `authenticated` and `sub` a UUID: anon keys, service-role
   keys and any non-user token are rejected.

HS256 (legacy JWT secret) is off unless you set both
`SUPABASE_JWT_ALGORITHMS=...,HS256` and `SUPABASE_JWT_SECRET`.

## How RLS is preserved

The service never holds a credential that bypasses Row Level Security. Each
database call forwards the **user's own access token** to PostgREST
(`Authorization: Bearer <user token>`, plus the public anon key as `apikey`).
Postgres runs it as role `authenticated` with `auth.uid()` = the user, so the
same RLS policies and function grants apply as for the mobile app.
`get_daily_status()` is also `SECURITY INVOKER`. No nutrition maths is
duplicated here: the endpoint reshapes the function's single row.

The service-role key is not used and should not be given to this service.

## Food catalogue and matching (Phase 1)

Shared catalogue in Postgres (migration 007): `foods`, `food_aliases`,
`food_servings`. Users can only read it; only the `catalogue_writer` role
(migration 008) writes it. Nutrition is per 100 g (or per 100 ml with a
density), and every logged catalogue food copies those values into the log's
immutable snapshot, so later catalogue changes never alter history.

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/foods/match` | Up to 10 candidates `{food_name, brand?, estimated_quantity_g? \| estimated_quantity_ml?}`. Nutrition fields are rejected (422). Returns ranked matches, `confidence`, per-100 nutrition, the portion, and `decision` (`confident` / `ambiguous` / `no_match`). `needs_user_confirmation` is always true. |
| GET | `/v1/foods/search?q=&brand=&limit=` | Same ranking, for manual search. |
| GET | `/v1/foods/{id}` | Food with aliases, servings, micronutrients, quality. |
| POST | `/v1/foods/import/off/{barcode}` | The server fetches the product from Open Food Facts itself and adds it. Needs `CATALOGUE_DATABASE_URL`; rate-limited per user. |

Scoring and portion maths live in SQL (`search_food_catalogue`,
`portion_nutrition`); thresholds are in `app/services/catalogue/matching.py`
and are checked against `tests/data/match_eval.csv` (labelled Indian foods).

**Loading INDB** (Indian Nutrient Databank, Anuvaad 2024.11). The workbook is
not part of this repository; pass its path:

```bash
pip install -r requirements-tools.txt
export CATALOGUE_DATABASE_URL=postgresql://catalogue_writer...   # see .env.example
python -m app.cli load-indb /path/to/Anuvaad_INDB_2024.11.xlsx --dry-run   # report only
python -m app.cli load-indb /path/to/Anuvaad_INDB_2024.11.xlsx
```

It's idempotent (upserts by INDB food code). `data/indb_aliases_extra.csv`
adds everyday names (chole, rajma, paneer butter masala...) by food code. It
holds names only, never nutrition values.

## Meal images (Phase 1)

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/meal-images` | Raw image body, `Content-Type: image/jpeg\|png\|webp`, up to 10 MB. Re-encoded to JPEG (max 2048 px), **all metadata including GPS removed**, stored privately at `<user_id>/<id>.jpg`. Returns metadata and a 5-minute signed URL. 60 per user per hour. |
| GET | `/v1/meal-images/{id}` | Metadata and a fresh signed URL (owner only; others get 404). |
| DELETE | `/v1/meal-images/{id}` | Deletes the object, then the row. |

The bucket is private, JPEG-only and 5 MB max. Storage policies allow a user
only their own folder, with exact `<uuid>.jpg` names and no overwrites
(migration 009). Images expire after 30 days; remove them with
`python -m app.cli purge-meal-images` (needs `SUPABASE_SERVICE_ROLE_KEY`, used
only by that command, never by the API).

## AI food recognition (Phase 1)

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/recognitions/text` | `{"text": "two rotis, one bowl of dal and 150g paneer"}` (max 1000 chars). Returns `recognition` (candidates) and `proposal` (grounded items). |
| POST | `/v1/recognitions/image` | `{"image_id": "<id from POST /v1/meal-images>"}`. Reads the caller's own stored (metadata-free) photo; another user's id is 404. |
| POST | `/v1/proposals/ground` | Re-prices items after the user edits a name, picks a food, or changes portion/unit. No AI call. |

**Nothing is saved by these endpoints.** The app logs items through the normal
`food_logs` insert only after the user confirms each one on the review screen.

How a result is built:

1. **Recognition** (`app/services/recognition/`): the model returns a strict
   JSON schema with food names, quantities, units, visual weight estimates and a
   0–1 confidence. The schema has **no nutrition fields**; anything outside the
   contract is rejected or dropped. Quantities marked as stated by the user are
   kept only if they actually appear in the text. Photos never count as stated
   quantities.
2. **Matching** (`search_food_catalogue`, migration 007): only a confident match
   (score ≥ 0.85, 0.10 ahead of the next) is selected. Otherwise up to three
   options are returned and the user chooses.
3. **Portion** (`app/services/grounding.py`): grams from the stated amount, the
   food's catalogue serving (piece/bowl/glass…), a typical household measure
   (flagged), or the visual estimate (flagged, rounded to 5 g). Nothing is guessed
   when there is no basis: the user is asked.
4. **Nutrition** (`food_portion`, migration 010): computed in the database from
   the catalogue's per-100 g values with the same rounding as `food_logs`, so the
   proposal equals what gets logged. Missing nutrients are listed, never invented.

Each item reports **three separate confidences** (recognition, match, portion)
and plain warnings (`choose_food`, `portion_estimated`, `serving_size_assumed`,
`nutrition_unavailable`, …).

**Model and provider.** Google Gemini via the `google-genai` SDK. Default
`gemini-3.8-flash` (a stable model with image input and structured output),
thinking level `medium`, JSON-schema response. If the model is overloaded (5xx)
or takes longer than 30 s, the backend falls back to `gemini-3.5-flash-lite`
(`RECOGNITION_FALLBACK_MODELS`), so a request takes about a minute at most. Safety blocks become a 422
"couldn't be analysed". The provider is behind `RecognitionProvider`
(`providers.py`), so another model or vendor can be swapped in. Without
`GEMINI_API_KEY` the endpoints return 503 and the rest of the API works normally.

**Privacy.** Meal photos (already stripped of EXIF/GPS) and descriptions are
sent to Google (Gemini API) for recognition. No user id, email or token is sent. Do not
enable this in production until your privacy policy says so.

**Limits.** 30 recognitions per user per hour (in-process: with several
instances, each counts separately), 12 items per result. Errors: 503 not
configured, 504 provider timeout, 429 rate-limited (with `Retry-After`), 422
empty/unusable input or refused, 502 provider failure or unusable output.

## Configuration

Copy `.env.example` to `.env` for local use (git-ignored), or set the same
variables in your host. Startup fails with a clear error if anything required
is missing or inconsistent. Validation errors never echo values, so secrets
don't end up in logs.

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | yes | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | yes | anon/publishable key, **not** the service-role key |
| `ALLOWED_ORIGINS` | in production | exact web origins, comma-separated; `*` refused |
| `ENVIRONMENT` | no | `production` (default), `development`, `test`. Production also requires https. |
| `SUPABASE_JWT_ALGORITHMS` | no | default `ES256` |
| `SUPABASE_JWT_SECRET` | only with HS256 | legacy projects |
| `SUPABASE_JWT_ISSUER`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_AUDIENCE` | no | derived from `SUPABASE_URL` |
| `GEMINI_API_KEY` | for AI recognition | backend only; never in the app |
| `RECOGNITION_MODEL` | no | default `gemini-3.8-flash` |
| `RECOGNITION_EFFORT` | no | Gemini thinking level: `low`, `medium` (default), `high` |
| `RECOGNITION_FALLBACK_MODELS` | no | comma-separated, default `gemini-3.5-flash-lite` |
| `RECOGNITION_TIMEOUT_SECONDS` (per model), `RECOGNITIONS_PER_USER_PER_HOUR`, `RECOGNITION_MAX_ITEMS`, `RECOGNITION_MAX_TEXT_CHARS` | no | 30, 30, 12, 1000 |

## Run locally

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate            # Windows; macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env              # then edit; load it with your shell or a tool of choice
uvicorn app.main:create_app --factory --reload --env-file .env
```

Point the app at it by setting `EXPO_PUBLIC_API_BASE_URL=http://<your-LAN-IP>:8000`
in the app's `.env` (a phone can't reach `localhost` on your computer) and
restarting Expo.

## Docker

```bash
cd backend
docker build -t calorie-tracker-api .
docker run --rm -p 8000:8000 --env-file .env calorie-tracker-api
```

The image is multi-stage, runs as an unprivileged user, contains only `app/`
(no tests, no `.env`), has a `/health` HEALTHCHECK, and listens on `$PORT`
(default 8000). Behind a load balancer, set `FORWARDED_ALLOW_IPS` to its
address so `--proxy-headers` trusts it.

## Tests

```bash
cd backend
.venv/Scripts/python -m pytest                 # unit tests: no network, no Supabase needed
```

Unit tests sign tokens with a throwaway P-256 key and serve the JWKS and
PostgREST from an in-memory transport.

**Needs a real Supabase stack:** `tests/integration/` (marker `integration`)
signs up real users on the **local** stack and checks real tokens, JWKS,
PostgREST and RLS end to end. It refuses to run against a non-local URL.

```bash
npm run db:start                                   # repo root
SUPABASE_INTEGRATION=1 SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_ANON_KEY=<ANON_KEY from `supabase status -o json`> \
.venv/Scripts/python -m pytest -m integration
```

The Phase 1 integration tests also need INDB loaded locally (they skip
otherwise). Recognition is tested there with a scripted provider. The one test
that calls the real model is opt-in and costs money:
`GEMINI_LIVE=1 GEMINI_API_KEY=... pytest tests/integration -k real_model`.

## Not production-ready yet

It starts, passes its tests and runs in Docker, but before real traffic it
still needs: a chosen host and TLS termination; rate limiting; structured
logging/metrics and error reporting; a CI pipeline running these tests;
dependency vulnerability scanning; and load testing. See the Task 5 report.
