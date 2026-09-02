# Sakura Cloud Deployment

Exactly what a human needs to create manually before `cloud_backend/` can
be deployed to a real Sakura Cloud VM, and how the (not-yet-live) deploy
pipeline is meant to work once that exists.

**Nothing in this document has been executed against a real server.** No
Sakura Cloud VM was provisioned as part of this task, and this file does
not claim otherwise — see [SAKURA_CLOUD_BACKEND.md](SAKURA_CLOUD_BACKEND.md)
§10 for exactly what tier of verification each other piece received. This
is the exact list of manual steps referenced at the end of the task's
completion report.

See also: [SAKURA_CLOUD_BACKEND.md](SAKURA_CLOUD_BACKEND.md) (architecture)
and [AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md) (auth/session design) —
and [SAKURA_DEPLOYMENT.md](SAKURA_DEPLOYMENT.md), the **existing, separate,
already-working** frontend pipeline this document must never be confused
with or interfere with.

---

## 1. What this is not

This is not a change to [SAKURA_DEPLOYMENT.md](SAKURA_DEPLOYMENT.md)'s
pipeline. `deploy-sakura.yml` keeps shipping the static frontend to the
Sakura **Rental Server** exactly as it does today — nothing about this work
touches that file, that server, or `/home/suisuinavi/www/`. This document
is about a **second, independent** server: a **Sakura Cloud VM**, a
different product in Sakura's lineup (a virtual machine you administer
yourself, as opposed to the Rental Server's managed shared hosting).

## 2. What must be created manually — checklist

**Nothing below has been done.** These are exact, actionable steps for a
human with access to the Sakura Cloud control panel. Values in `<angle
brackets>` are placeholders you fill in; nothing here invents a real IP,
hostname, or credential.

- [ ] **1. Create the VM.** Sakura Cloud control panel → create a new server.
      A minimal recommendation for this workload (FastAPI + PostgreSQL, one
      Uvicorn worker, expected low-to-moderate traffic for a farming
      application, not a high-throughput API): **2 vCPU / 4 GB RAM / 50 GB
      SSD** is a reasonable starting size — PostgreSQL and a Python process
      both want headroom, and this is comfortably resizable later if usage
      grows. Do not undersize to 1 GB RAM; PostgreSQL alone is uncomfortable
      there.
- [ ] **2. Choose the OS.** Ubuntu 22.04 LTS or 24.04 LTS (whichever Sakura
      Cloud currently offers) — matches this repository's Docker base image
      (`python:3.12-slim`, Debian-based) and has the widest first-party
      Docker support/documentation.
- [ ] **3. Configure an SSH public key at creation time** (Sakura Cloud lets
      you inject one during server creation). Generate a **dedicated** deploy
      keypair, do not reuse your personal key or the existing Rental Server's
      `SAKURA_SSH_PRIVATE_KEY`:
      ```bash
      ssh-keygen -t ed25519 -f sakura_cloud_deploy_key -C "github-actions-cloud-backend" -N ""
      ```
- [ ] **4. Configure the firewall** (Sakura Cloud's packet filter, or `ufw`
      on the VM itself): allow **22** (SSH, ideally restricted to your own
      admin IP range if that's stable enough to maintain), **80** and
      **443** (HTTP/HTTPS, for Caddy/Nginx — 80 is needed for Let's Encrypt's
      HTTP-01 challenge and to redirect to HTTPS). **Do not open 5432**
      (PostgreSQL) to the internet — it must only be reachable from the API
      container/process on the same VM.
- [ ] **5. Obtain the public IP.** Sakura Cloud assigns one at VM creation;
      note it down — needed for step 6.
- [ ] **6. Configure DNS**, on whatever DNS provider manages `sakura.ne.jp`
      for this account (check the Sakura Cloud/domain control panel — this
      task does not know which DNS provider is in use and does not invent
      one): an **A record** for `api.suisuinavi.sakura.ne.jp` → the VM's
      public IP from step 5. This exact hostname is a **recommendation**,
      not something already configured or verified reachable — see
      [AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md) §4 for an open,
      explicitly-unverified question about whether `sakura.ne.jp`'s Public
      Suffix List status affects the cookie-domain design once this
      hostname is live; test the actual login flow in a real browser after
      DNS + HTTPS are up, specifically checking whether the session cookie
      is set at all (dev tools → Application → Cookies) before assuming it
      works.
- [ ] **7. Install Docker + Docker Compose on the VM** (`curl -fsSL
      https://get.docker.com | sh`, then the Docker Compose plugin — see
      Docker's own current install docs, since exact commands drift over
      time).
- [ ] **8. Add the GitHub Actions secrets** — table below.

## 3. Required GitHub Secrets (not yet added — names only)

Under **Settings → Secrets and variables → Actions**, once the VM and DNS
above exist. Deliberately named `SAKURA_CLOUD_*`, distinct from the
existing Rental Server's `SAKURA_*` secrets — **do not reuse the Rental
Server's SSH key for this** (a separate deploy key, generated in checklist
step 3, is preferred specifically so the two deployment targets' blast
radius stays separate).

