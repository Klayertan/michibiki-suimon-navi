# Cloudflare デプロイ / Cloudflare deployment

**Source hosting: GitHub. Production hosting: Cloudflare.**

GitHub keeps the code, the issues, the branches, the pull requests and the
history. Cloudflare serves the application to farmers. Neither replaces the
other, and this split is the whole point of the migration.

SuisuiNavi previously ran on GitHub Pages at
`https://klayertan.github.io/michibiki-suimon-navi/`. It now runs on
**Cloudflare Workers with static assets**.

---

## 1. Architecture

```text
                    GitHub
                      │  source code, issues, branches, PRs, history
                      │
                      │  push to main
                      ▼
              Workers Builds  (npm run build → npx wrangler deploy)
                      │
                Cloudflare Worker      ← no Worker script today
                      │
               + Static Assets  (dist/)
                      │
                      ▼
                 SuisuiNavi
                 Web frontend
                      │
          ┌───────────┼───────────┐
          │           │           │
          ▼           ▼           ▼
      WebSerial     Browser     Future API
          │         storage        │
          ▼      (localStorage)    ▼
      GNSS/QZ1                Worker routes  /api/*
                                   │
                          ┌────────┼────────┐
                          ▼        ▼        ▼
                         D1       R2      Sakura
                       future    future    future
```

Two things that did **not** move, and must not:

* **Hardware stays in the browser.** Web Serial talks to the blue QZ1 receiver
  from the farmer's own laptop. Cloudflare hosts the page; it never touches a
  serial port, and there is no server in the GNSS path. Web Serial requires a
  secure context, which Cloudflare's HTTPS provides — the same guarantee
  GitHub Pages gave.
* **The drone backend stays local.** `js/drone/drone-api-client.js` calls
  `/api/*` against `http://127.0.0.1:8787` (the Python MAVLink backend) or,
  in the desktop shell, against the shell's own origin. It never calls the
  page's origin, so a future Cloudflare `/api/*` route cannot collide with it.

Browser storage, maps, survey, field/sensor assignment, the QZ1 experiment
pipeline and account scoping are all unchanged: this migration moved the file
server and nothing else.

---

## 2. Why Workers + Static Assets, and not Pages

Both would work and both are free. Workers was chosen for four concrete
reasons, in order of weight:

1. **It is where SuisuiNavi is going.** The roadmap is water-level sensors,
   QZ1/QZSS uploads, drone observations and user accounts — server-side work
   behind `/api/*`. On Workers, adding that is two lines in `wrangler.jsonc`
   (`main` plus `run_worker_first: ["/api/*"]`) in the deployment that is
   already running. With Pages it would mean either Pages Functions or a
   second, separately deployed Worker with its own origin and its own CORS
   story.
2. **Cloudflare's own direction.** Workers with static assets is Cloudflare's
   recommended target for new applications; Pages remains supported but new
   platform investment goes to Workers.
3. **Cost is identical, and provably zero.** Static-asset requests are free and
   unlimited on the Free plan. Because this deployment has **no `main`
   script**, no Worker is ever invoked, so the 100,000 requests/day Worker
   allowance is not consumed at all — there is no request-volume ceiling to
   hit and nothing that can accrue a charge.
4. **No added complexity.** The repository has no build system, no framework
   and no bundler. The Workers configuration is one `wrangler.jsonc` and a
   40-line copy script. Pages would not have been simpler; it would have been
   the same, minus the extension point.

The one thing Pages does slightly better — automatic preview URLs for every
branch — Workers Builds also provides, via `wrangler versions upload` on
non-production branches.

---

## 3. Free-tier assumptions

Everything below is Free plan. **No paid Cloudflare feature is used or
required.**

| Resource | Free allowance | What SuisuiNavi uses |
|---|---|---|
| Static asset requests | free, unlimited | all of them |
| Worker invocations | 100,000/day | **zero** — no `main` script exists |
| Static asset files | 20,000 per version | 91 |
| Static asset file size | 25 MiB each | largest is `index.html`, ~473 KiB |
| Workers Builds | 3,000 build-minutes/month, 1 concurrent, 20-min timeout | a file copy; seconds per build |
| D1 / R2 / KV / Durable Objects | — | **none provisioned** |

