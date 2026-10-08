# Article 1 outline

**Title:** さくらのVPSでPythonサーバーを構築してみた
**Reader:** knows some Python, has never deployed a server.
**Voice:** an engineering student building something, hitting problems,
writing down what worked. Not an advertisement.
**Status:** outline only. Sections marked ⏳ cannot be written until they have
actually happened on the VPS — they are not to be drafted from expectation.

## Skeleton (problem → … → what I learned)

1. **Problem — スイスイナビは「見るだけ」だった**
   Background in two or three sentences (みちびきハッカソン, QZ1 で圃場を実測,
   水管理の判断支援). Everything runs in the browser; accounts / synced data
   need a program that is always on. A diagram: *Mac-only* vs *with a server*.
2. **Why it happens — Python on my Mac only exists while my Mac does**
   Close the lid → API gone. Laptop IP changes. Not reachable from outside.
   (Honest detail: the Mac's system Python is 3.9, the project needs 3.12 —
   the machine you develop on is not the machine you deploy to.)
3. **Possible solutions** — a VPS, a rental server (already used for the static
   site; can't run a Python service), a managed platform. One short paragraph.
4. **Why a Sakura VPS** — the real reasons (the site is already on Sakura, the
   Ambassador context, plan size / price ⏳ confirm). No superlatives.
5. **What a server / VPS is** — a computer in a data centre you rent and
   control over SSH. Explain *SSH*, *Ubuntu*, *root vs normal user*.
6. **Implementation** ⏳
   1. Create the VPS (screens 1–3). 2 GB plan, Ubuntu.
   2. SSH key from macOS: `ssh-keygen -t ed25519`. Public vs private key.
   3. First login, create a normal user, key-only SSH, disable password login
      (careful: keep a second session open so a typo cannot lock you out).
   4. Packet filter: only 22 and 80. Explain why 5432 and 8000 stay closed.
   5. **The demo:** run the API by hand → close the terminal → it dies.
      This is the moment that motivates a supervisor.
   6. Docker, in three sentences. `docker compose up -d` and `restart:
      unless-stopped`; what each of the three containers does (API, PostgreSQL,
      Caddy).
   7. `curl` from the Mac → `{"status":"ok","service":"sui-sui-navi-api"}`.
7. **Problems encountered** — real ones only. Candidates already in hand from the
   local rehearsal: (a) every visitor looked like Caddy's address (rate-limit
   bug; `FORWARDED_ALLOW_IPS`); (b) Docker bypasses `ufw`; (c) Python 3.9 vs
   3.12. ⏳ plus whatever the VPS adds.
8. **Result** ⏳ the curl output, `docker compose ps`, and the reboot test.
9. **What I learned / what's next** — HTTP vs HTTPS (a bare IP cannot get a
   certificate), then Article 2.

## Explain-when-introduced list

SSH · public/private key · Ubuntu · `sudo` · `apt` · firewall / packet filter ·
Docker / compose · reverse proxy · Caddy · FastAPI · Uvicorn · health check ·
HTTP vs HTTPS · localhost vs public Internet. One or two plain sentences each;
every command gets a "what this does" line.

## Screenshot plan

How: control-panel screens via Claude in Chrome (the user logs in and pays
personally; screenshots stop before any payment step). Terminal screens by the
user or from the terminal pane. **All stored outside the repo until redacted.**

| # | Screen | Redact before publishing |
|---|---|---|
| 1 | VPS plan list, 2 GB plan highlighted | account name, email |
| 2 | OS selection (Ubuntu) | — |
| 3 | Server spec / confirmation screen **before** payment | account, contract, price details if desired |
| 4 | Packet filter settings (22, 80 open) | IP ranges of the admin machine |
| 5 | First SSH login | **VPS IP / hostname**, username if personal |
| 6 | `python3 --version` on the Mac vs on the server | — |
| 7 | "Run by hand → close terminal → dead" (two terminals) | IP |
| 8 | `docker compose ps` (all healthy) | — |
| 9 | `curl` from the Mac returning the JSON | **IP** |
| 10 | Same JSON in the browser | **address bar** |
| 11 | `free -h` and `docker stats` on the VPS | — |
| 12 | After `sudo reboot`: `uptime` + `docker compose ps` | IP |
| 13 | Swagger UI `/docs` — **from the local development instance on the Mac**, because production deliberately disables `/docs` | — |

Never in a screenshot: passwords, `.env`, private keys, tokens, the invoice /
billing pages, the account email.

## Diagrams

1. *Before / after* — browser-only app vs browser → server.
2. *Request path* — Browser → (Internet) → Caddy :80 → API :8000 → PostgreSQL,
   with the ports that are public (80) and the ones that are not (8000, 5432).
3. *localhost vs public Internet* — reserved for Article 3.

## Open checks

See the end of [`devlog.md`](devlog.md): plan details, OS list, default
hostname format, whether the `api.` subdomain can be pointed at the VPS, real
memory use, reboot behaviour.