| Secret | Description |
|---|---|
| `SAKURA_CLOUD_HOST` | The Cloud VM's SSH hostname or public IP (checklist step 5/6). |
| `SAKURA_CLOUD_USER` | The SSH/UNIX username on the VM (e.g. whatever user Docker/deploy runs as). |
| `SAKURA_CLOUD_SSH_PRIVATE_KEY` | Private half of the **dedicated** deploy keypair from checklist step 3. PEM format, no passphrase. |
| `SAKURA_CLOUD_KNOWN_HOSTS` | `ssh-keyscan` output for the VM, same pattern as `SAKURA_DEPLOYMENT.md`'s existing setup — verify the fingerprint against your own first manual connection before trusting it. |
| `SAKURA_CLOUD_PORT` *(optional)* | SSH port, if not 22. |
| `SAKURA_CLOUD_SESSION_SECRET` | A long random value for `SUISUI_CLOUD_SESSION_SECRET` (`openssl rand -base64 48`). **Generate a fresh one for production** — never reuse a value that appeared in any local `.env`, test output, or this repository's history. |
| `SAKURA_CLOUD_POSTGRES_PASSWORD` | A long random value for the production PostgreSQL password. |

No password, token, session secret, or private key is ever committed to the
repository — only referenced as `${{ secrets.* }}`, exactly like the
existing Rental Server pipeline.

## 4. DNS and HTTPS

