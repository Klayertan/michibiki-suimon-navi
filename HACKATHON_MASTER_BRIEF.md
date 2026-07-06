# みちびきハッカソン Master Brief — Suimon Navi (水門ナビ)
Team E, Nara KOSEN. Solo competitor: KAI. Final: 2026-09-04, Nagaoka KOSEN.
Purpose: single source of truth to feed Claude Code / Codex sessions. Supersedes scattered notes.

> **CORRECTION (2026-07-04):** field is a **paddy field (水田, rice)**, not wheat — belongs to friend's grandfather. Actually strengthens the pitch: 水門ナビ (floodgate navi) is textbook paddy infrastructure — flood irrigation control is exactly what a 水門 is for. If your repo/docs still say "wheat," rename `WHEAT_FIELD_BRIEF.md` → `PADDY_FIELD_BRIEF.md` and swap the term throughout (do this in the GitHub update below).
> **Drone status update:** Holybro X500 V2 is registered (航空法 compliance done), teacher-approved for free lab use, school test-fly site confirmed for non-crop testing. §9a open items 4–5 below are now resolved — only payload/power/logging-method and grandfather's flight-over-paddy consent remain open.

---

## 1. HACKATHON STRUCTURE (full timeline)

| Phase | Dates | Content |
|---|---|---|
| Online lectures | 6/23–7/2, 6x90min | tech + hands-on + idea pitch |
| #1 6/23 | ガイダンス・過去事例・みちびき基礎 |
| #2 6/24 | QZ1有線接続・NMEA理解 |
| #3 6/25 | Webアプリ基礎・地図表示 |
| #4 6/30 | 位置情報活用・地域課題接続 |
| #5 7/1 | データ蓄積・共有・MVP設計 |
| #6 7/2 | 企画発表 & メンタリング開始 |
| Mentoring | 7/3–8/31 | online support, ~3x/team |
| Discord Q&A | 6/23–9/4 | ongoing |
| Offline camp | 9/1–9/4 (Nagaoka KOSEN) | field test, dev, FINAL PRESENTATION |

Weekly progress report required during mentoring (Discord). Format:
```
【週次進捗報告】チーム名：
■ 今週やったこと：
■ 詰まっていること：
■ QZ1で取得したデータ：
■ 地域の人・先生・友人からの反応：
■ 次回までにやること：
■ メンターに相談したいこと：
■ 必要な機材・ハードウェアがあれば：
```
Use this weekly — post real QZ1 data + real community reaction every week. Judges score フィールドワーク separately (award below) — this log is the paper trail.

## 2. FINAL JUDGING — FULL DETAIL

Format: 10min presentation + 10min Q&A = 20min/team.

| Item | Pts | What judges check |
|---|---|---|
| 地域課題の的確さ | 25 | Real problem? Did you talk to stakeholders? |
| 位置情報の活用度 | 25 | Actually using QZ1 real measured data? |
| 完成度 | 20 | Works as a real product? |
| プレゼン | 15 | Clear 課題→解決策→デモ flow? |
| 発展可能性 | 15 | Expandable to other regions? Continued use likely? |

**Awards (separate from総合 ranking):**
- 総合賞 — overall best
- 防災・安全賞 — safety-themed teams
- 技術チャレンジ賞 — technical ambition
- ベストフィールドワーク賞 — teams prioritizing real field survey/hearing

Implication: Suimon Navi's grandfather-farmer tie-in + walked field survey directly targets ベストフィールドワーク賞 AND 地域課題25pts. SLAS shield argument targets 技術チャレンジ賞 + 位置情報活用度25pts.

## 3. NMEA / GNSS QUALITY SCALES (previously missing from brief — now confirmed, official lecture content)

**Fix quality field (GGA sentence, field 6):**
- 0 = 非測位 (no fix / failed)
- 1 = 単独測位 (GPS standalone)
- 2 = DGPS (this is what blue QZ1 SLAS augmentation shows — confirmed proof point)
- 4 = RTK (fixed)
- 5 = RTK Float

**Satellite count (field 7):**
- 4–5 = 最低限 (bare minimum)
- 6–8 = 普通 (normal)
- 9–12 = 良い (good)

**HDOP (field 8, meters):**
- <1 = 非常に良い
- 1–2 = 良い
- 2–5 = 普通
- >5 = 悪い

