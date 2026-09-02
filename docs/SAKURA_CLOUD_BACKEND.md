# Sakura Cloud Backend

The self-hosted `cloud_backend/` FastAPI service that replaces Supabase as
SuisuiNavi's production accounts/fields API, running on a Sakura Cloud VM —
architecturally separate from `backend/` (the local MAVLink/drone service)
and from the Sakura **Rental Server** frontend deployment
([SAKURA_DEPLOYMENT.md](SAKURA_DEPLOYMENT.md)).

See also: [AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md) (auth/session design
in depth) and [SAKURA_CLOUD_DEPLOYMENT.md](SAKURA_CLOUD_DEPLOYMENT.md) (exact
manual VM setup, DNS/HTTPS, GitHub secrets, backups).

---

## 1. Why a third deployment target

Before this work, SuisuiNavi had two: the Sakura **Rental Server** (static
frontend, `index.html`/`css/`/`js/`/`config/`/`data/`, deployed by
`.github/workflows/deploy-sakura.yml`) and `backend/` (a **local-only**
FastAPI service that owns the serial MAVLink connection to a Pixhawk —
never deployed anywhere, runs on the field computer next to the drone).

The originally planned third piece — a hosted Supabase project for
accounts/fields — is replaced by `cloud_backend/`, a **new, separate**
FastAPI + PostgreSQL service, self-hosted on a Sakura Cloud VM. Three
deployment targets now exist, each with one job:

| Target | What it is | Deployed by | Owns |
|---|---|---|---|
| Sakura Rental Server | Static frontend | `deploy-sakura.yml` | Nothing stateful — a browser runtime |
| Sakura Cloud VM (new) | `cloud_backend/` API + PostgreSQL | `deploy-cloud-backend.yml` (tests only for now — see §9) | Accounts, sessions, fields, water points, observations, water targets |
| Field computer (local) | `backend/` MAVLink service | Never (manually run in the field) | The serial connection to the Pixhawk |

## 2. Architecture

```
                    internet
                        │
        ┌───────────────┴────────────────┐
        │                                 │
        ▼                                 ▼
suisuinavi.sakura.ne.jp        api.suisuinavi.sakura.ne.jp   (Sakura Cloud VM,
(Sakura Rental Server,          │                              hostname/DNS not
 static frontend)                │                              yet provisioned —
        │                        ▼                              see §8/§9)
        │              ┌───────────────────┐
        │  HTTPS        │  Caddy/Nginx      │  reverse proxy, HTTPS termination
        │  fetch()       │  (port 80/443)    │
        │  credentials:  └─────────┬─────────┘
        │  "include"               │ localhost / container network only
        │                          ▼
        │              ┌───────────────────┐
        └─────────────▶│  cloud_backend/    │  FastAPI + Uvicorn, ONE worker
                        │  (accounts/fields) │  (see app/security.py's RateLimiter
                        └─────────┬─────────┘   docstring for why)
                                  │ private/container network only —
                                  │ never publicly exposed (§6)
                                  ▼
                        ┌───────────────────┐
                        │  PostgreSQL        │
                        └───────────────────┘

  (separate, unrelated machine)
┌─────────────────────────┐
│ field computer            │
│  backend/ (local MAVLink) │──serial──▶ Pixhawk / drone
│  never deployed;           │
│  no route to the above     │
└─────────────────────────┘
```

**The public cloud server does not own the serial MAVLink connection, and
never will as part of this work.** `cloud_backend/` has no dependency on,
import from, or network path to `backend/`. See §5 for the enforced
boundary and `app/api/future_ingestion.py`'s module docstring for the
drone-safety reasoning in full.

## 3. Repository layout

```
cloud_backend/
  app/
    main.py            FastAPI app factory: CORS, security headers, body-size
                        limit, global exception handler, /api/health, routers
    config.py           Settings (env-driven, SUISUI_CLOUD_ prefix)
    database.py          Async SQLAlchemy engine/session (Base, get_db)
    security.py           Argon2id hashing, session/CSRF tokens, RateLimiter
    dependencies.py       get_current_user, require_csrf
    models/
      db.py                ORM models (User, Session, Profile, Field, …)
      schemas.py           Pydantic request/response schemas
    auth/
      service.py           register_user, authenticate, session lifecycle
      router.py            /api/auth/register, /login, /logout, /me
    api/
      fields.py, water_control_points.py, field_observations.py,
      field_water_targets.py, profile.py    per-resource CRUD routers
      future_ingestion.py  reserved GNSS/sensor/drone-telemetry namespaces
                           (§5 — ingestion-only, 501-stubbed)
    email/
      sender.py            SMTP abstraction, not wired into any auth flow yet
  migrations/              Alembic (see §7)
  tests/                   pytest suite (see §10)
  Dockerfile, docker-compose.yml, .env.example   local/VM run (see §8)
  requirements.txt, requirements-dev.txt
```

