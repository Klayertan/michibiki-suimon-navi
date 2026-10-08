# Devlog — Article 1: a Python server on a Sakura VPS

Tags: **[verified]** observed in command output · **[documented]** from an
official page, not independently checked · **[unverified]** not checked.
No IPs, hostnames or secrets in this file — see [README](README.md).

Environment for steps 0–3: macOS, Docker Desktop 29.8, system Python 3.9.6,
repository branch `feature/vps-article1` (cut from `main` @ `07e4d24`).

---

## Step 0 — Look at what already exists (read-only)

**Attempted.** Read the repo before planning anything: layout, docs, git state,
the existing Sakura deployment pipeline, and every place GNSS / water-level /
field data is handled.

**Why.** The plan assumed the project was frontend-only and a backend had to be
written. Rewriting something that already works would waste the article and
risk the project.

**Result [verified].**
- Frontend: static, no build step (`index.html` + `js/` + `css/`), already live
  on a Sakura *Rental Server*, deployed by rsync from GitHub Actions. The
  WordPress blog is a separate install on the same server.
- `backend/` is a local-only MAVLink/drone service — unrelated to this series.
- **`cloud_backend/` already exists**: FastAPI + async SQLAlchemy + PostgreSQL +
  Alembic, Argon2 cookie sessions, CSRF, rate limiting, 7 tables, CRUD for
  fields / water points / observations / water targets, Dockerfile, compose
  file, CI. The frontend has a matching `sakura` provider, switched off
  (`provider: null`).
- All GNSS/NMEA parsing, area calculation and water-level logic runs **in the
  browser**. Water-level *readings* have no cloud table (only the target level
  does); `/api/gnss/*`, `/api/sensors/water-level`, `/api/drone/telemetry` are
  reserved stubs returning 501.

**Problem.** The brief said the backend was missing. It was not, and creating a
new `backend/` would also have collided with the existing drone `backend/`.

**Fix.** Reuse `cloud_backend/`. Article 1 becomes "deploy and run what exists",
Article 2 adds the real missing piece (water-level readings).

**Lesson for the article.** Read first; the honest story is "I had written a
backend and never run it anywhere", not "I wrote a backend today".

---

## Step 1 — Does the existing backend actually run?

**Attempted.** Build the repo's own Docker image, run its test suite, bring up
the compose stack with a real PostgreSQL, and call the API.

**Why.** The docs said Docker was never executed and the PostgreSQL test tier
had never run. Deploying to a server on top of unverified code would make every
later failure ambiguous ("is it the server or the code?").

**Commands** (run on a *copy* of `cloud_backend/` so the repo stayed untouched):
```bash
docker build -t suisui-cloud-api:probe .
docker run --rm ... python -m pytest -q          # SQLite tier, inside the image
docker compose up -d --build                      # API + PostgreSQL 16
curl http://127.0.0.1:8000/api/health
docker run --rm --network <compose-net> ... \
  -e SUISUI_CLOUD_TEST_DATABASE_URL=postgresql+asyncpg://... python -m pytest -q
```

**Expected.** Build OK; tests pass; migration creates tables; health 200.

**Actual [verified].**
| Check | Result |
|---|---|
| `docker build` | OK, 357 MB image |
| pytest, SQLite | 107 passed, 1 skipped |
| `alembic upgrade head` on real PostgreSQL | `0001_initial` applied; 7 tables + `alembic_version` |
| `GET /api/health` | 200 |
| pytest, real PostgreSQL | 108 passed, 0 skipped |
| Idle memory (Docker Desktop) | API ≈ 62 MiB, PostgreSQL ≈ 25 MiB |

**Problems encountered.**
1. The Mac's system Python is **3.9.6**; the project targets **3.12**. I did not
   try 3.9 — I ran everything in a Python 3.12 container instead. (Good
   "why Docker" material: the machine you develop on is not the machine you
   deploy to.)
2. `git status` in the repo took **4 min 32 s** with almost no CPU time —
   waiting on the filesystem. `~/Documents` is probably iCloud-synced
   **[unverified]**. Every git operation in that folder is slow.

**Final.** The code is sound; any later failure on the VPS is a server problem.

---

## Step 2 — Make `/api/health` say exactly what the plan says

**Attempted.** Change the health response from `{"status","environment"}` to
`{"status":"ok","service":"sui-sui-navi-api"}`.

