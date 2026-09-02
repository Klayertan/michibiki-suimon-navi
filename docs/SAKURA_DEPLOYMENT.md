# Sakura Deployment

How the SuiSuiNavi frontend gets from `main` to
<https://suisuinavi.sakura.ne.jp/> automatically, and how to operate that
pipeline.

## Architecture

There is no build step. The browser runtime is exactly:

```
index.html
css/
js/
config/
data/
```

`index.html` loads `css/*.css` and `config/cloud-config.js` / `js/*.js` via
`<script>`/`<link>` tags and dynamic `import()`, and fetches JSON/text out of
`data/` at runtime. Leaflet, Leaflet.markercluster and Turf are pulled from
`unpkg`/`jsdelivr` CDNs directly in `index.html` — nothing to vendor locally.
Everything else in the repo (`backend/`, `desktop/`, `edge/`, `docs/`,
`tests/`, `supabase/`, packaging scripts, etc.) is development-only and is
never shipped.

On every push to `main` (and on manual trigger), GitHub Actions
([`.github/workflows/deploy-sakura.yml`](../.github/workflows/deploy-sakura.yml)):

1. Runs the fast unit tests (`npm test`, Node's built-in test runner over
   `tests/unit/*.test.js` — no build, no browser). If they fail, the job stops
   and nothing is deployed.
2. Only then, `rsync`s over SSH into `/home/suisuinavi/www/` on the Sakura
   server: `data/`, `config/`, `css/`, `js/`, and finally `index.html`.

Playwright browser tests (`npm run test:browser`) and the Python backend
tests (`npm run test:backend`) are **not** run by this workflow — they cover
`backend/`/`desktop/` code that isn't part of the deployed static frontend.

### Why `michibiki/` is safe

`/home/suisuinavi/www/michibiki/` is a separate WordPress install and must
never be modified by this pipeline. The workflow protects it three ways:

- Every `rsync --delete` targets one SuiSuiNavi subdirectory
  (`data/`, `config/`, `css/`, `js/`) explicitly — never the `www/` root —
  so `--delete` can only ever remove files *inside that one subdirectory*.
  `index.html` is copied as a single file with no `--delete` at all.
- A guard step runs before any file transfer and aborts the whole job if
  `/home/suisuinavi/www/michibiki/` doesn't exist on the target — a cheap
  sanity check that the deploy is pointed at the right host/path before it
  touches anything.
- A verification step runs after deployment and fails loudly if
  `michibiki/` is gone (it never should be, since nothing above touches it).

### Deploy order and partial-failure behavior

Asset directories (`data/`, `config/`, `css/`, `js/`) sync first, and
`index.html` syncs last. If a step fails partway (e.g. the runner loses
network mid-`rsync`), the workflow stops immediately: later steps don't run,
and `index.html` — still the old version — keeps pointing at whatever old
asset files remain. The live site never ends up serving a new `index.html`
against half-uploaded JS/CSS. `rsync` itself also writes each file to a temp
name and renames it into place, so an interrupted transfer of a single file
never leaves a truncated file live.

This is "atomic" at the level that's practical for shared hosting over
rsync/SSH — it is not a full blue/green swap. In the rare case where a
directory sync is interrupted mid-transfer, re-running the workflow (push
again, or use `workflow_dispatch`) will finish reconciling it.

## Required GitHub Secrets

Set these under the repository's **Settings → Secrets and variables →
Actions**:

