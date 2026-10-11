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

**Correction (later the same day).** The author then stated that their coupons work for
*everything* at Sakura, not only the Cloud panel (author-stated; I have not verified it, and my
earlier "Cloud-only" reading came from a single search snippet). So the coupon is **not** what
separates Cloud from VPS, and a VPS would have been covered too. The article therefore does not give
the coupon as the reason; it says Cloud was chosen for the build-it-yourself panel (server, disk,
network and packet filter as separate parts) — wording proposed by me, for the author to confirm.

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

**Billing.** Starts when the server is created and powered on. **[documented]** The official manual
(<https://manual.sakura.ad.jp/cloud/payment/server-charge.html>) says the *server* charge (CPU/memory)
stops when the server is stopped, while the *disk* is billed until it is deleted (a 2017 announcement
says the same). **Correction:** an earlier version of these notes and of the article draft said
billing continues after a stop until deletion — that overstated it. Global IP, shared segment/switch
and packet filter are **not mentioned on that page [unverified]**. To be sure nothing keeps billing,
delete the server **and** its disk.

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

## Step 9 — Let setup run without typing the sudo password (and a mistake)

**Attempted.** `sudo` on the server asks for the admin password, which must not
pass through anyone but the author. Plan: allow `ubuntu` to use `sudo` without a
password *for the duration of the setup*, and remove that again at the end.

**Mistake [verified].** The author pasted the commands into the wrong terminal
tab: twice they ran on the **Mac** instead of the server. Consequences, all
found and fixed: (a) `passwd` ran for the Mac user and **changed the Mac login
password** (it prints a keychain warning after a successful change); (b) a
stray `/etc/sudoers.d/90-setup-nopasswd` was created on the Mac (it named a
user that does not exist there, so it did nothing) and was deleted. The Mac
password revert is a separate, still-open item.
**Fix.** Every later server step was launched in its **own dedicated terminal
tab with the command already typed** and routed through the server connection,
so the author only types a password when that tab asks for it.
**Lesson for the article:** several terminals look identical. Make the prompt
say where you are (`ubuntu@suisuinavi-api` vs `sky@…`) before typing anything.

**Result [verified].** `sudo -n true` succeeds on the server; the file passes
`visudo -c`.

---

## Step 10 — Update Ubuntu, reboot

`apt-get update` then `apt-get upgrade`: **276 packages** upgraded on a
just-created image; Ubuntu then reported "System restart required". Rebooted
(back and answering SSH in about 23 s). The running kernel stayed
`6.8.0-62-generic` (no newer one was installed); the reboot was for upgraded
system libraries. 5 packages remain upgradable (held back).

*Note for the article:* a brand-new server image is already out of date — the
first job on any new server is updating it.

---

## Step 11 — Install Docker (official repository, key checked)

Added Docker's apt repository and checked the downloaded signing key's
fingerprint against the one Docker publishes: `9DC8 5822 9FC7 DD38 854A E2D8
8D81 803C 0EBF CD88` — **match [verified]**. Installed **Docker 29.9.0** and
**Compose v5.6.0**; the Docker service is enabled at boot.
`ubuntu` was deliberately **not** added to the `docker` group (that group is
effectively root); commands use `sudo docker …`.

---

## Step 12 — Copy the code, create the config, start the stack

**Code.** Copied with `rsync` from the Mac, **not** `git clone`: the branch
with `docker-compose.vps.yml` and the health change is only local and nothing
is pushed to GitHub without being asked. (When the branch is merged, replace
this with `git pull` on the server.)

**Config.** `.env` created **on the server**, secrets generated there with
`openssl rand` (never displayed, never on the Mac or in the repo), mode `600`:
production mode, **registration closed**, max 10 users, allowed origin
`https://suisuinavi.sakura.ne.jp`.

**Start.** `sudo docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build`
→ three containers (`db`, `api`, `caddy`), database and API **healthy**; the
migration ran against the new database. Only Caddy is published on all
interfaces (port 80); the API (8000) and PostgreSQL (5432) are bound to
`127.0.0.1`. Restart policy `unless-stopped` on all three.

---

## Step 13 — The test that counts, from the Mac

```bash
curl http://<SERVER_IP>/api/health
{"status":"ok","service":"sui-sui-navi-api"}      # HTTP 200, 0.15 s  [verified]
```

| Check | Result [verified] |
|---|---|
| `/docs`, `/openapi.json` | 404 (disabled in production) |
| `/api/fields` without login | 401 |
| `POST /api/auth/register` | 403 — registration closed |
| TCP 8000, TCP 5432 from the Internet | **time out after 5 s** (silent drop) |

**Why the timeout matters.** Those two ports are bound to loopback, so even with
no firewall a connection would be *refused* immediately. A *timeout* means the
packet never arrived — the Sakura packet filter dropped it. This proves the
firewall works, which step 8 could not.

**Public listeners [verified, `ss -ltnp`].** Only `:22` (sshd) and `:80`
(Docker's proxy for Caddy). `:8000` and `:5432` are `127.0.0.1` only.

**Resources [verified, idle]**: containers Caddy 53 MiB + API 64 MiB + PostgreSQL
34 MiB ≈ 150 MiB; whole system 592 MiB used of 1.9 GiB; disk 4.1 GB of 20 GB.
A 1 GB plan would very probably have been enough — not tried.

---

## Step 14 — Does it survive a reboot?

Rebooted the server with `systemctl reboot` and polled `/api/health` from the
Mac every 3 s: no answer for ~24 s, then
`{"status":"ok","service":"sui-sui-navi-api"}` again **27 s after the request,
with nobody logged in [verified]**. Containers came back `healthy`; the
migration state (`0001_initial`) was intact in the database volume.

The API's own access log showed the **real client address** (not Caddy's
container address) — the `FORWARDED_ALLOW_IPS` fix from step 3 working in
production **[verified]**. (The address is the author's home IP; never publish it.)

**This is the point of the article:** the Python service now runs without the
Mac, restarts itself after a power cycle, and is reachable from anywhere.

*Not done:* the planned "run it by hand, close the terminal, watch it die" demo
(the reboot test shows the same thing from the other side). Still worth a
screenshot pair if the article wants the contrast.

---

## Still to do (server is live and billing)

| # | Item | Notes |
|---|---|---|
| a | ~~Remove passwordless sudo on the server~~ **DONE** — file removed, `sudo -n true` now blocked [verified] | Setup-only loosening |
| b | ~~Change the server admin password~~ **DONE** — `passwd: password updated successfully` [verified]; the first try was rejected as too short | It was visible in a Sakura dialog |
| c | ~~Revert the Mac login password~~ **DONE** — changed back in a dedicated tab (same keychain warning as after the mistake); that the *right* password was restored cannot be checked from here | If macOS later asks for a keychain password, use the original |
| d | Optional: passphrase for the SSH key (`ssh-keygen -p -f ~/.ssh/sakura_cloud_ed25519`) | Key currently has none |
| e | HTTPS: `api.suisuinavi.sakura.ne.jp` → server IP, then edit `deploy/Caddyfile`, publish 443, open 443 in the packet filter | Article 3; needs DNS control |
| f | Backups: nightly `pg_dump` | Before any real user data |
| g | **Delete the server and its disk when finished**, or decide to keep paying | Disk bills until deleted; server bills only while running |

## Screenshots

Captured (11), stored outside the repo in `~/Pictures/SuiSuiNavi-blog/article1/`, account ID and IP
cropped out, and uploaded to the WordPress media library (IDs 64–74, mapped in `article-1-media.json`):
01 plan · 02 Ubuntu 24.04.2 archive · 03 packet filter rules · 04 server created · 05 `/api/health` JSON
in the browser · 06 server detail · 07 NIC + packet filter in the form · 08 hostname / public key /
"no SSH password login" (**uses a throwaway demo key, not the real one**) · 09–10 Swagger UI from a
*development* copy on the Mac (production hides `/docs`) · 11 production `/docs` = 404.
12 `ssh-keygen` with empty passphrase — a **recreation** with a throwaway key (`/tmp/demo_key`, deleted) because the
original terminal window had been closed; the article caption says so. Media ID 81.
13 step-4 `ping` / `nc` results with the IP replaced by `<サーバーのIP>` (a replay of the real commands through a masking script;
the first version leaked the IP through `nc`'s stderr message and was caught before any screenshot was taken). Media ID 84.
14 first SSH login (fingerprint question → `yes` → prompt): a **replay** against a throw-away `known_hosts` file via a masking
script that refuses to print if any IP survives; both IPs (server, the Mac's public IP in `Last login`) are replaced and the
host-key fingerprint is cut to its first 6 characters (host keys are searchable on scanner sites). The caption and the
image footer say it is a replay. The Mac prompt line was cropped off. Media ID 88.
Uploaded media files are reachable by URL even while the post is a draft — they were checked for IPs,
IDs and passwords first.
Still to take by hand (terminal, **hide the IP**): `docker compose ps`
all healthy · `curl` from the Mac · `free -h` / `docker stats` · the reboot polling
output (steps 13–14). Never capture the Sakura "operation completed" dialog (it
prints the admin password).

## Facts still to check

- Is the 20 GB disk billed on top of the ¥3,190 estimate, and are the public IP / packet filter
  billed while the server is powered off? (Server stops billing when stopped and disk bills until
  deleted — **[documented]**; IP/switch/packet filter **[unverified]**.)
- Does the coupon actually cover it, and what is its balance / expiry?
  **[unverified]**
- The default hostname / reverse DNS of a Cloud server, and whether it is on the
  same "site" as `suisuinavi.sakura.ne.jp` (affects cookie login, see
  `docs/AUTH_ARCHITECTURE.md` §4). **[unverified]**
- Can the Rental Server panel point a subdomain of its initial domain at an
  external IP? **[unverified]**
- The rate limiter with two real clients behind Caddy (the mechanism is
  verified, the limit itself is not).

---

## Step 15 — the app's own address redirected to the blog; fixed (2026-10-11)

**Symptom [verified].** `suisuinavi.sakura.ne.jp/` (README: "production") answered `301` to
`sakurakai.sakuraweb.com/`, including `/index.html` and `/js/app.js`. The app was only reachable on GitHub Pages.

**Cause [verified in the Sakura control panel, read-only].**
- Both domains use the same document root `~/www/` (ドメイン/SSL list).
- `~/www/.htaccess` had a block `old-host redirect 2026-09-12` (`RewriteCond HTTP_HOST suisuinavi.sakura.ne.jp` →
  `301` to the blog host). WordPress "home" is the host root; its core files are in `~/www/michibiki/`.
- `~/www/` held only `index.php`, `.htaccess`, `michibiki/`. **No app files.** The GitHub Actions deploy last
  succeeded on 2026-09-06 (10 runs, public API); the files were gone after the blog restructure of 2026-09-11.

**Fix [verified with curl and a browser].**
1. `.htaccess` copied to `.htaccess.bak-20261011` (restore = copy it back over `.htaccess`).
2. Folder `~/www/suisuinavi/` created; `suisuinavi-app.zip` (built with `git archive origin/main`, public files only)
   uploaded and unpacked there by the author (the assistant's own unpack click was refused by the permission system).
3. `.htaccess` block replaced (saved by the author): on the host `suisuinavi.sakura.ne.jp`, `/michibiki…` still
   `301`s to the blog, everything else is rewritten to `/suisuinavi/…`. The blog host is untouched.
4. Deploy workflow + docs point at `www/suisuinavi/` — branch `fix/sakura-app-subfolder` (local, **not pushed**).

**Result [verified].** `suisuinavi.sakura.ne.jp/` → 200, title スイスイナビ, 517 KB, no console errors; css/config/data
files 200; `/michibiki/…` → 301 to the blog; blog home, wp-login, REST, `?cat=` unchanged; backup file → 403.
Browsers cache the old *permanent* redirect: test in a private window or add a query string.

**Open [verified defect].** Any URL that does not exist on the app host (e.g. `/robots.txt`, `/favicon.ico`) returns
**500** instead of 404: after the rewrite to `/suisuinavi/…` the WordPress fallback rule sends it to `/index.php`, which
the host rule rewrites again → loop. Proposed fix (4 lines inside the same block, not applied yet):
`RewriteCond HOST…` + `RewriteCond %{REQUEST_FILENAME} !-f` + `!-d` + `RewriteRule ^ - [R=404,L]`.
Also: `suisuinavi-app.zip` is still in `~/www/suisuinavi/` (public, harmless, to be deleted).
Screenshots: `~/Pictures/SuiSuiNavi-blog/app-host-fix/` 01–13 (09 is a dialog that was never confirmed).