Guardrails that keep it that way:

* **Serve files as files.** Anything that can be a static asset must be one.
  A Worker route is only for work that genuinely cannot happen in the browser.
* **No polling.** The app is event-driven; it does not poll its own origin.
  A future `/api/*` must not introduce a background poll — one 30-second poll
  per open tab is 2,880 invocations/day/tab.
* **No unnecessary writes.** localStorage remains the primary store. Cloud
  sync stays additive, as it already is with Supabase.
* **No logging volume.** With no Worker there is nothing to log. If `main` is
  added later, keep `observability` sampling in mind before logging per
  request.
* **Nothing is auto-enabled.** Adding D1, R2, or any binding is a deliberate
  edit to `wrangler.jsonc` plus a dashboard action. It cannot happen by
  accident.

`tests/unit/cloudflare-deployment.test.js` asserts the "no `main`" property, so
the day it changes, a test says so.

---

## 4. GitHub integration

Deployment is `git push`. Workers Builds watches `main`, runs the build and
deploys.

```text
Developer ──git push──▶ GitHub ──webhook──▶ Cloudflare Workers Builds
                                                   │
                                            npm run build
                                                   │
                                            npx wrangler deploy
                                                   │
                                                   ▼
                                              Production
```

Non-production branches (for example `feature/…`) run
`npx wrangler versions upload` instead: they get a preview URL and **do not**
touch production.

No GitHub Actions workflow is needed, and none was added — Cloudflare's native
Git integration already does this. The repository has no `.github/workflows/`
at all.

---

## 5. Cloudflare setup (manual, one time)

These steps need a signed-in Cloudflare account and **cannot be done from the
repository**. Do them once.

1. Sign in at <https://dash.cloudflare.com>. A free account is enough; do not
   upgrade to Workers Paid.
2. If prompted, pick a **workers.dev subdomain** for the account. The site will
   be `https://suisui-navi.<your-subdomain>.workers.dev`.
3. **Compute (Workers) → Create → Workers → Import a repository.**
   (Equivalent path on an existing Worker: **Settings → Builds → Connect**.)
4. Authorize the **Cloudflare GitHub App** when GitHub asks, and grant it
   access to `Klayertan/michibiki-suimon-navi`. Granting a single repository is
   sufficient — do not grant the whole account unless you want to.
5. Fill in the build settings exactly as in §6.
6. Deploy. Cloudflare runs the first build and prints the live URL.
7. Copy that URL into `docs/SUPABASE_SETUP.md` §4 — **Supabase Authentication →
   URL Configuration** must list the new origin, or confirmation and
   password-recovery emails will bounce to the dead Pages URL.
8. **Turn GitHub Pages off:** GitHub repo → **Settings → Pages → Source →
   None**. The repository's only Pages artifact (`.nojekyll`) is already
   removed; this switches off the publishing itself.

Nothing in steps 1–8 produces a value that belongs in this repository. Do not
commit the account ID, the API token Cloudflare generates, or anything else
from the dashboard.

---

## 6. Build settings

Enter these in **Settings → Builds**:

| Field | Value |
|---|---|
| Git account / repository | `Klayertan/michibiki-suimon-navi` |
| Git branch (production) | `main` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Non-production branch deploy command | `npx wrangler versions upload` |
| Root directory | *(leave empty — the Worker is at the repository root)* |
| Build variables and secrets | *(none)* |

`npm run build` runs `scripts/build-static.mjs`, which copies the deployable
frontend into `dist/`:

* `index.html`, `config/`, `css/`, `js/`, `data/` — everything the browser can
  request at runtime, and nothing else.
* The file list comes from `git ls-files`, not a glob. That is deliberate:
  `.gitignore` keeps real GNSS captures (`data/*.nmea`) untracked because a
  raw log records where a person actually stood, and a tracked-files-only
  build makes it impossible to publish one by accident.