Action: log fix-quality=2 + sat count band + HDOP band together as the "augmentation proof" triplet in every field-survey screenshot/export. Don't just show "2" alone — pair with sat count + HDOP to preempt "maybe it's a fluke" pushback in Q&A.

Note: GNSS Analyzer manual PDF covers the green QZ1 LE / iOS path — NOT the path KAI uses (blue QZ1 + Bluetooth SPP + Android). Don't follow its setup steps literally; use it only for NMEA field reference if needed.

## 4. DEPLOYMENT OPTIONS (official lecture #5 list)

| Option | Note |
|---|---|
| Render | beginner-friendly, front+back together |
| Vercel | strong frontend framework support |
| **GitHub Pages** | static only, free — **current choice, matches plain HTML/CSS/JS stack, keep it** |
| Cloudflare Workers | more modern arch, more setup |

Decision: stick with GitHub Pages. No backend needed for MVP. Reassess only if cloud DB becomes mandatory (see below).

## 5. DATA STORAGE OPTIONS (official lecture #5 list)

| Option | Use case | Suimon Navi fit |
|---|---|---|
| 静的ファイル in-app | fixed data, redeploy to update | **field survey GeoJSON, weather snapshots — primary for MVP** |
| localStorage | per-device draft only, lost on clear, not shared | ok for farmer's local notes/settings, NOT for shared team data |
| クラウドDB | multi-user live updates, needs auth/perms/delete/ops | **overkill for hackathon MVP — avoid unless judges demand live multi-farmer sharing** |

Lecture explicitly says: for first build, static test data file is the realistic choice; use localStorage only for draft forms. → Suimon Navi should ship static JSON (survey points, field geometry, gate rules) + optional localStorage for farmer's own irrigation log. No DB build-out needed. This matches MVP philosophy (below) and avoids wasted dev time.

## 6. MVP PHILOSOPHY (official, lecture #4)

- Don't build "complete product" first. Get most valuable feature working, then add.
- Don't burn time on login/settings/ranking-style polish — sharpen the core problem-solving experience instead.
- MVP = minimum to demonstrate value at final presentation.

Suimon Navi core loop (the ONE thing that must work end-to-end before anything else):
QZ1 walked-survey point (fix=2, real field) → field geometry rendered on map → weather input → recommended gate-timing output shown to farmer.
Everything else (drone, history log, multi-field support) is v2.

## 7. IDEA FRAMEWORK JUDGES WERE TAUGHT (lecture #4 — for pitch narrative alignment)

