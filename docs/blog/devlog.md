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

## Step 4 — Decide where it runs: a Sakura Cloud server, not a VPS

**Attempted.** Find the cheapest way to get a real Sakura server.

**Why.** Paying for a VPS was not wanted. Sakura VPS has a 2-week free trial
(card required) **[documented]**, but the author's Sakura coupons were said (by
someone at Sakura; **[unverified]** by me) to work for services in the *Sakura
Cloud* control panel. A search result also said Cloud coupons do not apply to
VPS or Rental Server **[documented, one source]**.

**Decision.** Use a **Sakura Cloud server** in the Tokyo 2nd Zone (it is the
panel the coupons belong to). The Ubuntu + Docker + Caddy setup from steps 1–3
is unchanged; only the order screens differ.

| | Sakura VPS 2 GB | Sakura Cloud 1 core / 2 GB |
|---|---|---|
| Price | ¥1,738/month **[documented]** | ¥16/hour, ¥159/day, **¥3,190/month cap** (the form's own estimate) |
| Notes | 3 vCPU, 100 GB | 20 GB SSD chosen; whether disk/IP are billed on top is **[unverified]** |

Cloud costs more than a VPS of similar size — the coupon is what makes it free.

---

## Step 5 — Create an SSH key on the Mac

**Attempted.** `ssh-keygen -t ed25519 -C "sakura-cloud" -f ~/.ssh/sakura_cloud_ed25519`
(typed by the author in the terminal so the passphrase never passes through
anyone else).

**Why.** Key-based login instead of a password: the private key never leaves
the Mac, and the server only stores the public half.

**Result [verified].** Key pair created. Problem: `~/.ssh/` did not exist at all
on this Mac, so this was the first key ever made here — `ssh-keygen` created
the folder.

---

## Step 6 — Firewall before server (Sakura "packet filter")

**Attempted.** Create a packet filter from Sakura's preset "filter unneeded
ports (Linux)" and attach it when creating the server.

**Why.** On Sakura Cloud's shared network a new server is directly on the
Internet. The filter runs *outside* the VM, so even a misconfigured server (or
Docker, which bypasses `ufw`) cannot expose a port the filter blocks.

**What the filter must do [verified, from the panel].**
- It is **stateless**: replies to the server's own outgoing connections are
  separate packets and must be allowed explicitly (rule: TCP/UDP destination
  ports 32768–61000), otherwise `apt` and `docker pull` fail.
- "If a packet matches no rule it is allowed" — so the last rule must be
  `ip deny`.

**Final rules [verified].** 1 SSH 22 · 2 HTTP 80 · 3 NTP (UDP source 123) ·
4 DHCP (UDP 68) · 5 ICMP · 6–7 reply traffic (TCP/UDP 32768–61000) · 8 IP
fragments · 9 `ip` deny. Removed from the preset: ports 25 (SMTP) and 110
(POP3) — no mail server here. SSH and NTP sources were set to `0.0.0.0/0`
(any): locking SSH to the home IP would break whenever it changes, so SSH is
protected by key-only login instead.

**Problem.** The Sakura session expired in the middle of editing. The page
hung, and after logging in again the saved filter **still had the original 11
rules** — the deletions and the *Apply* had been silently lost. Only
re-opening the filter and counting the rules revealed it.
**Fix.** Redid the edits and re-checked: rules (9), no pending-apply banner.
**Lesson for the article:** after saving a firewall change, reload the page and
look at what was actually saved.

---

## Step 7 — Create the server

**Settings [verified from the form and the API response].** Tokyo 2nd Zone ·
1 core / 2 GB · SSD 20 GB · Ubuntu Server 24.04.2 LTS · internet connection
(1 shared IP, 100 Mbps best effort) · the packet filter from step 6 · hostname
`suisuinavi-api` · SSH public key · **SSH password login disabled** · "install
usacloud" and "update packages" off · no startup script.

**Problems encountered.**
1. **A checkbox that did not stick.** "Do not allow SSH login with password
   authentication" looked ticked after my first click but was not. It was caught
   only by scrolling through the whole form before pressing Create, and the
   server's creation response confirmed `DisablePWAuth: true`.
   *Lesson:* verify a security setting from the result, not from the click.
2. **The panel prints the admin password in plain text.** After creation, one
   of Sakura's own result dialogs shows the request/response JSON including the
   password that was typed. **Never screenshot that dialog**, and clear any
   screenshot taken while it is open. (One such capture was deleted.) Because
   the password was visible on screen in a working session, treat it as
   exposed and change it after first login (`passwd`).
3. **Two Chrome browsers were connected** to the same account (this Mac and a
   Windows machine) and the automation asked which to use rather than guessing.
4. A platform notice was active in the panel (a Sakura fault notice about
   dedicated and Red Hat services, 2026-10-09). Unrelated to Ubuntu on Cloud
   **[unverified]**.

**Timing [verified].** About 2–3 minutes from pressing Create until the server
was powered on; most of it copying the 20 GB Ubuntu image to the new disk.

**Billing.** Starts at creation and **continues until the server is deleted**,
including while it is powered off (disk and IP) **[unverified for the powered-off
case — check before relying on it]**.

---

## Step 8 — First checks from the Mac (no login yet)

```bash
ping -c 2 <SERVER_IP>                 # replies, ~13 ms
nc -z -G 4 <SERVER_IP> 22             # open
nc <SERVER_IP> 22 </dev/null | head -1   # SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.12
nc -z <SERVER_IP> 80 / 8000 / 5432    # no connection
```

**Result [verified].** ICMP allowed, SSH answers with an Ubuntu 24.04 OpenSSH
banner, and 80 / 8000 / 5432 give no connection. Port 80 is closed only because
nothing listens yet (Caddy comes later); `nc` cannot tell "filtered" from
"refused", so port 8000 and 5432 being blocked by the filter specifically is
**not yet proven** — it will be checked once the containers are running.

---

## Still to do

| # | Step | Needs |
|---|---|---|
| 9 | First SSH login with the key; change the admin password; `apt update && upgrade` | Author types the key passphrase |
| 10 | "Run it by hand, close the terminal, watch it die" demo | Server |
| 11 | Install Docker, clone, `.env` (production, registration closed), `compose -f … -f docker-compose.vps.yml up -d` | Server |
| 12 | `curl` from the Mac; open port 8000/5432 check; reboot the server and confirm it comes back | Server |
| 13 | Try `api.suisuinavi.sakura.ne.jp` → the server IP, then HTTPS | Rental Server DNS panel |

## Facts still to check

- Is the 20 GB disk / the public IP billed separately from the ¥3,190 estimate,
  and what is billed while the server is powered off? **[unverified]**
- Does the coupon actually cover it, and what is its balance / expiry?
  **[unverified]**
- The default hostname / reverse DNS of a Cloud server, and whether it is on the
  same "site" as `suisuinavi.sakura.ne.jp` (affects cookie login, see
  `docs/AUTH_ARCHITECTURE.md` §4). **[unverified]**
- Can the Rental Server panel point a subdomain of its initial domain at an
  external IP? **[unverified]**
- Real memory and CPU on the server (`free -h`, `docker stats`).
- Does the stack come back on its own after `sudo reboot`?