This mirrors `backend/`'s own conventions deliberately (`fastapi~=0.115.0`,
plain `requirements.txt`, no Poetry/uv) so a contributor already familiar
with one Python service in this repo recognizes the other, while the two
remain fully independent installs (`cloud_backend/requirements.txt` never
imports anything from `backend/`, and vice versa).

## 4. Database schema

PostgreSQL, preserving the same table shapes and semantics the Supabase
schema used (`supabase/migrations/001_accounts_fields.sql`), so this is a
drop-in replacement target for the frontend's existing sync contract, not a
redesign:

| Table | Key columns |
|---|---|
| `users` | `id` uuid PK, `email` (unique, normalized lowercase), `password_hash`, `is_active`, `email_verified`, timestamps |
| `sessions` | `id` uuid PK, `user_id` FK, `token_hash` (SHA-256 of the opaque bearer token — the plaintext is never stored), `expires_at`, `revoked_at`, `csrf_token`, `user_agent` |
| `profiles` | `user_id` PK/FK, `display_name` |
| `fields` | `id` uuid PK, `owner_id` FK, `legacy_field_id`, `name`, `area_m2`, `source_nmea_filename`, `boundary` jsonb, `record` jsonb, `local_updated_at`; **unique `(owner_id, legacy_field_id)`** |
| `water_control_points` | same shape, `legacy_point_id`, `point_type`, `lat`, `lon`; unique `(owner_id, legacy_point_id)` |
| `field_observations` | same shape, `legacy_observation_id`, `observation_type`, `severity`; unique `(owner_id, legacy_observation_id)` |
| `field_water_targets` | **composite PK** `(owner_id, legacy_field_id)`, `target_water_level_cm` — no separate id, no delete route (a target is cleared by upserting `null`, never removed as a row) |