- **DNS**: checklist step 6. This document recommends
  `api.suisuinavi.sakura.ne.jp` as the API hostname (a natural sibling of
  the existing `suisuinavi.sakura.ne.jp` frontend), but **whether this
  exact subdomain can be created depends on how DNS for `sakura.ne.jp` is
  actually managed for this account** — that was not something this task
  could inspect or verify. If a different hostname ends up being used,
  update `SUISUI_CLOUD_ALLOWED_ORIGINS` is not what needs changing (that's
  the *frontend's* origin) — update the frontend's
  `config/cloud-config.js` `apiBaseUrl` and this API's own public hostname
  wherever Caddy/Nginx and DNS reference it.
- **HTTPS**: prefer **automatic Let's Encrypt via Caddy** — Caddy obtains
  and renews certificates with essentially zero configuration (`api.suisuinavi.sakura.ne.jp
  { reverse_proxy localhost:8000 }` is close to a complete Caddyfile for
  this), which is why it's preferred over Nginx + separate certbot
  wiring for a single-service VM like this one. This has not been set up
  or tested — port 80 must be reachable for the HTTP-01 challenge
  (checklist step 4) before Caddy can obtain a certificate.
- **Never disable certificate verification** anywhere in the stack (the
  frontend's `fetch()` calls, any server-to-server call this API might make
  in the future) — this was not done and must not be added as a
  troubleshooting shortcut if HTTPS setup hits friction.

## 5. Deploying (once the above exists)

Not yet implemented as an automated job — `.github/workflows/deploy-cloud-backend.yml`
currently runs tests only (see
[SAKURA_CLOUD_BACKEND.md](SAKURA_CLOUD_BACKEND.md) §9). Once the VM/DNS/secrets
above exist, a `deploy` job should be added there, gated on
`needs: [test, integration]`, following the same SSH pattern
`deploy-sakura.yml` already uses but pushing to the Cloud VM instead —
roughly: `rsync` or `git pull` the repository state to the VM, then
`docker compose up -d --build` (the `Dockerfile`'s `CMD` already runs
`alembic upgrade head` before starting Uvicorn on every container start —
see [SAKURA_CLOUD_BACKEND.md](SAKURA_CLOUD_BACKEND.md) §7). This was
intentionally **not written yet** — this task's instruction was explicit:
do not deploy, and do not build automation for a deploy that would run
against infrastructure that doesn't exist.

Until then, `docker compose up --build` run manually on the VM (over SSH)
is the way to bring the service up for the first time, using the same
`docker-compose.yml`/`.env` already written and locally-verified (build-wise,
not run-wise — see [SAKURA_CLOUD_BACKEND.md](SAKURA_CLOUD_BACKEND.md) §10.2)
in `cloud_backend/`.

## 6. Environment variables (production)

Set as real environment variables on the VM (e.g. in the `.env` file
`docker-compose.yml` reads, created manually from `.env.example` — never
committed), not injected via GitHub Actions into the repository itself
except where noted:

| Variable | Production value |
|---|---|
| `SUISUI_CLOUD_ENVIRONMENT` | `production` |
| `SUISUI_CLOUD_SESSION_SECRET` | From `SAKURA_CLOUD_SESSION_SECRET` (§3) |
| `SUISUI_CLOUD_DATABASE_URL` | `postgresql+asyncpg://suisuinavi:<SAKURA_CLOUD_POSTGRES_PASSWORD>@db:5432/suisuinavi` (container-network hostname `db`, per `docker-compose.yml`) |
| `SUISUI_CLOUD_SESSION_COOKIE_DOMAIN` | `.suisuinavi.sakura.ne.jp` (see [AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md) §4's open PSL question before assuming this works unverified) |
| `SUISUI_CLOUD_ALLOWED_ORIGINS` | `https://suisuinavi.sakura.ne.jp` |
| `SUISUI_CLOUD_REQUIRE_EMAIL_VERIFICATION` | `false`, until SMTP (below) is actually configured — see [AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md) §7 |
| `SUISUI_CLOUD_SMTP_*` | Unset until an SMTP provider is chosen — optional, not required for first deployment |

`SUISUI_CLOUD_ENVIRONMENT=production` matters beyond labeling: `app/main.py`
refuses to boot if `SUISUI_CLOUD_SESSION_SECRET` is empty while in this
mode, cookies get `Secure` set, and `/docs`/`/openapi.json` are disabled.

## 7. Migrations

`alembic upgrade head` — runs automatically on every container start
(`Dockerfile`'s `CMD`), safe to repeat. For a manual/out-of-band run:

```bash
docker compose exec api alembic upgrade head
```

Future schema changes: add a new revision under `cloud_backend/migrations/versions/`
(`alembic revision -m "..."`, or hand-write one matching this repository's
existing style — see `0001_initial.py`'s own docstring for why
autogenerate wasn't used even for that first migration), review it, commit
it, and it applies automatically on the next deploy. Never hand-edit the
schema directly against production.

## 8. Backup strategy

**No backup has been configured yet** — this section documents the intended
procedure, not a running cron job or verified restore. Per this task's
explicit instruction: do not claim a backup exists until it actually has
been configured and, ideally, a restore has actually been tested.

**Recommended approach** (not yet implemented):

- A daily `pg_dump` from inside the `db` container (or via `docker compose exec db pg_dump -U suisuinavi suisuinavi | gzip`),
  written to a path outside the container's own ephemeral filesystem —
  either the VM's own disk (simplest, but doesn't protect against VM loss)
  or, better, uploaded off-VM (Sakura's object storage product, if
  available on this account, or any other off-VM location) so a lost VM
  doesn't also lose its backups.
- A `cron` entry on the VM (outside Docker) is simplest for triggering the
  daily dump; a scheduled GitHub Actions workflow that SSHes in and
  triggers it is an alternative if centralizing schedules in this
  repository is preferred later.
- **Retention**: a reasonable starting policy is 7 daily + 4 weekly
  snapshots, pruning older ones — tune once real data volume is known.
- **Restore procedure** (to be tested against a throwaway VM/container
  before ever relying on it in a real incident):
  ```bash
  gunzip -c backup-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U suisuinavi suisuinavi
  ```
- **Migration rollback**: each Alembic revision has a `downgrade()`
  (`alembic downgrade -1`), but a downgrade that would drop a column
  containing real farmer data should almost always be handled as a new
  forward migration instead (e.g. making a column nullable rather than
  dropping it) rather than an actual `downgrade` run against production —
  `downgrade()` exists mainly for local development churn, not as the
  primary production rollback tool.

**Do not go live with real farmer data before at least the daily-dump half
of this is actually running and its output has been spot-checked.**

## 9. Monitoring and logging

Not set up in this task, beyond what already exists: `app/main.py`'s global
exception handler logs full unhandled-exception detail server-side (never
to the client — see [AUTH_ARCHITECTURE.md](AUTH_ARCHITECTURE.md) §6), and
Uvicorn's own access log runs by default. For a production VM, at minimum:

- `docker compose logs -f api` / `docker compose logs -f db` for manual
  inspection.
- Consider forwarding container logs somewhere off-VM (even a simple
  `journald` + `logrotate` setup avoids an unbounded local log file) before
  this carries real traffic for long.
- A synthetic uptime check against `GET /api/health` from an external
  service (even a free-tier one) is a cheap first monitoring layer, and
  costs nothing to add once the hostname (§4) is live.

## 10. Rollback

Since there is no deploy job yet (§5), there is nothing automated to roll
back. Once one exists, the same git-driven pattern
[SAKURA_DEPLOYMENT.md](SAKURA_DEPLOYMENT.md) already documents for the
frontend applies here too: `git revert`/reset to a known-good commit and
re-run the deploy job, or manually `docker compose up -d --build` a known
prior commit's checkout on the VM. A schema migration is the one piece that
doesn't automatically "revert" alongside a code rollback — see §8's note on
preferring forward-fixing migrations over `downgrade()` in production.
