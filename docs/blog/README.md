# Sakura Ambassador blog — working notes

Raw material for the Sakura Internet Ambassador article series on moving
SuiSuiNavi from a static prototype to a Python-backed service on a Sakura VPS.
These are **engineering notes, not the articles**: they record what was tried,
what broke and what the evidence was, so the published articles can be honest.

The published articles live on the WordPress blog
(`https://suisuinavi.sakura.ne.jp/michibiki/`). WordPress is only the place
the articles are published; the real backend runs on the VPS and the two stay
separate.

| File | What it is |
|---|---|
| [`devlog.md`](devlog.md) | Step-by-step log: what was attempted, why, the command, expected vs actual, the problem, the fix |
| [`article-1-outline.md`](article-1-outline.md) | Outline, screenshot list and open checks for Article 1 |

## Series plan

1. **さくらのVPSでPythonサーバーを構築してみた** — why a server, VPS, SSH, Docker, first `/api/health`. *In progress.*
2. FastAPIで農業・水位データを受け取るAPIを作ってみた — measurements API, validation, database.
3. Sui-Sui-Naviをインターネットから使えるWebアプリにしてみた — domain, DNS, HTTPS, CORS, firewall.
4. 農業IoTデータをさくらのVPSに蓄積・可視化してみた — history, graphs, map.

GPU/AI is deliberately a separate topic and is not part of this series.

## Rules for everything in this folder

This repository is **public**. Therefore, never commit:

- the VPS IP address, its default hostname, or any `*.vs.sakura.ne.jp` name
- passwords, `.env` contents, API keys, session secrets, SSH keys (public keys are fine in principle, but there is no reason to publish one)
- the Sakura account email, contract number, invoice or any billing screen
- unredacted screenshots of the control panel

Use placeholders: `<VPS_IP>`, `<VPS_HOSTNAME>`, `<USER>`. Screenshots are
stored outside the repository until they have been checked and the sensitive
regions blurred.

Every statement of fact in the devlog is tagged by how it is known:
**[verified]** (observed in a command's output), **[documented]** (from an
official page, not independently checked) or **[unverified]**. This follows the
rule in `HANDOFF.md`: do not make the project look better than it is.
