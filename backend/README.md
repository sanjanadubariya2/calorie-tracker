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

## Not production-ready yet

It starts, passes its tests and runs in Docker, but before real traffic it
still needs: a chosen host and TLS termination; rate limiting; structured
logging/metrics and error reporting; a CI pipeline running these tests;
dependency vulnerability scanning; and load testing. See the Task 5 report.
