# 水門ナビ / Suimon Navi

準天頂衛星「みちびき」ハッカソン entry — Team E, Nara KOSEN (KAI, solo).

Suimon Navi is a decision-support web app for irrigation floodgate (水門) timing on a real wheat field, built on QZSS positioning data. This repo started as a pond-hazard map (`Michibiki Pond Map`) and pivoted to Suimon Navi; the NMEA-parsing and mapping code from that project is reused here. Full plan: [`Suimon_Navi_Plan.pptx`](./Suimon_Navi_Plan.pptx).

## 地域課題 (The problem)

A real wheat field — belonging to a friend's grandfather — is irrigated through a manually-operated floodgate. Open/close timing currently relies on the farmer's long experience and intuition rather than precise field geometry or weather data. That judgment gets harder for older farmers, and there's no guarantee a successor could match the same precision — a succession risk on top of the day-to-day one. Since irrigation precision directly affects rice yield and quality, this is worth solving now.

## 技術の壁 (The technical wall)

**Phone GPS alone:** multipath error in built-up/shaded areas causes ~5m drift in practice, risking confusion between nearby features (ridges, channels) — not precise enough to record field geometry reliably.

**QZ1 + みちびき SLAS:** only a **blue QZ1** receiver (L1S/SLAS) was available; a CLAS/centimeter-class receiver was unavailable to us. SLAS augmentation is not guaranteed by the organizer, so it's framed as a conditional upside rather than a confirmed feature — **if** it's active (shown by fix-quality `2` in the QZ1's NMEA GGA sentences), accuracy improves to sub-meter (~1m) and adjacent field features become distinguishable. The design still has to work without it.

## ソリューション (Solution)

Suimon Navi is a decision-support web app for floodgate timing — not an automation system. It combines high-precision field geometry (surveyed with the QZ1, better when SLAS is active) with weather data to recommend when to open or close the gate. The farmer still operates the gate manually; physically automating real floodgate hardware is explicitly out of scope, both for hackathon fit and to avoid the liability of automating physical infrastructure.

## 技術構成 (Tech stack)

- **Field hardware:** Blue QZ1 GNSS receiver (L1S/SLAS, Bluetooth SPP) + Android Pixel 6a, logging NMEA and confirming `fix=2` when augmented
- **Live capture (PC):** Web Serial API — QZ1 paired over Bluetooth appears as a virtual serial port in Chrome/Edge; the app streams, plots, and saves NMEA live (with screen Wake Lock during recording). Phones can't reach SPP from a browser, so Pixel/iPhone use log-app + file upload
- **Mapping:** Leaflet + Leaflet.markercluster (auto-clusters logs >400 points, e.g. 1Hz walked/drone surveys) + Turf.js (field area from the boundary polygon)
- **Data:** Static JSON (field geometry + gate rules + weather input) — no cloud DB or login for the MVP, so effort stays on 完成度 (completeness)
- **App:** Plain HTML/CSS/JS, hosted on GitHub Pages
- **Reused from Pond Map:** NMEA file upload/paste, GGA parsing with fix-quality coloring, survey point tagging, JSON export/import, phone-GPS vs. QZ1 comparison layer, layer toggles, augmented-only filter, summary bar

## ドローン拡張計画 (Drone expansion — stretch goal)

Aircraft: Holybro X500 V2. Rather than relying on live Bluetooth telemetry (SPP range ~10–30m, unreliable at real flight distances), the drone flies on its own onboard GPS and carries the QZ1 as a payload, logging in-flight; data is recovered after landing. Aircraft registration and 航空法 compliance are done, and test flights are cleared at school (teacher-approved, crop-free area). Flying over the actual field still needs the grandfather's explicit consent and a companion present — solo fieldwork and solo drone flights are banned by the hackathon rules.

## 検証・フィールドワーク計画 (Validation plan)

1. Payload test at school (crop-free area, teacher-approved)
2. Get explicit consent from the grandfather for field survey + overflight
3. Walked survey with a companion (QZ1 + Pixel) — the reliable MVP path
4. Drone survey over the field (stretch) for higher-density geometry data

## ロードマップ (Roadmap to 9/4)

- **July:** prove the core loop — one real QZ1 point through to map display, end-to-end. Build the static JSON skeleton.
- **Early August:** start data collection — walked survey of the field, school-based drone payload test, weekly check-ins begin.
- **Late August:** stretch features — drone flight over the field (after consent), weather-integration logic.
- **9/1–9/4:** on-site camp and final presentation at Nagaoka KOSEN (10-min talk + 10-min Q&A).

## 審査基準への対応 (Rubric alignment)

| 評価項目 | 配点 | 対応内容 |
|---|---|---|
| 地域課題の的確さ | 25 | Real grandfather + real field; manual gate-operation burden confirmed by on-site interview |
| 位置情報の活用度 | 25 | Field geometry recorded at high precision when SLAS is available (fix=2, satellite count, HDOP) |
| 完成度 | 20 | Static-JSON-first MVP, live and working on GitHub Pages |
| プレゼンテーション | 15 | Structured as 課題 → 技術の壁 → 解決策 → デモ |
| 発展可能性 | 15 | Extensible to other fields; drone-based survey as a growth path |

Special awards targeted: ベストフィールドワーク賞 (real fieldwork emphasis) / 技術チャレンジ賞 (drone-mounted SLAS survey).

## Hardware Notes

The blue QZ1 receiver has no screen, so the NMEA logs are the evidence source for augmentation status. In GGA sentences, a fix-quality field value of `2` indicates a differential GNSS fix — used here as the signal that みちびき augmentation is active, when it's available.

## How to Use

1. Serve the repo over HTTP so the app can fetch `data/*.json` — GitHub Pages, or locally e.g. `python3 -m http.server 4173`. Opening `index.html` directly (`file://`) also works: the app falls back to built-in copies of the same data.
2. **NMEAをアップロード** — load a QZ1 log (`.nmea`). Valid GGA sentences are plotted: green = SLAS-augmented (fix=2), orange = plain GPS. The summary bar shows totals, skipped lines, and tag counts.
   - Or record live: on a PC (Chrome/Edge, HTTPS/localhost) with the QZ1 paired via Bluetooth, use the **QZ1ライブ記録** card — connect to the serial port, watch the NMEA tail, see points appear on the map in real time, and save the raw log as `.nmea`. On phones the card explains the fallback (log app + upload).
3. Click a point to tag it (水門 / 畦 / 水路 / 圃場の角 / その他), attach a photo reference and note, then save. **Tagging a point as 水門 promotes that QZ1-surveyed point to the app's gate location** (shown in the 圃場・水門 card; revert with 「水門位置を初期値に戻す」).
4. **測量JSONを書き出し / 読み込み** — export or re-import the tagged survey as JSON.
5. The right panel recommends **開ける / 閉める / 様子見** from the weather inputs and the thresholds in `data/gate_rules.json`. Both are editable live in the panel for demos; persistent values live in the JSON files.
6. **📍 スマホGPSを記録** — record phone-GPS points (with accuracy circles) for the phone-vs-QZ1 comparison layer. Requires HTTPS or localhost plus location permission.

Static data lives in `data/field.json` (boundary, channel, initial gate position), `data/gate_rules.json` (decision thresholds), and `data/weather.json` (initial weather input).
