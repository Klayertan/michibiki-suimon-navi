# Drone Work — Context for the Water-Sensor Side

**Audience:** the AI assistant (and developer) working on the **water sensor** part of SuisuiNavi.
**Written by:** KAI's assistant, 2026-10-12, from a read of `Klayertan/michibiki-suimon-navi` (`main` @ `4152769`, plus the remote branches).
**Purpose:** explain what the **drone** workstream is, where its code lives, and how to avoid colliding with it. You do not need to work on the drone. You need to know where it stops and your work starts.

> Read this together with `README.md`, `CLAUDE.md` and `docs/ARCHITECTURE.md`. This file does not replace them.

---

## 1. The project in three lines

SuisuiNavi (スイスイナビ / 水門ナビ) is a decision-support web app for rice-paddy water management. It uses QZSS/Michibiki (QZ1 receiver) to measure field boundaries. It turns growth stage, area, water level and weather into a recommended depth, a required water volume and an open/close/wait gate verdict. It is decision support only. The farmer operates the gate.

## 2. How the work is split

| | Owner | Scope |
|---|---|---|
| **Drone** | KAI | The Holybro X500 V2 drone: telemetry, pilot control, flight-path planning, the data link, and drone-borne payloads. Details below. |
| **Water sensor** | KAI's friend (you) | Getting a trustworthy water-level reading into the app. Appears to be the QZ1 floating water-level work, per branch `feature/qz1-floating-water-level` (see §6). Confirm the exact scope with your user. |

The two meet at **one data contract**, the water-measurement record (§5). Keep to it and the two sides can be built and merged independently.

---

## 3. What the drone workstream is

**Hardware:** Holybro X500 V2, Pixhawk 6C, ArduCopter 4.5.7. The ground link is a telemetry radio into the PC on COM10 at 57600 baud (vehicle side is TELEM2). The planned payload is the QZ1 GNSS receiver, a Jetson Orin Nano Super with an Intel RealSense D435, and later an E220 LoRa link.

**Software, already in the repo:**

| Piece | What it does | Where |
|---|---|---|
| MAVLink telemetry backend | FastAPI + `pymavlink`. Reads attitude, battery, GPS and flight mode, and serves them over REST and a WebSocket. Mock mode by default. | `backend/app/main.py`, `backend/app/mavlink/` |
| Drone UI | Telemetry panel and the 巡回/接続 (patrol/link) tabs. | `js/drone/`, drone sections of `index.html` |
| Pilot control (opt-in) | Low-speed velocity control from keyboard or gamepad, with safety gates. | `js/pilot/`, `backend/app/mavlink/pilot_service.py`, `pilot_limits.py` |
| Gamepad/keyboard input | Input sources only. They deliberately cannot send commands. | `js/gamepad/` |
| Flight-path planner | "ドローン飛行計画 / Lawnmower path": a boustrophedon survey path over the field polygon, a transit line between passes, and an explicit "apply" step. This is the area most actively changed in recent commits. | `js/paddy-intelligence.js`, drone workspace in `index.html` |
| Desktop app | Windows build with pywebview/WebView2 and PyInstaller. Defaults to Preview mode. | `desktop/`, `packaging/`, `scripts/*.ps1` |
| Data link plan | Phase 0 is onboard logging (QZ1 plus a phone). Phase 1–3 is a LoRa (E220) downlink into the existing Web Serial "QZ1ライブ記録" card. | `docs/DRONE_LINK_PLAN.md` |
| Jetson perception | RealSense capture, weed/pest detection and georeferencing. Experimental and not wired to the web app. | `edge/perception/` (`feature/jetson-ground-station`) |

**Reference docs:** `docs/MAVLINK_INTEGRATION_REPORT.md`, `docs/MAVLINK_OPERATOR_GUIDE.md`, `docs/PILOT_CONTROL_GUIDE.md`, `docs/DRONE_LINK_PLAN.md`, `docs/CLAUDE_HANDOFF.md`, `docs/GAMEPAD_*`, `docs/DESKTOP_*`.

### Drone safety rules (these matter to anyone touching the repo)

1. **Never broaden drone control.** There is no takeoff, land, RTL, mission upload, motor test, force-arm or parameter write. The one authorized exception is the opt-in low-speed velocity control (≤0.30 m/s), which only works when the operator has already armed the vehicle and selected GUIDED.
2. Speeds and MAVLink constants live **only** in `backend/app/mavlink/pilot_limits.py` and `pilot_service.py`. Don't copy them anywhere else.
3. `js/gamepad/` must stay transport-free. Tests scan it for `fetch(`, `WebSocket(` and command tokens.
4. Never open the real serial port or power the aircraft to develop UI. Use the mock backend (`npm run backend:mock`).
5. The pilot-control path has **not** been validated on real hardware or in SITL. Don't describe it as flight-proven.
6. Automatic gate control is out of scope on purpose.

---

## 4. Where the two workstreams could collide

**Rule of thumb: stay out of the drone-owned paths, and ask before editing shared ones.**

| Path | Status |
|---|---|
| `js/drone/`, `js/pilot/`, `js/gamepad/`, `backend/`, `desktop/`, `packaging/`, `edge/` | **Drone-owned.** Don't edit these. |
| `js/water/`, `js/qz1-water-level/`, `css/qz1-water-level.css`, `experiments/qz1-water-level/` | **Water-sensor-owned.** The drone side won't touch them. |
| **`index.html`** (about 517 KB, one file) | **Shared and the biggest conflict risk.** Drone UI and water UI both live in it. See below. |
| `tests/`, `docs/`, `README.md`, `package.json`, `package-lock.json` | Shared. Add files, don't rewrite existing ones. |
| `js/cloud/`, `cloud_backend/`, `config/cloud-config.js` | Neither of us. Leave alone unless you're asked. |

