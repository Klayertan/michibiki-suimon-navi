# Sakura Ambassador blog — working notes

Raw material for the Sakura Internet Ambassador article series on moving
SuiSuiNavi from a static prototype to a Python-backed service on Sakura
infrastructure. (Planned as a Sakura VPS; Article 1 actually runs on a **Sakura
Cloud server**, because the author's coupons apply to that panel — see
`devlog.md` step 4. The article title will need to say さくらのクラウド.)
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
| [`article-1-draft-ja.md`](article-1-draft-ja.md) | Article 1 draft (Japanese), for the WordPress blog |
| [`article-2-draft-ja.md`](article-2-draft-ja.md) | Article 2 draft (Japanese): the app's own address redirected to the blog; WordPress draft post 103 (unpublished); images in `article-2-media.json` |
| [`article-extra-ads-draft-ja.md`](article-extra-ads-draft-ja.md) | 番外編 draft (Japanese): adding an ad slot to the app; WordPress draft post 121 (unpublished); images in `article-extra-ads-media.json`. The 結果 section is a 【要追記】 until AdSense answers |
| [`article-extra-deploy-draft-ja.md`](article-extra-deploy-draft-ja.md) | 番外編 draft (Japanese): publishing SuiSuiNavi to the rental server automatically with GitHub Actions (tests first, safety checks, the shared-folder pitfall, a real run). Not yet in WordPress; no images yet. Facts: `devlog.md` Step 16 |
| [`tools/md_to_wp_blocks.py`](tools/md_to_wp_blocks.py) | Converts a draft to WordPress block HTML (paste into the Code editor) |

## Series plan

1. **さくらのクラウドでPythonサーバーを構築してみた** — why a server, SSH, Docker, first `/api/health`. *Draft ready (WordPress, unpublished).*
2. **スイスイナビの画面をさくらのレンタルサーバで公開する** — the app's own address silently redirected to the blog; shared document root, `.htaccess` host mapping, `www/suisuinavi/`, the 404/500 loop. *Material ready: `devlog.md` step 15 and `~/Pictures/SuiSuiNavi-blog/app-host-fix/` (author's decision 2026-10-11: this is Article 2, not folded into Article 3).*
3. FastAPIで農業・水位データを受け取るAPIを作ってみた — measurements API, validation, database.
4. Sui-Sui-Naviをインターネットから使えるWebアプリにしてみた — domain, DNS, HTTPS, CORS, firewall (the app on `suisuinavi.sakura.ne.jp` calling `api.…`).
5. 農業IoTデータをさくらのクラウドに蓄積・可視化してみた — history, graphs, map.

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