* `backend/`, `docs/`, `tests/`, `scripts/`, `desktop/`, `edge/`, `supabase/`,
  `packaging/`, `experiments/` and `node_modules/` are never copied. The
  repository root is a development checkout, not a web root.

The build applies no transform. The bytes served in production are the bytes
in the repository, which is exactly why `node scripts/dev-server.mjs` and
Cloudflare show the same application.

The build also **fails** if `index.html` loads a file the build cannot ship —
a stylesheet, a module or a data file that is referenced but untracked. That
combination is invisible on the dev server (which serves the working tree) and
is a 404 in production; committing `index.html` without its new modules is the
easy way into it, and has happened here before.

---

## 7. Local development

Nothing about the day-to-day loop changed:

```bash
node scripts/dev-server.mjs   # or: npm run serve   → http://localhost:4173/
```

To exercise the **production** hosting path locally — the real workerd runtime,
the real static-asset routing, the real 404 behaviour:

```bash
npm run cf:dev
```

That builds `dist/` and starts wrangler on <http://localhost:8788>. Port 8788,
not wrangler's default 8787, because 8787 is the local MAVLink backend's port.

The browser suite can be pointed at either server:

```bash
npm run test:browser
```

```bash
SUISUI_BASE_URL=http://localhost:8788 npm run test:browser
```

The second form runs the whole suite against the Cloudflare preview and is the
check that hosting parity still holds.

To validate the configuration without deploying anything:

```bash
npx wrangler deploy --dry-run
```

---

## 8. Production deployment

**Normal path — push.**

```bash
git push origin main
```

Workers Builds builds and deploys. Watch it in **Settings → Builds**.

**Manual path — from a laptop.** Only for an emergency or a first bring-up;
requires `npx wrangler login` once (an OAuth browser flow — no token is stored
in the repository).

```bash
npm run cf:deploy
```

Prefer the push path. A manual deploy publishes whatever is in the working
tree, including uncommitted changes, and leaves production ahead of `main`.

---

## 9. Rollback

Every deployment is a retained version, so rollback is instant and needs no
rebuild.

Dashboard: **the Worker → Deployments →** pick the last good version **→
Rollback**.

CLI:

```bash
npx wrangler deployments list
```

```bash
npx wrangler rollback [version-id]
```

Rollback changes what Cloudflare serves. It does **not** change `main`, so the
next push re-deploys the bad build — fix or revert the commit in git too.

Full escape hatch: GitHub Pages can be switched back on from the repository's
**Settings → Pages** at any time. The application is still a plain static site
served from the repository root, so nothing in this migration made that
impossible.

---

## 10. Future: D1

**Not provisioned. Do not create it until something needs it.**

D1 is Cloudflare's SQLite database, and it is the natural home for the entities
the roadmap implies — `users`, `fields`, `devices`, `water_measurements`,
`gnss_measurements`, `qz1_observations`, `drone_surveys`,
`field_observations`. Note that accounts and field sync are currently served
by Supabase (`docs/SUPABASE_SETUP.md`); D1 is an alternative to that, not an
addition to it, and choosing between them is a real decision that has not been
made.

When it is needed:

```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "suisui-navi", "database_id": "…" }]
```

Free plan: 5 GB storage, 5 million rows read/day, 100,000 rows written/day.
Sensor readings are small and infrequent; a paddy water level does not need
sub-minute resolution. Batch writes rather than one request per reading.

---

## 11. Future: R2

**Not provisioned.**

R2 is object storage with **no egress fees**, which is what makes it the right
place for the large blobs SuisuiNavi will accumulate: raw NMEA logs, drone
imagery, orthomosaics, RealSense captures. Free plan: 10 GB storage,
1 million Class A (write) and 10 million Class B (read) operations per month.

```jsonc
"r2_buckets": [{ "binding": "BUCKET", "bucket_name": "suisui-navi-captures" }]
```