**Why `(owner_id, legacy_field_id)` and not `legacy_field_id` alone:** two
different farmers both using the device-local id `paddy-001` must not
collide. There is no database-level Row Level Security here (that was
Supabase/Postgres's mechanism, driven by `auth.uid()` — see
`app/models/db.py`'s module docstring) — without a hosted auth/JWT layer
feeding the database session, the equivalent boundary is enforced entirely
at the **application layer** instead: every query in `app/api/*.py` is
explicitly filtered by `owner_id == current_user.id`, and `owner_id` is
never accepted from a request body — the Upsert schemas don't even declare
that field, so pydantic v2 silently drops it if a client sends one. See
[AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md) — "Multi-user isolation" and
`tests/test_multi_user_isolation.py` for the enforcement and its tests.

**`record jsonb`:** each user-owned table keeps the device's own record
verbatim in a `record` column, exactly like the Supabase schema did — the
frontend reconstructs a local record from `record` alone, never from the
individual denormalized columns (which exist only so the table stays
queryable). See `js/cloud/field-sync-core.js`'s row-builder functions,
which this schema's column names were matched against directly.

## 5. Drone safety boundary — read this before adding anything under `/api/drone`

`app/api/future_ingestion.py` reserves `/api/gnss`, `/api/sensors`, and
`/api/drone` namespaces for **future** telemetry/observation ingestion. Every
route in it validates its input shape and returns `501 Not Implemented` —
nothing is persisted yet, and nothing pretends to succeed.

`/api/drone/telemetry` is the only drone-related route that exists, and it
is **read/ingestion-only by design, permanently**:

- There is no route for arm, disarm, takeoff, land, RTL, a flight-mode
  change, RC override, a motor test, a mission upload, or a parameter
  write. None of those concepts appear in `cloud_backend/` at all.
- `cloud_backend/` has no network path to a Pixhawk. The serial MAVLink
  connection is owned exclusively by `backend/app/mavlink/` on the local
  field computer — that module is not imported here, not deployed to the
  same host as this API, and not reachable from it.
- A regression test (`tests/test_future_ingestion.py`) statically asserts
  the app's route table contains no path under `/api/drone` whose path
  string matches `arm|disarm|takeoff|land|rtl|mode|override|motor|mission|param`
  — so a future change that tried to add real flight control here would
  fail CI, not just violate a comment.

If a future task wants the local drone backend to push telemetry to this
cloud API over HTTPS, that is in scope for `/api/drone/telemetry`'s
ingestion path — remote **flight control** through this service is not, and
was explicitly out of scope for this work.

## 6. Network posture

- **PostgreSQL is never exposed publicly.** It listens on the container/private
  network only (`docker-compose.yml`'s `db` service publishes its port to
  `127.0.0.1` only, for local developer inspection — not the production
  topology; see [SAKURA_CLOUD_DEPLOYMENT.md](SAKURA_CLOUD_DEPLOYMENT.md)).
- **Only 80 (redirect/cert issuance) and 443 are public** on the Sakura Cloud
  VM; SSH is restricted to admin access. The API process itself is reached
  only through the reverse proxy, never directly.
- **CORS is an explicit allow-list, never a wildcard**, and is refused
  together with `allow_credentials=True` by FastAPI's `CORSMiddleware`
  itself if ever misconfigured that way (`app/main.py`).
- **No public endpoint can arm, disarm, or otherwise command a vehicle** — see §5.

## 7. Migrations

Alembic, not manual `CREATE TABLE` — `cloud_backend/migrations/`, with a
single hand-written initial migration (`0001_initial.py`) that was
cross-checked column-for-column and constraint-for-constraint against
`app/models/db.py` (not autogenerated — see that migration's own docstring
for why: this repository's development environment has no local/Docker
PostgreSQL to autogenerate against faithfully, since JSONB/UUID are
Postgres-specific types a SQLite-based autogenerate run would get wrong).

`migrations/env.py` derives its connection URL from the same
`SUISUI_CLOUD_DATABASE_URL` the running app reads, swapping `+asyncpg` for
`+psycopg2` — migrations run synchronously (a one-shot, ordered operation,
where async buys nothing but complexity), while the app itself stays async
end-to-end for request concurrency.

Running migrations: `alembic upgrade head` (from `cloud_backend/`, with
`SUISUI_CLOUD_DATABASE_URL` set). The Docker image runs this automatically
on every container start (`Dockerfile`'s `CMD`) — safe to repeat, since
Alembic no-ops once the database is already at head.

## 8. Local development / integration environment

```bash
cd cloud_backend
cp .env.example .env    # edit — see that file's comments
docker compose up --build
curl http://127.0.0.1:8000/api/health
```

Starts real PostgreSQL + the real API, so the actual frontend
(`npm run serve`, port 4173) can be pointed at `http://127.0.0.1:8000` for a
genuine end-to-end check — see `config/cloud-config.js`'s `sakura` provider
block. **Not the production topology**: the API port is published directly
here for local convenience; production puts a reverse proxy in front and
never exposes Uvicorn's port directly (see
[SAKURA_CLOUD_DEPLOYMENT.md](SAKURA_CLOUD_DEPLOYMENT.md)).

**Local-cookie note:** cookies are scoped by hostname, not by port (per
RFC 6265 / [MDN's own note on this](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie)),
so a frontend at `http://127.0.0.1:4173` and an API at
`http://127.0.0.1:8000` correctly share the session/CSRF cookies with no
proxy needed — **as long as both are addressed as `127.0.0.1` consistently**.
`http://localhost:4173` is a *different* hostname from `127.0.0.1` as far as
the browser's cookie jar is concerned, even though both resolve to the same
machine — mixing the two will make the CSRF cookie silently invisible to the
frontend page's `document.cookie`. This was verified directly against a
real browser this session (see §10.1) after hitting exactly that mismatch.

No Docker was available in this session's development environment, so
`docker-compose.yml`/`Dockerfile` are written carefully but **not
themselves executed** — see §10 for exactly what was and was not verified.

## 9. CI

`.github/workflows/deploy-cloud-backend.yml` — **tests only**, deliberately
no deploy job yet (no Sakura Cloud VM exists — see
[SAKURA_CLOUD_DEPLOYMENT.md](SAKURA_CLOUD_DEPLOYMENT.md)'s manual checklist).
Separate from `deploy-sakura.yml` and never touches the Rental Server or
`/home/suisuinavi/www/`. Two jobs:

- `test` — the pytest suite against in-memory SQLite (fast, no external
  dependency, what a contributor's own machine runs).
- `integration` — the same pytest suite, **and** a real `alembic upgrade
  head`, against a real ephemeral PostgreSQL service container — the closest
  this CI gets to production without an actual VM. This is what actually
  exercises PostgreSQL's `ON CONFLICT ON CONSTRAINT` upsert syntax the
  SQLite-backed `test` job cannot fully verify (see §10.2).

Triggered on push/PR touching `cloud_backend/**`, plus manual dispatch.

## 10. Verification tiers

Being explicit about what was actually checked, and how, per this task's
own instruction not to claim more than was verified:

### 10.1 Real Sakura Cloud VM — NOT verified

No VM was provisioned. Nothing above was ever deployed or reached over a
real network beyond `127.0.0.1`. See
[SAKURA_CLOUD_DEPLOYMENT.md](SAKURA_CLOUD_DEPLOYMENT.md) for exactly what a
human needs to create before this tier can be attempted.

### 10.2 Docker Compose integration — written, NOT executed

No Docker was available in this session's environment (`docker`/`docker
compose` are not installed on this machine). `Dockerfile` and
`docker-compose.yml` were written to a known-good, standard pattern
(non-root user, single Uvicorn worker, Postgres health-checked before the
API starts, migrations run automatically) but **never actually built or
run**. This is the single largest unverified piece of this work.

### 10.3 Real browser against the real API, real PostgreSQL substituted with SQLite — verified

Since Docker/PostgreSQL were unavailable, but a genuine end-to-end frontend
check was still valuable, `cloud_backend`'s real FastAPI app was run
directly via `uvicorn` (not the Docker image) against a local **SQLite**
file — the app's `SUISUI_CLOUD_DATABASE_URL` is a plain SQLAlchemy URL, so
this is the real app and real route code, just pointed at a different
database driver than production uses. The real frontend
(`node scripts/dev-server.mjs`) was served at `http://127.0.0.1:4173`,
`config/cloud-config.js` was **temporarily** pointed at
`{provider: "sakura", apiBaseUrl: "http://127.0.0.1:8000"}` (reverted before
committing — the shipped config stays `provider: null`), and the actual
login screen was driven through a real browser (register → session cookie
set, HttpOnly confirmed via `document.cookie` showing only the CSRF cookie
→ full field/water-point/observation/water-target sync fired with zero
errors → logout revoked the session server-side → login restored it →
**a full page reload kept the farmer signed in**, proving the cookie-based
session model persists correctly across reloads). Network panel confirmed
every request, including the CSRF-protected `PUT /api/profile`, returned
the expected status with no unexpected errors.

This verifies the frontend integration (Phase 9) and the session/cookie
model (Phase 5) genuinely end-to-end. It does **not** verify PostgreSQL-specific
SQL (the `ON CONFLICT ON CONSTRAINT` upserts in `app/api/fields.py` etc.) —
that gap is covered by:

### 10.4 pytest suite — verified (97/97 passing), two backends

`cloud_backend/tests/` runs by default against in-memory SQLite (fast, no
external dependency). The same suite can also run against a real PostgreSQL
by setting `SUISUI_CLOUD_TEST_DATABASE_URL` — this is exactly what CI's
`integration` job does (§9), the only place the PostgreSQL-specific named
`ON CONFLICT ON CONSTRAINT` path is exercised for real. Locally, only the
SQLite tier was actually run and observed passing (97/97) — the PostgreSQL
tier has not been executed anywhere yet, since it requires either Docker
(unavailable) or the CI run this task was told not to trigger by pushing.

### 10.5 Frontend unit tests — verified

`npm test` (Node's built-in test runner, `tests/unit/*.test.js`): 483/483
passing, including 4 new tests for the `sakura` provider branch added to
`js/cloud/cloud-config.js`. Zero regressions in the pre-existing 479.

## 11. Supabase provider status

**Not deleted.** `js/auth/supabase-auth-client.js`, `js/cloud/supabase-cloud-store.js`,
`supabase/migrations/001_accounts_fields.sql`, and `supabase/tests/rls_verification.sql`
remain exactly as they were, fully functional, and still selectable via
`config/cloud-config.js`'s `provider: "supabase"`. The adapter contract
(`AuthClient`/`CloudStore`) both providers implement is what made adding
`sakura` as a third `provider:` option additive rather than a rewrite —
`js/auth/auth-controller.js`'s `initProvider()` now branches on
`PROVIDER_MOCK` / `PROVIDER_SAKURA` / (else) `PROVIDER_SUPABASE`, and every
existing Supabase-path browser/unit test is unmodified and still passing.

**Production should use `provider: "sakura"`** once a real VM/DNS exist
(this task's explicit instruction). Whether to eventually retire the
Supabase adapter entirely is a separate decision for later, once the Sakura
provider has real production hours behind it — there was no reason to
delete tested, working fallback code as part of this task.

## 12. What is NOT built yet

- Email verification / password-reset UI and the actual sending of
  verification/reset emails — `app/email/sender.py` exists as an
  abstraction (Phase 6) but is not wired into `auth/service.py`'s register
  flow. `require_email_verification` defaults to `false`.
- GNSS session/observation and sensor water-level ingestion (`501` stubs
  only — §5).
- Any deploy job in `deploy-cloud-backend.yml` (§9) — intentionally, until
  a VM exists.
- A distributed rate limiter — `app/security.py`'s `RateLimiter` is
  in-memory/per-process, correct for one Uvicorn worker on one VM, and
  explicitly documented as not scaling past that without adding Redis.