Official idea pattern taught to ALL teams: 位置情報 × [photos/video, gyro/accel, user posts, steps/heart-rate] → regional problem solved.
Suimon Navi maps to: 位置情報 × field geometry + weather data → irrigation gate timing decision.
Pitch structure judges expect (from 7/2 kickoff spec, still valid at final): 
1. 着目した地域課題 (the real problem — grandfather's paddy field (水田), manual gate timing)
2. 解決法 (decision-support app, NOT physical actuation — say this explicitly to preempt liability question)
3. みちびきをどのように活用しているか (SLAS shield: sub-meter fix resolves field geometry precisely vs ~5m phone GPS drift)

Official precedent examples shown to all teams (don't copy, but judges will pattern-match against these): 通学路ヒヤリマップ (danger-point photo mapping), 路面コンディション調査 (bump/vibration mapping via accel+GPS). Suimon Navi is differentiated by being decision-support for a named real stakeholder, not crowd-sourced photo mapping — lean into that in pitch.

## 8. REAL-WORLD QZSS USE CASES CITED BY ORGANIZERS (lecture #4 — use for credibility framing, cite 1-2 in pitch)

- 農業: CLAS雑草対策ロボット (自動走行除草)
- 除雪: CLAS+3D地図でロータリ除雪車の投雪方向自動制御
- インフラ点検: CLAS+ロボットで橋梁点検位置記録
- 自治体: SLAS受信機でごみ収集車軌跡→ステーション/ルート改善
- 福祉: 視覚障がい者/車いす向け移動支援
- 流通・ドローン: 経路追従・着陸・配送

Suimon Navi's closest official precedent = 自治体ごみ収集 case (SLAS-only, sub-meter, data-driven ops improvement) — cite this specifically when defending "why SLAS is enough, don't need CLAS."

## 9. HARDWARE / TECH STATE (carried over, confirmed)

- Android: Pixel 6a (SoftBank, used)
- GNSS: blue QZ1, L1S/SLAS, ~1m accuracy, Bluetooth SPP
- Fix-quality=2 in GGA = augmentation proof
- CLAS receiver unavailable; green QZ1 LE swap denied by organizer Arakawa
- Shield: phone GPS ~5m multipath drift vs QZ1 SLAS sub-meter — resolves field geometry precisely enough to distinguish adjacent features
- **Drone: Holybro X500 V2 now available (lab, teacher-approved free use).** Changes risk calculus — see §9a below.
- NMEA test-data generator tool (from lecture #5, useful for dev before field access): https://tools.sotahatakeyama.com/route2nmea

### 9a. HOLYBRO X500 V2 — DRONE INTEGRATION RE-ANALYSIS (new, 2026-07-04)

Old risk: BT SPP range (~10–30m) too short for LIVE telemetry from QZ1 to phone during flight.
**Key unlock: don't need live telemetry at all.** X500 V2 flies its own nav via onboard PX4 flight controller (has its own GPS, unrelated to project). QZ1 rides as a PAYLOAD, logs NMEA independently (to onboard SD / small companion logger, or to a phone strapped to frame), survey happens fully autonomous/RC-piloted, data retrieved AFTER landing. Live BT link during flight becomes irrelevant — walked-survey fallback no longer even needed as primary risk mitigation, it's just the low-tech backup.

Why this matters for rubric:
- 位置情報活用度25 — aerial SLAS survey covers field geometry faster/denser than walking, stronger data story
- 技術チャレンジ賞 — drone-borne precision-GNSS payload survey is a genuinely harder technical claim than walked survey, strong differentiator
- 発展可能性15 — "drone survey any field in region" scales better as a pitch than "walk every field"

New open questions to resolve before committing to drone as primary (not just stretch demo):
1. Payload capacity — X500 V2 typical payload budget ~500g–1kg depending on battery/flight-controller config. QZ1 + mount + power source needs to fit. VERIFY actual spec on your unit before designing mount.
2. Power for QZ1 during flight — tap drone battery via BEC, or separate small battery/powerbank on payload. Decide before mount design.
3. Logging method — cleanest: QZ1 → small onboard logger or lightweight companion computer (if X500 has one) writes NMEA to storage. If no onboard compute, strap phone (heavier, check payload budget) running same logging app as ground use.
4. ~~Japan drone law (航空法)~~ — **RESOLVED: registered.**
5. ~~School/non-crop test site~~ — **RESOLVED: confirmed available.** Run payload+logging test here first.
6. Solo-fieldwork ban still applies to drone flights — companion physically present required, same as walked survey.
7. Crash/liability over crops — teacher approval covers lab equipment use, doesn't cover crop damage liability. Get grandfather's explicit sign-off before first flight over his paddy.

Recommended sequencing: don't let drone become a blocking dependency. Walked-survey with QZ1+Pixel stays the guaranteed-to-work MVP path (§11 step 4). Drone survey is a parallel stretch upgrade — test payload/logging on a non-crop area first (schoolyard/lab field) before ever flying over the actual paddy field.

### 9b. VISION LAYER — UAV PADDY DIAGNOSIS PLATFORM (post-hackathon extension, pitch as 発展可能性)

Core concept: **camera/vision = "what problem" × QZ1/QZSS = "where"** → auto-generated 圃場診断マップ.
Detection targets (staged, water first): water/irrigation anomalies → weed patches → pest/disease signs → nutrient growth issues → harvest timing/maturity → general anomalies.

Prototype rules (consistent with decision-support philosophy):
- Observe only: capture images, log coordinates, detect, output map/CSV. **No spraying/physical action.**
- Offline processing first; real-time later.
- QZ1 stays independent top-mount payload with own logging (proven method, don't wire to Pixhawk first).
- CLEALINK/LoRa = small packets only (coords, problem label, status). Never video/hi-res images.

Hardware shopping list (not yet purchased — only X500 V2 + planned Yowoo 4S 14.8V 5000mAh 100C LiPo in hand):
- Raspberry Pi 4B 4GB + microSD 64GB + open-frame tray
- Pi Camera Module 3 Wide + 15-pin FFC cable (downward-facing)
- 5V/5A BEC (2S–6S input) + XT60 splitter Y-cable + multimeter
- **POWER RULE: battery XT60 → splitter → BEC → Pi. NEVER LiPo direct to Pi, never power Pi from Pixhawk, balance connector is not a power tap.** Verify BEC output with multimeter before first Pi connection.
- CLEALINK LoRa module ×2 (air + ground) + level shifter if 5V TX

Hackathon framing: this is ONE slide (発展構想) — pitch as roadmap, don't promise it for 9/4. Everything demo'd at final must be the proven Suimon Navi core.

## 10. HARD CONSTRAINTS (don't violate)

- Solo fieldwork banned — companion physically required every field visit / drone flight
- Deliverable MUST be a web app
- No physical floodgate actuation — decision-support only, farmer operates gate manually (liability + scope)

## 11. BUILD ORDER (confirmed, milestone-gated — do not skip ahead)

1. Confirm facts in writing (this doc + WHEAT_FIELD_BRIEF.md)
2. Prove ONE real augmented point end-to-end: QZ1 → Pixel 6a → NMEA → fix=2 parsed → plotted on Leaflet map (reuse pond-map parser/map code)
3. Build frame: static JSON schema for field geometry + gate rules + weather input slot
4. Collect real field data (with companion) — walked survey of paddy field boundary + gate location
5. Add weather integration → gate-timing recommendation logic
6. Polish: rubric-aligned UI (show fix-quality/sat/HDOP triplet visibly, show it's decision-support not automation)
7. Weekly Discord report every week from mentoring start, citing real QZ1 data + real stakeholder (grandfather) reaction
8. STRETCH (parallel, non-blocking): X500 V2 payload/logging test on non-crop ground → grandfather consent → drone aerial survey of actual field, feeds same static JSON schema as walked survey

## 12. RUBRIC ALIGNMENT CHECK (map every dev decision back to this)

| Rubric item | Suimon Navi answer |
|---|---|
| 地域課題25 | named real farmer (friend's grandfather), real paddy field (水田), real manual gate pain point |
| 位置情報活用25 | SLAS sub-meter walked survey, fix=2/satcount/HDOP shown, resolves field geometry vs 5m phone drift |
| 完成度20 | static-data MVP, working end-to-end demo, GitHub Pages live |
| プレゼン15 | 課題→SLAS shield→demo flow per official pitch template |
| 発展可能性15 | frame generalizes to any small-plot manual-irrigation farm in region |
| ベストフィールドワーク賞 | companion-accompanied walked survey + grandfather interview, logged weekly |
| 技術チャレンジ賞 | BT SPP GNSS integration + geometry-precision claim under real hardware constraint (no CLAS); stretch: drone-borne SLAS payload survey (X500 V2) |

## 13. PROGRESS LOG — MAJOR MILESTONE 2026-07-06

**APP IS LIVE + REAL QZ1 DATA END-TO-END. Build order §11 steps 2, 3, 5, 6 substantially DONE.**

Live URL: `https://klayertan.github.io/michibiki-suimon-navi/` (repo: `michibiki-suimon-navi`)

### Real walk session (2026-07-06, 15:53–16:01 JST, Nara KOSEN campus, QZ1-133 via BT SPP → Serial Bluetooth Terminal)
Parsed from raw log, verified against app's own counters (exact match — parser honest):
- **332 valid GGA fixes: 268 fix=2 (SLAS augmented, 81%) / 64 fix=1 (standalone) / 157 fix=0 (no fix)**
- fix=2 quality: sats 4–7 (avg 6.0), HDOP 1.3–3.3 (avg 1.92) → official bands: sats "minimum–normal", HDOP "good–normal"
- fix=1 quality: sats 5–8 (avg 6.7), HDOP 1.1–2.3 (avg 1.61)
- Cold start → first fix: ~1m49s. First fix → first SLAS fix=2: +26s. **Plan field visits with ~2min warm-up standing still before walking.**
- 5497 unrecognized lines = QZ1 proprietary sentences ($L1BAT battery, $L1MAG magnetometer) + $GN* talker sentences — correctly skipped, not an error
- Presentation-ready proof triplet: fix=2 + sat count + HDOP logged simultaneously per §3

### App features confirmed working (from live deployment + repo README)
- NMEA upload/paste → parse → Leaflet plot with fix-quality coloring (green=SLAS, orange=standalone)
- **Web Serial API live logging (PC Chrome/Edge)**: paired QZ1 appears as virtual serial port → real-time NMEA receive/plot/save with screen-sleep prevention; phone path stays logger-app + file upload (browsers can't reach SPP)
- **Leaflet.markercluster** (auto-clusters 400+ point logs) + **Turf.js** (field area from boundary polygon); field boundary/waterway polygon-polyline drawing, tagging popup forms, phone-GPS accuracy circles, auto fitBounds — techniques documented in `docs/LEAFLET_TECHNIQUES.md`
- 測量JSON import/export; layer toggles 圃場/QZ1/スマホGPS + augmented-only filter
- **Weather auto-fetch via Open-Meteo (取得成功), fallback to `data/weather.json` + manual input on failure** — resolves weather-source open item
- **判断ルール thresholds (editable): close ≥20mm/24h rain, watch ≥5mm, delay-open ≥60% precip probability**
- **Recommendation output working**: e.g. 24mm/24h → 「閉める」 with reasoning text + explicit disclaimer 「本アプリは判断支援です。最終判断と水門の操作は必ず人が行ってください」 (scope-discipline statement baked into UI — quote this in the pitch)

**Framing note (align with repo README, it's the better wording): treat SLAS as a CONDITIONAL advantage — "IF augmentation is active (fix=2), sub-meter; app works even without it." Organizers never guaranteed SLAS availability. This honest framing is stronger in Q&A than claiming sub-meter unconditionally. The 81% fix=2 session data then reads as evidence, not assumption.**

### What this changes
- Core loop (§6) is PROVEN on real hardware, real sky, real deployment — before mentoring even starts
- Next highest-value moves, in order:
  1. **Paddy field walked survey** (companion + grandfather) — swap campus demo data for real 圃場 data; this is the 地域課題25 + フィールドワーク賞 unlock
  2. Record phone-GPS track simultaneously on same walk → side-by-side drift comparison figure (the shield argument, visualized)
  3. Grandfather interview → threshold values (20mm/5mm/60%) should come FROM him, not from guesses — "thresholds set by the farmer himself" is a devastating Q&A answer
  4. Weekly Discord report: this session is the first 「QZ1で取得したデータ」 entry
  5. Drone payload test at school (parallel stretch, §9a)

### Known data caveats (be ready for Q&A)
- Open-Meteo timestamps in UTC — display converts, but verify JST handling before demo
- fix=2 avg HDOP (1.92) slightly worse than fix=1 (1.61) in this session — expected (different satellite subsets); the accuracy claim rests on SLAS correction, not HDOP; don't conflate them if judges probe
- Campus walk ≠ paddy: open-sky paddy should give better sat counts than building-shadowed campus — say this if asked why sats only hit 4–7

## 14. OPEN ITEMS STILL UNRESOLVED

- Drone (§9a): payload budget on this unit, power tap method, logging method — registration DONE, school test site DONE
- Grandfather: explicit consent for (a) paddy walked survey + interview, (b) drone flight over paddy
- Paddy field survey not yet scheduled (needs companion)
- Phone-GPS vs QZ1 simultaneous comparison track not yet captured
- Thresholds (20/5/60) are placeholder guesses — replace with grandfather-sourced values after interview
- Open-Meteo UTC→JST display handling — verify before demo

~~Repo/deployment~~ RESOLVED: live at klayertan.github.io/michibiki-suimon-navi/
~~Weather source~~ RESOLVED: Open-Meteo auto-fetch + manual override

---
**For Claude Code / Codex sessions: read this doc first (§13 = current state). App is LIVE with real data — do not rebuild from scratch; iterate on the deployed michibiki-suimon-navi repo. Follow build order §11 (next: paddy survey data + comparison track + farmer-sourced thresholds). Don't build cloud DB, don't build login/accounts, don't touch physical gate hardware.**

---

## 15. WIN STRATEGY — HOW THE POINTS ARE ACTUALLY WON

### Point math (where to invest remaining ~8 weeks)
Total 100. Currently strong: 完成度20 (app live, real data). Currently WEAK and highest-leverage:
- **地域課題25 — biggest gap.** All evidence so far is campus data. Zero paddy data, zero interview documentation. One field visit with photos + interview notes + paddy GeoJSON converts this from claimed to proven. HIGHEST ROI ACTION.
- **位置情報活用25 — half-earned.** fix=2 data exists, but the comparison (QZ1 vs phone GPS on the SAME walk) doesn't. Judges score the *contrast*, not the number. One simultaneous-track figure earns the other half.
- プレゼン15 — deck exists, needs demo rehearsal within 10min limit. Practice the live-demo fallback: screen-record the demo in advance in case venue network/BT fails.
- 発展可能性15 — cheap points via one slide sentence: threshold rules are a config file → any paddy, any region; drone survey scales acquisition.

### Likely rival shapes (from official precedent list, expect these patterns from other teams)
- Hazard/photo-mapping apps (通学路ヒヤリ pattern) — crowded space, judges saw the template
- Route/tracking apps (ごみ収集 pattern) — solid but common
Suimon Navi's edge: **named real stakeholder + decision-support (not just visualization) + agriculture** (organizer-cited QZSS priority domain). Nobody else likely has a farmer whose thresholds are IN the app.

### Q&A kill-list (prepare answers, judges will ask)
1. "なぜ自動化しない？" → 責任・安全・ハッカソン規定でWeb成果物。判断支援こそ現実的な導入形態。UI内に免責明記済み。
2. "SLASで十分？CLASでは？" → CLAS機材入手不可を逆手に：圃場形状の把握はサブメートルで足りる。公式事例のごみ収集もSLAS。精度要求と手段が釣り合っている。
3. "fix=2のHDOPがfix=1より悪いのは？" → HDOPは衛星配置の指標で補強精度と別軸。精度改善はSLAS補正によるもの（§13 caveat参照）。
4. "しきい値の根拠は？" → （目標）祖父ヒアリングで実務値を採用。"農家本人の値" と即答できる状態にする。
5. "他の圃場に展開できる？" → 圃場形状JSON＋しきい値設定を差し替えるだけ。ドローン測量でデータ取得も高速化。
6. "雨量データの信頼性は？" → Open-Meteo自動取得＋手動上書き可。実運用では地域アメダス等に差し替え可能な設計。

### 10-min presentation flow (maps to deck 1:1)
1min 課題（祖父・水田・手動水門）→ 1min 技術の壁（5m vs sub-m）→ 1min ソリューション → 1min 構成 → **2min ライブデモ（実データ読込→推奨表示）** → 1min 実証進捗（332点/81%）→ 1min ドローン → 1min 検証・フィールドワーク → 1min ロードマップ＋審査対応まとめ。デモは録画バックアップ必携。

## 16. CLAUDE CODE / CODEX HANDOFF PROMPT (paste this + this file at session start)

```
You are working on Suimon Navi (水門ナビ), a live web app:
https://klayertan.github.io/michibiki-suimon-navi/ (repo: Klayertan/michibiki-suimon-navi)
Plain HTML/CSS/JS + Leaflet + OSM. No build step. Deployed on GitHub Pages.

Read HACKATHON_MASTER_BRIEF.md in repo root before any change.
Hard rules: no cloud DB, no login, no physical gate control, keep static-JSON architecture,
GeoJSON is [lng, lat] order, keep the human-operates disclaimer visible in the UI.

Current priorities (in order):
1. Side-by-side comparison view: QZ1 track vs phone-GPS track from same walk,
   with drift distance readout — this is the core pitch figure.
2. Threshold config externalized to JSON so farmer-sourced values drop in cleanly.
3. Paddy-field dataset slot: replace campus demo data without code changes.
4. Robustness: Open-Meteo UTC→JST display check; NMEA parser already handles
   $L1BAT/$L1MAG/$GN* noise (5497 skipped lines verified correct — don't "fix" it).

Definition of done for any feature: works on GitHub Pages static hosting,
demo-able offline with bundled sample data, visible fix-quality triplet (fix/sats/HDOP).
```

Deck: `Suimon_Navi_Plan.pptx` (13 slides: +実証進捗 +発展構想 +全体アーキテクチャ +必要機材と依頼事項) mirrors this brief — keep both in sync when strategy changes.