Before storing a single GNSS log server-side, settle the privacy question that
`.gitignore` already raises: a raw track is a record of where a person was.
Decide retention and access first, schema second.

---

## 12. Future: Sakura Cloud

**Not introduced. Out of scope for this stage.**

Sakura Cloud (さくらのクラウド) would be a domestic-Japan option for anything
that must be processed or stored in Japan — heavy photogrammetry, or a data
residency requirement from an agricultural cooperative. It would sit *behind*
the Worker, not replace it: the Worker stays the single public entry point and
calls Sakura as an upstream, so the browser keeps talking to one origin.

It is not free. Do not introduce it while ¥0/month is the requirement.

---

## 13. Secrets management

**Anything shipped to browser JavaScript is public.** `dist/` is downloadable
by anyone. That is not a Cloudflare property; it was equally true on GitHub
Pages.

What is in the repository today, and why it is fine:

* `config/cloud-config.js` — Supabase project URL and **anon/publishable** key
  only, and currently unset. The anon key is designed to be public and every
  request it authorizes is still filtered by Row Level Security. The app
  refuses to start the cloud feature if a `service_role` key is detected.
* `wrangler.jsonc` — names and a compatibility date. No account ID, no token.
  `tests/unit/cloudflare-deployment.test.js` fails if a credential-shaped key
  appears in it.

Where real secrets go when there are any:

```bash
npx wrangler secret put SOME_API_KEY
```

or **the Worker → Settings → Variables and Secrets** in the dashboard. Worker
secrets are readable only by Worker code at runtime (`env.SOME_API_KEY`) and
are never written into `dist/`, never in git, never visible to the browser.

The API token Workers Builds generates lives in Cloudflare. Never copy it into
the repository, and never into a GitHub Actions secret unless you have
deliberately decided to deploy from Actions instead.

---

## 14. Troubleshooting

**The build fails with "no deployable files found -- is this a git checkout?"**
`scripts/build-static.mjs` uses `git ls-files`. Workers Builds clones the
repository so git is present; locally, this means you are running from an
export rather than a checkout.

**The build fails with "index.html loads files the build cannot ship".**
Exactly what it says: those paths are referenced by `index.html` but untracked,
so they would 404 in production. `git add` them, or drop the reference. Seeing
this mid-feature is normal — a half-wired module is not deployable yet.

**A file 404s in production but works on the dev server.** It is untracked, and
nothing in `index.html` references it directly (so the build check did not see
it). `node scripts/dev-server.mjs` serves the working tree; the build ships
tracked files only. `git add` it.

**A new top-level directory of assets is not served.** Add it to `ASSET_ROOTS`
in `scripts/build-static.mjs`. Only `index.html`, `config/`, `css/`, `js/` and
`data/` are copied.

**Web Serial is missing / QZ1 will not connect.** Chromium only (Chrome or
Edge — not Safari, not Firefox), and only in a secure context. Cloudflare
serves HTTPS, so production qualifies; over plain `http://` on a LAN address it
will not. Check `navigator.serial` in the console. This is a browser
constraint, not a hosting one, and it behaved identically on GitHub Pages.

**Email confirmation links go to a 404 at `klayertan.github.io`.** Supabase
still has the old Site URL. Fix it in
[SUPABASE_SETUP.md](./SUPABASE_SETUP.md) §4.

**`wrangler dev` will not bind.** Something else is on 8788, or the MAVLink
backend moved. `lsof -i :8788`.

**A deploy went out that should not have.** §9. Roll back first, fix `main`
second.

**Is this costing money?** Check **Workers & Pages → the Worker → Metrics**.
With no `main` script the request count attributed to the Worker should stay at
zero; all traffic is served as free static assets.

---

## Related

* [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) — accounts and field sync
* [ARCHITECTURE.md](./ARCHITECTURE.md) — application architecture
* [DESKTOP_APPLICATION_ARCHITECTURE.md](./DESKTOP_APPLICATION_ARCHITECTURE.md) —
  the packaged desktop shell, which serves the same files locally