**Handling `index.html`:** keep edits small and local, and put new logic in new modules under `js/qz1-water-level/` rather than inline. Commit often so the diff stays reviewable. Rebase or merge `main` before opening anything, and don't reformat or reorder existing blocks. Water-related code is around the `suimonNaviCurrentWaterLevelV1`, `…TargetWaterLevelV1` and `…FieldGrowthStageV1` storage keys. Drone UI is the ドローンモード workspace (the 巡回/接続 tabs, the flight-path card and the mode gate).

**Branch note:** `main` is **behind** the water-sensor branch. `feature/qz1-floating-water-level` carries about 20k added lines, including sensor registry, calibration and experiment code, plus a **Cloudflare hosting migration**. `main` still documents Sakura as the host. Check before assuming either is current, and don't "fix" the README to match one without asking.

**Repo workflow (`CLAUDE.md`):** after a task that changes files, run the relevant tests and **commit automatically** with a Conventional Commit message. **Never push** unless the user explicitly asks, and never force-push. Commit only the files for your task.

---

## 5. The contract between the two sides: the water-measurement record

This is the one interface that matters to you. It is defined in `js/water/water-measurement.js`. The recommendation engine sees **only** this shape and does not care who wrote it:

```js
{
  valueMm:    number,          // SIGNED, millimetres. canonical value
  valueCm:    number,          // derived (mm/10); never entered independently
  reference:  "soil-surface",  // the datum. the only one currently known
  source:     "manual" | "realsense" | "sensor" | "drone" | <future id>,
  measuredAt: number           // epoch ms (ISO string is accepted on input)
}
```

- **Sign convention.** `+50` is 5 cm of standing water. `0` is water at the soil surface. `-150` is the water table 15 cm below the surface (the IRRI safe-AWD threshold). Never use `Math.abs()` on a depth. Never clamp a negative to 0.
- **No fabricated zeros.** Missing or invalid input must produce `null`, never `0`. `buildWaterMeasurement()` is strict about this.
- **Unknown datum → unreadable.** A record naming a `reference` this build doesn't know is reported as unreadable, not silently re-read as soil-surface. If your sensor uses a different datum (for example sensor-relative height), add it explicitly to `WATER_LEVEL_REFERENCES`. Do not overload `soil-surface`.
- **Persistence.** The key is `suimonNaviCurrentWaterLevelV1`, shaped `{ [fieldId]: entry }`. `toPersistedEntry()` writes the legacy pair (`valueCm`, `recordedAt`) and the new fields together. **Backward compatibility is a hard constraint.** Don't migrate or rewrite stored rows.
- **Staleness.** A reading older than `STALE_MEASUREMENT_DAYS` (3) shows a "confirm on site" warning.
- **To add a source,** write a record with your own `source` id and add a label in `MEASUREMENT_SOURCES`. Nothing downstream should need to change.

### Drone-to-water touchpoints, so you aren't surprised

- `MEASUREMENT_SOURCES.drone` and `.realsense` already exist as reserved ids. **No drone code writes water levels today.** If the drone side ever emits a reading, it will use this same record.
- **RealSense is not a reliable standalone water-level sensor.** Reflective, textureless water gives invalid stereo depth, and `edge/perception/README.md` and `docs/CLAUDE_HANDOFF.md` both say so. A dedicated reference or sensor is needed for water height. This is part of why the water-sensor work is separate from the drone's camera.
- **Possible shared hardware.** The RealSense D435 on the Jetson (`edge/perception/`) is the drone's payload. If your sensor design needs it too, coordinate with KAI first.
- **Camera model.** The brief says "D345", but the verified device is a **D435** (serial and firmware in `edge/perception/README.md`). Don't hard-code model numbers.
- **Positioning.** Both sides depend on QZ1 GNSS. Remember the project's honesty rule: **no centimeter-accuracy claims.** Report fix quality, HDOP and QZSS satellites separately. SLAS is "unconfirmed" until the receiver proves it.

---

## 6. What this assistant could and couldn't confirm

**Read directly from the repo:** everything in §3 and §5, and the file ownership in §4 (from paths and commit history).

**Inferred (verify with KAI):**
- That the water-sensor work is the QZ1 floating-water-level line (`feature/qz1-floating-water-level`, with its `docs/qz1-floating-water-level/` set). That branch is unmerged, so check how it relates to `main`.
- The "KAI owns drone, friend owns water sensor" split. It comes from the user's description, not from anything in the repo.

**Open questions for KAI:**
1. Is the water sensor the QZ1 floating experiment, a separate physical sensor, or the RealSense? Which `source` id does it write?
2. Will the drone ever write water readings, or only imagery, GNSS and photos?
3. Which `index.html` regions does each side own? Agree on this before editing.
4. Which branch is the base: `main`, or the water-sensor branch with the Cloudflare migration?
5. Hosting: Sakura (documented on `main`) or Cloudflare (on the water branch)?

---

## 7. Commands

```bash
npm run test            # JS unit tests (node --test tests/unit/*.test.js)
npm run test:backend    # Python backend tests
npm run test:browser    # Playwright
npm run test:all
npm run serve           # static dev server at http://localhost:4173/
npm run dev             # frontend + mock drone backend
```

Water-model tests are in `tests/unit/`. Run them after any change near `js/water/`.