**Why.** (a) That was the agreed success criterion. (b) `environment` told any
visitor whether the server was in `development` or `production`, which a
health check does not need to reveal. Nothing else in `cloud_backend/` or the
frontend reads that field **[verified: grep]**.

**Code.** `app/models/schemas.py` (`HealthResponse`), `app/main.py` (handler),
`tests/test_health.py` — exact-body assertion, works without login/CSRF, and a
production-mode test asserting the word "production" never appears.

**Expected → actual [verified].** Full suite: **109 passed, 1 skipped** (was
107 + 1; +2 new tests).

---

## Step 3 — Put Caddy in front, and find out what that breaks

**Attempted.** Add `docker-compose.vps.yml` (a compose *overlay*: the base file
is untouched) with a Caddy reverse proxy on port 80 in front of the API, plus
`deploy/Caddyfile`. Run the whole stack locally in **production mode**.

**Why.** The API should not face the Internet directly; Caddy accepts the
public connection and later handles HTTPS. Testing locally first means the VPS
step only tests the VPS.

**Command.**
```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
```

**Actual [verified]** (production mode, registration closed, via Caddy):
- `GET /api/health` → `{"status":"ok","service":"sui-sui-navi-api"}`, HTTP 200
- `GET /docs`, `GET /openapi.json` → 404 (docs are off in production)
- `POST /api/auth/register` → 403 (closed)
- `GET /api/fields` with no login → 401
- Whole stack idle: API ≈ 62 MiB, Caddy ≈ 15 MiB, PostgreSQL ≈ 82 MiB

**Problem found.** Behind a proxy, the API saw **Caddy's container address
(`172.18.0.4`) as the client for every request**. The login rate limiter keys
on client IP, so all visitors would have shared one bucket: one person's failed
logins could lock everyone out.

**Why it happens.** Uvicorn only believes the `X-Forwarded-For` header from
`127.0.0.1` by default. Caddy is a different container, so its header is
ignored.

**Fix.** `FORWARDED_ALLOW_IPS: "*"` on the `api` service in the overlay.
Acceptable only because the API's published port is loopback-only and Caddy
*replaces* (not appends to) `X-Forwarded-For`.

**Verified after the fix.** A request sent through Caddy with a forged
`X-Forwarded-For: 6.6.6.6` was logged as the address Caddy actually saw
(`192.168.65.1`, Docker Desktop's gateway) — neither the forged value nor
Caddy's address. Re-running with the setting reverted reproduced the bug
(`172.18.0.4`).

**Not tested.** The rate limiter itself under two real clients (only one source
IP was available locally). The mechanism is verified, not the end-to-end limit.

**Also noted.** Docker-published ports bypass `ufw` **[documented]**, so on the
VPS the Sakura packet filter — outside the VM — is the firewall that matters.

---

## Still to do (needs the real VPS)

| # | Step | Needs |
|---|---|---|
| 4 | Create the VPS (2 GB plan, Ubuntu) | **You** — account login and payment |
| 5 | Generate an SSH key on the Mac | No `~/.ssh/*.pub` exists yet **[verified]** |
| 6 | First login, non-root user, key-only SSH, packet filter 22/80 | VPS |
| 7 | "Run it by hand, close the terminal, watch it die" demo | VPS |
| 8 | Install Docker, clone, `.env`, `compose up -d` | VPS |
| 9 | `curl` from the Mac; reboot the VPS; confirm it comes back | VPS |
| 10 | Try `api.suisuinavi.sakura.ne.jp` → VPS IP, then HTTPS | Rental Server DNS panel |

## Facts to check on the real VPS (not yet known)

- 2 GB plan: ¥1,738/month, 3 vCPU, 100 GB, 3-month minimum, 2-week trial for
  card payments **[documented — summarised from the official page; confirm on
  the order screen]**
- Is Ubuntu 24.04 in the OS list? **[unverified]** (Sakura's startup-script news
  lists it; the plain OS list was not seen)
- What is the VPS's default hostname format? Which site is it on, relative to
  `suisuinavi.sakura.ne.jp`? **[unverified]** — decides whether cookie login can
  work against it (see `docs/AUTH_ARCHITECTURE.md` §4)
- Can the Rental Server panel point a subdomain of its initial domain at an
  external IP? **[unverified]**
- Real memory and CPU on the VPS (`free -h`, `docker stats`)
- Does the stack come back on its own after `sudo reboot`?