| Secret | Description |
|---|---|
| `SAKURA_HOST` | The SSH hostname for the Sakura server (e.g. `suisuinavi.sakura.ne.jp` or the server's actual SSH hostname if different — check your Sakura control panel). |
| `SAKURA_USER` | The SSH/UNIX username for the account (e.g. `suisuinavi`). |
| `SAKURA_SSH_PRIVATE_KEY` | The **private** half of a dedicated deploy keypair, PEM format, no passphrase (GitHub Actions can't prompt for one). Never the account password. |
| `SAKURA_KNOWN_HOSTS` | Output of `ssh-keyscan` for the host (see setup below). Used for strict host-key verification instead of `StrictHostKeyChecking=no`. |
| `SAKURA_PORT` *(optional)* | SSH port, if not 22. Sakura's rental-server plans commonly use **2222** for external SSH — check your Sakura control panel's "SSH" section. Defaults to `22` if unset. |

No password, token, or private key is ever committed to the repository —
only referenced as `${{ secrets.* }}`.

## Initial SSH Key Setup (one-time, manual)

Run these from your own machine, **not** from Claude Code/Codex — this
provisions credentials on the real production server.

1. Generate a dedicated deploy keypair (don't reuse a personal key):
   ```bash
   ssh-keygen -t ed25519 -f sakura_deploy_key -C "github-actions-deploy" -N ""
   ```
2. Authorize the public key on the Sakura account. Either use Sakura's
   control panel SSH-key UI, or append it manually:
   ```bash
   ssh-copy-id -i sakura_deploy_key.pub -p <port> suisuinavi@<host>
   # or, if ssh-copy-id isn't available:
   cat sakura_deploy_key.pub | ssh -p <port> suisuinavi@<host> \
     "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
   ```
3. Get the host key fingerprint for `SAKURA_KNOWN_HOSTS`:
   ```bash
   ssh-keyscan -p <port> <host> > known_hosts_output.txt
   cat known_hosts_output.txt
   ```
   Verify the fingerprint matches what Sakura publishes / what you see on
   your own first manual SSH connection before trusting it. Paste the file's
   contents as the `SAKURA_KNOWN_HOSTS` secret value.
4. In the GitHub repo, add the four secrets above:
   - `SAKURA_HOST`, `SAKURA_USER`, `SAKURA_PORT` (if not 22)
   - `SAKURA_SSH_PRIVATE_KEY`: paste the **entire contents** of
     `sakura_deploy_key` (the private key file), including the
     `-----BEGIN...-----`/`-----END...-----` lines.
   - `SAKURA_KNOWN_HOSTS`: paste the contents of `known_hosts_output.txt`.
5. Delete the local `sakura_deploy_key`/`sakura_deploy_key.pub` files (or
   store them in a password manager) once the secrets are saved — don't
   leave them lying around in a repo checkout.
6. Confirm the account's shell allows `rsync`/`bash -s` over SSH (default on
   Sakura's standard SSH shell). If the account is locked to `rssh`/`scponly`
   or similar restricted shells, this workflow's guard/verify steps (which
   run a small shell script over SSH) won't work — you'd need a plain shell
   account instead.

## Automatic Deployment Flow

1. Develop, test locally, commit, and `git push` to `main` (or merge a PR
   into `main`).
2. GitHub Actions runs the `test` job (`npm test`).
3. If tests pass, the `deploy` job rsyncs `data/`, `config/`, `css/`, `js/`,
   then `index.html` to `/home/suisuinavi/www/` on Sakura.
4. Check the **Actions** tab in GitHub for the run's status/logs.

## Manual Trigger

From the repo's **Actions** tab: select **Deploy to Sakura** →
**Run workflow** → choose `main` → **Run workflow**. Useful for re-deploying
without a new commit (e.g. after fixing a Sakura-side issue).

## Rollback / Recovery

There's no separate release-history store on the server — rollback is
git-driven:

- **Revert via git (preferred):** `git revert <bad-commit>` (or reset the
  branch to a known-good commit) and push to `main`. The next deploy run
  re-syncs the working tree from that commit, which naturally restores any
  files that changed.
- **Re-run a known-good commit manually:** use `workflow_dispatch` from the
  **Actions** tab against an older commit if you don't want to alter `main`
  history: `git checkout <sha>` and re-trigger via
  `gh workflow run deploy-sakura.yml --ref <sha>`, or temporarily branch
  from that commit.
- **Emergency manual fix:** you always retain SSH/SFTP access to
  `/home/suisuinavi/www/` independent of this workflow (the same access used
  for the original manual deployment) — you can hand-copy files back if
  needed while a fix is prepared. `michibiki/` is completely unaffected
  either way.

## Protected WordPress Directory

`/home/suisuinavi/www/michibiki/` is a separate WordPress ambassador blog,
served at <https://suisuinavi.sakura.ne.jp/michibiki/>. This deployment
pipeline:

- Never lists, syncs, or deletes anything under `michibiki/`.
- Never runs a root-level `rsync --delete` against `/home/suisuinavi/www/`.
- Aborts before touching anything if `michibiki/` isn't found at deploy
  time (wrong host/path guard), and fails loudly after deployment if it's
  gone (it never should be).

If you ever need to change WordPress files, do that separately and manually
— outside of this workflow, whose credentials shouldn't be repurposed for
WordPress maintenance.
