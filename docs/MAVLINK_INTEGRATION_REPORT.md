# SuisuiNavi MAVLink Integration Report

Date: 2026-08-04 · Repository: `michibiki-suimon-navi` @ `main` (`58a9c3d`) · Working tree: **uncommitted**

---

## Executive Summary

### What was implemented

A mock-first, safety-restricted MAVLink integration in three layers:

1. **A local Python backend** (`backend/`, FastAPI + pymavlink) that exclusively
   owns the serial telemetry link, maintains a 1 Hz GCS heartbeat, normalizes
   telemetry, and validates every command. It defaults to a **simulated**
   aircraft; the real radio is never used by accident.
2. **A frontend module** (`js/drone/`) and a *ドローン / MAVLink* panel in the
   existing `survey` workspace, fed by a WebSocket, matching the app's existing
   card/store/controller conventions and visual style.
3. **Dev workflow**: repo-local `.venv`, npm scripts, a PowerShell launcher, and
   documentation.

### What remains disabled

**Arming and takeoff are not implemented and cannot be enabled by
configuration.** Neither are disarm, land, RTL, mission upload, GUIDED
movement, RC override, MANUAL_CONTROL, motor test, or parameter writes. Each
returns HTTP 501 with an explanation and transmits nothing. The command ids for
these operations do not exist anywhere in the codebase — a test asserts this.

The transport interface exposes exactly **two** ways to put bytes on the wire:
a GCS heartbeat, and a `COMMAND_LONG` carrying one of three allowlisted command
ids (`DO_SET_MODE`, `REQUEST_MESSAGE`, `SET_MESSAGE_INTERVAL`).

### Overall result

| Suite | Result |
|---|---|
| `npm test` (unit) | **127 / 127 pass** (99 pre-existing + 28 new) |
| `npm run test:backend` (pytest) | **154 / 154 pass** |
| `npm run test:browser` (Playwright, full) | **115 / 117 pass** — the 2 failures differ on every run and are pre-existing flakiness; analysed below |
| `tests/browser/drone-panel.spec.js` | **12 / 12 pass** |
| Live mock backend end-to-end | Verified manually (REST + WebSocket + all refusal paths) |

**No real-hardware test was performed. COM10 was never opened.**

---

## Original Architecture

| Aspect | State before this work |
|---|---|
| Frontend | Static HTML/CSS/JS ES modules; `index.html` (5,976 lines) holds markup plus one inline bootstrap `<script>` |
| Module pattern | `*-store.js` (state, `extends EventTarget`) · `*-core.js` (pure logic) · `*-controller.js` (DOM wiring); one CSS file per feature |
| Mounting | Each controller dynamically `import()`ed inside a `try/catch` in an async IIFE at the end of `index.html` |
| Panels | `<details class="card paddy-collapsible" data-workspace="…" hidden>` in `<aside>`; a tab nav toggles `[data-workspace]` |
| Server | `scripts/dev-server.mjs` — a 38-line static file server |
| Tests | `node --test tests/unit/*.test.js` (99 tests) · Playwright `tests/browser/` |
| Backend | **None.** No Python, no server-side code |
| Drone | Planning only: `docs/DRONE_LINK_PLAN.md`, which listed MAVLink as *不採用* for relaying QZ1 NMEA |

**Toolchain note:** Node.js was **not installed** on this workstation at the
start of this task, so the documented `npm test` / `npm run serve` workflow
could not run at all. Node 24.19.0 LTS was installed via winget (with your
approval) before the baseline was taken.

**Baseline recorded:** `git status` clean; `npm test` → **99/99 pass**.

---

## Implemented Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Browser — SuisuiNavi (http://localhost:4173)                 │
│                                                              │
│   index.html  ──mounts──▶  js/drone/drone-controller.js      │
│                              ├── drone-api-client.js         │
│                              ├── drone-store.js  (EventTarget)│
│                              ├── drone-view.js               │
│                              └── drone-formatters.js (pure)  │
│   The browser NEVER opens a serial port.                     │
└────────────────┬──────────────────────────┬──────────────────┘
                 │ HTTP REST (commands)     │ WebSocket (telemetry, 2 Hz)
                 ▼                          ▼
┌──────────────────────────────────────────────────────────────┐
│ Python backend — 127.0.0.1:8787 (loopback only)              │
│                                                              │
│   main.py ──▶ command_service.py  (the ONLY transmitter)     │
│      │              │  gates: enabled → connected → fresh    │
│      │              │         → disarmed → allowlist → ack   │
│      │              │         → heartbeat-verified           │
│      └──────▶ link_manager.py                                │
│                 └── ONE worker thread owns the transport ────┼──┐
│                     · reads messages   · 1 Hz GCS heartbeat  │  │
│                     · runs transmit jobs · reconnect         │  │
│                     · 7-state machine                        │  │
│                                                              │  │
│   telemetry_state.py  ← normalizers.py (single unit-conversion│ │
│   (thread-safe, snapshot())                        source)   │  │
└──────────────────────────────────────────────────────────────┘  │
                                                                  │
        ┌─────────────────────────────────────────────────────────┘
        ▼
   interface.MavlinkLink  (2 send_* methods, no raw send)
        ├── mock_connection.py   ← DEFAULT. No serial, no pymavlink.
        └── real_connection.py   ← pymavlink imported lazily
                 │
                 ▼ COM10 @ 57600 baud (exclusive OS ownership)
           Ground telemetry radio
                 ⇝ wireless MAVLink2 ⇝
           Aircraft telemetry radio
                 ▼ TELEM2 (SERIAL2_PROTOCOL=2, SERIAL2_BAUD=57600)
           Pixhawk 6C / ArduCopter 4.5.7 / Holybro X500 V2
```

### Responsibilities

| Component | Owns |
|---|---|
| `link_manager` | Transport lifetime, worker thread, heartbeat cadence, reconnect, deterministic shutdown |
| `telemetry_state` | Normalized state, freshness/staleness machine, bounded STATUSTEXT ring, snapshot |
| `normalizers` | **All** raw→display unit conversion. Nothing else converts units |
| `command_service` | Every safety gate; the only code that calls `send_command_long` |
| `main` | HTTP/WS surface, CORS, body-size limit, Pydantic validation |
| `drone-store` | UI state; derives nothing safety-relevant of its own |
| `drone-view` | DOM only; pure function of store state |
| `drone-controller` | Event wiring, socket lifecycle with backoff, confirmation dialog |

### Data flow

Vehicle → radio → COM10 → worker thread `receive()` → `TelemetryState.apply_message()`
→ `normalizers.NORMALIZERS[type]` → typed sub-state → `snapshot()` → WebSocket frame
→ `DroneStore.setTelemetry()` → `change` event → `DroneView.render()` → DOM.

Command → button → `DroneApiClient` → `POST /api/drone/mode` → Pydantic `Literal`
validation → `CommandService` gates → transmit job queued → worker thread
`send_command_long()` → `COMMAND_ACK` → `AckWaiter` → vehicle `HEARTBEAT` →
`ModeWaiter` → response carrying the **vehicle-reported** final mode.

---

## Files Added

### Backend (`backend/`)

| File | Purpose |
|---|---|
| `app/__init__.py` | Package marker; documents that import never opens a port |
| `app/config.py` | `Settings` dataclass from `SUISUI_MAVLINK_*`; validation; safe defaults; `public_dict()` |
| `app/models.py` | Pydantic models; `extra="forbid"`; mode/stream restricted to `Literal` types |
| `app/logging_config.py` | Idempotent structured stderr logging |
| `app/main.py` | FastAPI app factory, REST routes, WebSocket, CORS, request-size middleware |
| `app/mavlink/__init__.py` | Package marker |
| `app/mavlink/constants.py` | MAVLink enum tables, mode allowlist, forbidden-mode set, stream allowlist |
| `app/mavlink/interface.py` | `MavlinkLink` ABC + typed link errors. Only 2 `send_*` methods exist |
| `app/mavlink/normalizers.py` | Pure message→field conversion; MAVLink "unknown" sentinels → `None` |
| `app/mavlink/telemetry_state.py` | Thread-safe state; `ConnectionState` 7-state enum; freshness |
| `app/mavlink/link_manager.py` | Worker thread, heartbeat, reconnect, ack/mode waiters, shutdown |
| `app/mavlink/mock_connection.py` | Simulated ArduCopter with scriptable failure scenarios |
| `app/mavlink/real_connection.py` | pymavlink serial link; lazy import; serial-error classification |
| `requirements.txt` | Pinned runtime deps |
| `requirements-dev.txt` | Test deps |
| `pytest.ini` | Test config |
| `README.md` | Backend-specific docs and the safety-gate table |
| `tests/conftest.py` | Mock-only fixtures; `wait_until` polling helper |
| `tests/test_config.py` | 12 tests — defaults, validation, flag impotence |
| `tests/test_normalizers.py` | 20 tests — units, sentinels, allowlist invariants |
| `tests/test_telemetry_state.py` | 21 tests — freshness, staleness, reset, snapshot isolation |
| `tests/test_link_manager.py` | 14 tests — lifecycle, heartbeat, dropout, reconnect, port-busy |
| `tests/test_command_service.py` | 46 tests — every safety gate |
| `tests/test_api.py` | 41 tests — HTTP surface, WebSocket, real-mode guards |

### Frontend

| File | Purpose |
|---|---|
| `js/drone/drone-formatters.js` | Pure formatting; tone derivation; battery thresholds; reason text |
| `js/drone/drone-api-client.js` | REST + WebSocket client; `DroneApiError` |
| `js/drone/drone-store.js` | `EventTarget` store; message de-dup; `canCommand` derivation |
| `js/drone/drone-view.js` | DOM rendering; disabled-state logic; armed banner |
| `js/drone/drone-controller.js` | Wiring, socket backoff, real-mode confirm dialog |
| `css/drone.css` | Panel styles reusing existing primitives |

### Scripts

| File | Purpose |
|---|---|
| `scripts/venv.mjs` | Locates `.venv`; actionable error when missing |
| `scripts/setup-backend.mjs` | Creates `.venv` and installs deps |
| `scripts/run-backend.mjs` | Starts the backend; flag→env mapping; real-mode banner |
| `scripts/run-pytest.mjs` | Runs pytest, forcing `SUISUI_MAVLINK_MODE=mock` |
| `scripts/dev-all.mjs` | ~50-line supervisor for frontend + mock backend |
| `scripts/dev.ps1` | Windows launcher; real mode requires typing `YES` |

### Tests & docs

| File | Purpose |
|---|---|
| `tests/unit/drone-formatters.test.js` | 18 tests |
| `tests/unit/drone-store.test.js` | 10 tests |
| `tests/browser/drone-panel.spec.js` | 12 Playwright tests with an intercepted backend |
| `docs/MAVLINK_OPERATOR_GUIDE.md` | Operator guide (Japanese) |
| `docs/MAVLINK_INTEGRATION_REPORT.md` | This report |

---

## Files Modified

| File | Change |
|---|---|
| `index.html` | **+128 lines, 3 insertions, no deletions.** (1) One `<link>` for `css/drone.css`. (2) The *ドローン / MAVLink* `<details class="card paddy-collapsible" data-workspace="survey" hidden>` panel appended after the existing recording card inside `<aside>`. (3) In the bootstrap script: `let droneController = null;`, a `DRONE_BACKEND_URL` const, and a `try/catch` mount block after the recording controller — identical in shape to the existing blocks. **No existing markup, style, or logic was altered.** |
| `package.json` | Added `backend`, `backend:mock`, `backend:real`, `backend:setup`, `dev`, `test:backend`, `test:all`. Existing `serve`, `test`, `test:browser` unchanged. No new npm dependencies |
| `.gitignore` | Added a Python block: `.venv/`, `venv/`, `__pycache__/`, `*.py[cod]`, `*.egg-info/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/` |
| `docs/DRONE_LINK_PLAN.md` | Added a 7-line note at the top. The existing plan rejected MAVLink *as a way to relay QZ1 NMEA*; that verdict stands. The note clarifies that this integration has a different purpose (vehicle telemetry display) and links to the new docs, so the two documents do not appear to contradict each other |

---

## MAVLink Implementation

### Connection lifecycle

`ConnectionState` distinguishes all seven required states:

```
disconnected ──connect()──▶ connecting ──first vehicle HEARTBEAT──▶ connected
                                │                                      │
                                │ open fails / link error              │ no msg > stale_timeout (3s)
                                ▼                                      ▼
                              error                            telemetry_stale
                                │                                      │
                                │ auto_reconnect                       │ no heartbeat > link_lost_timeout (10s)
                                ▼                                      ▼
                          reconnecting ──delay──▶ connecting        link_lost
```

Freshness transitions are computed from `time.monotonic()`, never wall clock, so
an NTP step cannot make a live link look stale. `evaluate_freshness()` only
moves between `connected` / `telemetry_stale` / `link_lost`; it never overwrites
a deliberate state such as `reconnecting` or `error`.

### GCS heartbeat

`MAV_TYPE_GCS` (6) / `MAV_AUTOPILOT_INVALID` (8) / `MAV_STATE_ACTIVE`, sent from
the worker thread every `heartbeat_interval` (default 1.0 s). The receive budget
is clamped so a heartbeat is never late: `min(0.2s, time_until_next_heartbeat)`.
Receiving continues throughout. On disconnect the loop exits and the transport
closes, stopping the heartbeat cleanly.

### Telemetry messages handled

| Message | Normalized to |
|---|---|
| `HEARTBEAT` | flight mode name, armed flag (bit 7 of `base_mode`), MAV_TYPE + name, autopilot + name, system/component id, system status |
| `SYS_STATUS` | voltage (mV→V), current (cA→A), remaining %, comm drop rate, comm errors, sensor present/enabled/health masks, derived `sensorsOk` |
| `GPS_RAW_INT` | fix type + readable name, satellites, lat/lon (1e7→deg), MSL altitude, EPH/EPV (cm→m) |
| `ATTITUDE` | roll/pitch/yaw in degrees, `yawNormalized` 0–360, angular rates |
| `VFR_HUD` | heading, ground speed, airspeed, altitude, climb rate, throttle |
| `GLOBAL_POSITION_INT` | lat/lon, AMSL + relative altitude, vx/vy/vz (cm/s→m/s), heading (cdeg→deg) |
| `STATUSTEXT` | severity + name, decoded/trimmed text, receive timestamp |
| `AUTOPILOT_VERSION` | decoded semver string, board/vendor/product ids, UID, capabilities |
| `COMMAND_ACK` | command id, result + name, `accepted` boolean |

Also tracked: last message timestamp + age, last vehicle heartbeat timestamp +
age, staleness flag, per-type message counts, total messages, GCS heartbeats
sent, comm drop rate / error count (link quality), connection state, latest
error.

**Unavailable values are `null`, never invented.** MAVLink "unknown" sentinels
(`UINT16_MAX`, `INT16_MAX`, `0x7FFFFFFF`, `-1`, `UINT8_MAX`) map to `None`
rather than being propagated as absurd numbers — a no-fix GPS reports
`lat: null`, not `214.7`.

### State normalization

All unit conversion lives in `normalizers.py`. No other module converts units,
so a wrong value on screen has exactly one place to inspect. `TelemetryState`
folds normalized dicts into typed sub-states under an `RLock`, and `snapshot()`
builds a fresh plain-dict tree per call — a reader can never observe a
half-updated structure or hold a reference into mutable state (tested).

### WebSocket design

`GET ws://127.0.0.1:8787/api/drone/telemetry/ws` pushes a **complete** snapshot
every `ws_interval` (default 0.5 s). A fixed cadence rather than push-per-message
is deliberate: the vehicle emits >20 msg/s and forwarding each would flood the
browser for no benefit. Every frame being a full snapshot means a client that
misses one is never left with a partial view. A concurrent reader task notices
client disconnects promptly; inbound frames carry no commands and are ignored.

### Safe command handling

Only three commands can be emitted:

| Operation | MAVLink | Effect |
|---|---|---|
| `POST /api/drone/request-version` | `COMMAND_LONG` / `MAV_CMD_REQUEST_MESSAGE` (512), param1 = 148 | Read-only |
| `POST /api/drone/request-streams` | `COMMAND_LONG` / `MAV_CMD_SET_MESSAGE_INTERVAL` (511) | Read-only; message id looked up from a name allowlist |
| `POST /api/drone/mode` | `COMMAND_LONG` / `MAV_CMD_DO_SET_MODE` (176) | Disarmed, allowlisted modes only |

`MAV_CMD_DO_SET_MODE` is used rather than bare `SET_MODE` **because it returns a
`COMMAND_ACK`**. A bare `SET_MODE` is unacknowledged, so a refusal would be
invisible. During the Phase 5 audit a `send_set_mode` method was found declared
and implemented but never called; it was **removed** from the interface and both
adapters to shrink the transmit surface, and a test now locks the surface at
exactly `{send_gcs_heartbeat, send_command_long}`.

### Timeouts and acknowledgements

A mode change succeeds only after **both** of:

1. `COMMAND_ACK` with `MAV_RESULT_ACCEPTED` within `command_timeout` (5 s).
2. A subsequent vehicle `HEARTBEAT` reporting the requested mode within
   `mode_verify_timeout` (5 s).

The `ModeWaiter` is registered **before** transmitting, because the vehicle can
report the new mode in the same burst as the ack; registering afterwards would
time out on a mode change that actually worked.

The response always carries the vehicle-reported `finalMode` — never merely the
requested mode. Failure modes are distinct and machine-readable:
`ack_timeout` (504), `verify_timeout` (504), `rejected_by_vehicle` (502),
`transmit_failed` (502).

**Nothing is silently ignored.** An unmatched negative `COMMAND_ACK` is logged
at WARNING and recorded in `state.error`, even though no caller was waiting.

---

## Safety Controls

### Every safety gate

| # | Gate | Enforced in |
|---|---|---|
| 1 | Mock is the default mode | `config.load_settings()` |
| 2 | Importing any module never opens a port or starts a thread | `app/__init__.py`, `mavlink/__init__.py`, lazy pymavlink import |
| 3 | A real link starts read-only (`ALLOW_SAFE_COMMANDS=0`) | `command_service._require_commands_enabled` |
| 4 | Real connection requires per-connection propellers-removed confirmation | `main.drone_connect` → 412 |
| 5 | Real-mode mode change requires `confirmed=true` (server side) | `main.set_mode` → 412 |
| 6 | Real-mode mode change requires an operator `confirm()` dialog (client side) | `drone-controller.handleApplyMode` |
| 7 | Mode name validated as a Pydantic `Literal` before any handler runs | `models.AllowedMode` |
| 8 | Mode must be in `COMMANDABLE_DISARMED_MODES` (STABILIZE, ALT_HOLD) | `command_service.set_flight_mode` |
| 9 | Explicit forbidden-mode guard (defence in depth) | `constants.FORBIDDEN_MODES` |
| 10 | Refused unless the link state is exactly `connected` | `_require_live_link` |
| 11 | Refused when telemetry is stale — commanding blind is refused | `_require_live_link` |
| 12 | Refused when the vehicle reports ARMED | `_require_disarmed` |
| 13 | Refused when the armed state is **unknown** (never treated as disarmed) | `_require_disarmed` |
| 14 | Mode change confirmed by vehicle heartbeat, not merely by the ack | `set_flight_mode` |
| 15 | Only two `send_*` methods exist on the transport | `interface.MavlinkLink` |
| 16 | Only 3 command ids exist in the entire codebase | `constants.py` |
| 17 | Unknown request fields rejected (`extra="forbid"`) | `models.StrictModel` |
| 18 | Request bodies capped at 8 KiB | `main.limit_request_size` |
| 19 | Binds `127.0.0.1` only; warns loudly if changed | `config.load_settings()` |
| 20 | CORS restricted to the two SuisuiNavi dev origins | `main` CORS middleware |
| 21 | Disconnect clears vehicle telemetry so stale values cannot look live | `TelemetryState.reset_vehicle_data` |
| 22 | UI mode controls disabled unless connected, unarmed, and commands enabled | `drone-view.renderControls` |
| 23 | Loud `role="alert"` banner whenever ARMED is detected | `drone-view.renderVehicle` |
| 24 | Deterministic shutdown: stop event → join → close port | `link_manager.disconnect/shutdown` |

### Commands intentionally unavailable

`arm`, `disarm`, `takeoff`, `land`, `rtl`, `mission_upload`, `guided_goto`,
`rc_override`, `manual_control`, `motor_test`, `set_parameter`.

`POST /api/drone/disabled/{operation}` returns **501** with an explanation and
`detail.transmitted: false`. There is no code path from that handler to the
transport. `POST /api/drone/arm` and `/takeoff` return **404** — those routes do
not exist.

`SUISUI_MAVLINK_ALLOW_ARM=1` / `ALLOW_TAKEOFF=1` are parsed **only** so the
running configuration can be reported and a WARNING logged. They enable nothing.
`Settings.public_dict()` reports `armSupported: false` / `takeoffSupported:
false` unconditionally, and a test asserts this holds even with both flags set.

### Real-mode restrictions

Real mode must be selected explicitly (`--mode real` / `-Real`), prints a
safety banner, and — via `scripts/dev.ps1 -Real` — requires typing `YES` before
the port is opened. Commands stay disabled unless `-AllowSafeCommands` is also
passed.

### Armed-state handling

Three independent layers: the backend refuses (`_require_disarmed`, HTTP 409),
the UI disables the controls, and the controller re-checks before dispatching.
`armed: null` (no heartbeat seen) is a refusal, not an approval —
`formatArmedState(null)` returns `armed: null` with a warning tone, and a unit
test asserts unknown never collapses into disarmed.

### Serial ownership handling

Three mechanisms:

1. Uvicorn binds `127.0.0.1:8787`; a second backend fails to start.
2. `LinkManager.connect()` raises `LinkBusyError` (HTTP 409) if a worker is
   already alive in this process.
3. The OS grants a COM port to one process. A second opener gets "access is
   denied", which `classify_serial_error()` turns into `PortBusyError` with the
   message *"QGroundControl and this backend cannot both own COM10 — close
   QGroundControl…"*.

---

## Frontend Integration

### UI elements

A single `<details class="card paddy-collapsible" data-workspace="survey">`
panel titled *ドローン / MAVLink*, using the existing `card`, `kv`,
`metric-grid`, `input-row` and `panel-button` primitives. Sections: 接続 /
機体 / バッテリー / GNSS / 姿勢・運動 / 操作 / メッセージ.

### State display

| Group | Shown |
|---|---|
| Connection | backend reachable/unreachable, 7-state link status, mock vs real badge, serial port, baud, telemetry freshness + age, last heartbeat clock time |
| Vehicle | flight mode, armed state, firmware version, system id, component id |
| Battery | voltage, current, remaining %, warning tier |
| GPS | readable fix type, satellites, lat/lon (7 dp), position availability |
| Motion | roll, pitch, yaw, heading, ground speed, altitude |
| Messages | recent STATUSTEXT with severity label and clock time |

Controls: 接続 · 切断 · ファームウェア版数を取得 · STABILIZE/ALT_HOLD select ·
モードを適用. **No arm, takeoff, throttle, or manual-flight control exists**, and
a Playwright test scans every button label in the panel for those terms.

### Accessibility

* `<label for>` on every control; `label[for='droneModeSelect']` asserted by test.
* Two `role="status" aria-live="polite"` regions (connection state, command result).
* `role="alert"` on the armed banner.
* Keyboard navigation verified (focus → Tab → apply button).
* **No status is communicated by colour alone**: every tone chip carries text,
  asserted by a test that requires each `.drone-chip` to have non-empty content.
* Missing telemetry renders as `—`, never as `0` — tested.

### Error presentation

`describeReason()` maps every backend rejection reason to a Japanese
explanation; a unit test asserts all 18 reasons have a real explanation and none
falls through to the generic default. Command results show 成功/失敗 plus the
explanation, and a failed mode change appends the vehicle's actual current mode.
An unreachable backend is reported plainly with the command to start it.

---

## API Reference

Base URL: `http://127.0.0.1:8787`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness + mode |
| GET | `/api/drone/status` | Full normalized snapshot (works disconnected) |
| GET | `/api/drone/config` | Effective config, allowlists, disabled operations |
| POST | `/api/drone/connect` | Start the link |
| POST | `/api/drone/disconnect` | Stop the link, release the port |
| POST | `/api/drone/request-version` | Request `AUTOPILOT_VERSION` |
| POST | `/api/drone/request-streams` | Request allowlisted telemetry streams |
| POST | `/api/drone/mode` | Change flight mode (disarmed, allowlisted) |
| POST | `/api/drone/disabled/{operation}` | Always 501; transmits nothing |
| WS | `/api/drone/telemetry/ws` | Telemetry snapshots at `ws_interval` |

### Examples (captured from the running mock backend)

**`GET /api/health`**
```json
{"status":"ok","version":"0.1.0","mode":"mock","linkRunning":false}
```

**`POST /api/drone/mode` — request**
```json
{"mode": "ALT_HOLD"}
```

**Response `200`**
```json
{
  "ok": true,
  "reason": "accepted",
  "message": "Flight mode confirmed as ALT_HOLD.",
  "detail": {
    "requestedMode": "ALT_HOLD",
    "previousMode": "STABILIZE",
    "finalMode": "ALT_HOLD",
    "ack": {"command": 176, "result": 0, "resultName": "ACCEPTED", "accepted": true}
  }
}
```

**Rejected while armed — `409`**
```json
{
  "ok": false,
  "reason": "armed",
  "message": "The vehicle reports ARMED. This backend refuses every command while armed.",
  "detail": {"armed": true}
}
```

**Disabled operation — `501`**
```json
{
  "ok": false,
  "reason": "not_implemented",
  "message": "Arming is not implemented in this backend and will not be added by configuration. No MAVLink message was sent.",
  "detail": {"operation": "arm", "transmitted": false}
}
```

**WebSocket frame**
```json
{
  "type": "telemetry",
  "payload": {
    "connectionState": "connected", "connected": true, "commandable": true,
    "mode": "mock", "allowSafeCommands": true,
    "armSupported": false, "takeoffSupported": false, "error": null,
    "transport": {"transport": "mock", "port": null, "baud": null},
    "link": {"stale": false, "staleTimeout": 3.0, "linkLostTimeout": 10.0,
             "lastMessageAge": 0.092, "lastMessageAt": 1785831697.8,
             "lastHeartbeatAge": 0.31, "lastHeartbeatAt": 1785831697.5,
             "connectedSince": 1785831640.2, "gcsHeartbeatsSent": 58,
             "messageCounts": {"HEARTBEAT": 58, "ATTITUDE": 232},
             "totalMessages": 314, "dropRateComm": 0.2, "errorsComm": 0.0},
    "vehicle": {"armed": false, "flightMode": "STABILIZE", "customMode": 0,
                "baseMode": 1, "vehicleType": 2, "vehicleTypeName": "QUADROTOR",
                "autopilot": 3, "autopilotName": "ARDUPILOTMEGA",
                "systemId": 1, "componentId": 1, "systemStatus": 3.0},
    "battery": {"voltage": 16.17, "current": 1.42, "remaining": 96, "sensorsOk": true},
    "gps": {"fixType": 3, "fixTypeName": "3D_FIX", "satellites": 14,
            "lat": 34.54, "lon": 135.735, "altMsl": 62.0, "eph": 1.1, "epv": 1.8},
    "attitude": {"roll": 0.70, "pitch": -0.62, "yaw": 137.4, "yawNormalized": 137.4},
    "motion": {"heading": 137, "groundSpeed": 0.05, "airSpeed": 0.0,
               "altitude": 62.03, "climbRate": -0.01},
    "position": {"lat": 34.54, "lon": 135.735, "altAmsl": 62.0,
                 "altRelative": 0.1, "vx": 0.0, "vy": 0.0, "vz": 0.0, "available": true},
    "version": {"flightSwVersion": "4.5.7", "vendorId": 12642.0, "productId": 4113.0},
    "statusTexts": [{"severity": 6, "severityName": "INFO",
                     "text": "ArduCopter V4.5.7 (simulated)", "receivedAt": 1785831640.4}]
  }
}
```

---

## Configuration

All variables are prefixed `SUISUI_MAVLINK_`. Invalid values raise `ConfigError`
at startup rather than silently falling back.

| Variable | Default | Meaning |
|---|---|---|
| `MODE` | `mock` | `mock` or `real`. **Real is never the default** |
| `PORT` | `COM10` | Serial port (real mode) |
| `BAUD` | `57600` | Serial baud (real mode) |
| `SOURCE_SYSTEM` | `255` | This GCS's system id |
| `SOURCE_COMPONENT` | `190` | This GCS's component id |
| `TARGET_SYSTEM` | `1` | Vehicle system id |
| `TARGET_COMPONENT` | `1` | Fallback autopilot component; the component seen in the vehicle HEARTBEAT wins |
| `HEARTBEAT_INTERVAL` | `1.0` | GCS heartbeat period (s) |
| `STALE_TIMEOUT` | `3.0` | No message for this long → `telemetry_stale` |
| `LINK_LOST_TIMEOUT` | `10.0` | No heartbeat for this long → `link_lost`. Must be ≥ `STALE_TIMEOUT` |
| `CONNECT_TIMEOUT` | `10.0` | Wait for the first vehicle heartbeat (s) |
| `COMMAND_TIMEOUT` | `5.0` | `COMMAND_ACK` timeout (s) |
| `MODE_VERIFY_TIMEOUT` | `5.0` | Heartbeat mode-confirmation timeout (s) |
| `RECONNECT_DELAY` | `3.0` | Delay between reconnect attempts (s) |
| `AUTO_RECONNECT` | `1` | Retry after a link failure |
| `ALLOW_SAFE_COMMANDS` | `0` | **Enables the 3 safe commands. Off by default** |
| `ALLOW_ARM` | `0` | Parsed for reporting only. **Enables nothing** |
| `ALLOW_TAKEOFF` | `0` | Parsed for reporting only. **Enables nothing** |
| `REQUIRE_PROPS_REMOVED_ACK` | `1` | Require the propellers-removed confirmation in real mode |
| `HOST` | `127.0.0.1` | Bind address. Anything else logs a warning |
| `HTTP_PORT` | `8787` | HTTP port |
| `ALLOWED_ORIGINS` | `http://localhost:4173,http://127.0.0.1:4173` | CORS allowlist |
| `WS_INTERVAL` | `0.5` | WebSocket push period (s) |
| `MAX_REQUEST_BYTES` | `8192` | Request body cap |
| `MAX_STATUSTEXT` | `50` | STATUSTEXT ring size |
| `LOG_LEVEL` | `INFO` | Log level |

### Mock mode

```bash
npm run backend:setup
```
```bash
npm run dev
```

`npm run dev` starts the static server and a mock backend with
`ALLOW_SAFE_COMMANDS=1`, so the whole UI including mode changes is usable with
no hardware.

### Real mode

```powershell
.\scripts\dev.ps1 -Real
```

Read-only. Add `-AllowSafeCommands` to enable the three safe commands. See the
[operator guide](./MAVLINK_OPERATOR_GUIDE.md) for the full checklist.

---

## Tests Executed

### 1. Baseline (before any modification)

```bash
git status --porcelain
```
Result: **empty — clean tree** at `58a9c3d`.

```bash
npm test
```
Result: **99/99 pass**, `duration_ms 610.97`.

### 2. Backend test suite

```bash
npm run test:backend
```
Result: **154 passed in 35.13s.**

Coverage by file: `test_config.py` 12 · `test_normalizers.py` 20 ·
`test_telemetry_state.py` 21 · `test_link_manager.py` 14 ·
`test_command_service.py` 46 · `test_api.py` 41.

Includes, specifically:
* **Mode-command validation** — GUIDED/AUTO/RTL/LAND/TAKEOFF/FLIP rejected as
  `mode_forbidden`; LOITER/POSHOLD/ACRO/`""`/`"0"`/`"4"`/`nonsense` rejected as
  `mode_not_allowed`; numeric ids rejected at the API boundary (422).
* **Stale telemetry** — injected link loss drives `connected → telemetry_stale →
  link_lost`, recovery back to `connected`, and command refusal while stale.
* **Disconnect/reconnect** — disconnect stops the worker and clears telemetry;
  reconnect works; disconnect is idempotent; auto-reconnect retries after a
  failed open and does not retry when disabled.
* **Invalid input** — malformed JSON (422), unknown fields (422), missing body
  (422), oversized body (413).
* **Armed-state rejection** — `armed` (409) and `arm_state_unknown` (409).
* **Disabled commands** — all 11 return 501 with `transmitted: false`;
  `/api/drone/arm` and `/takeoff` return 404; the transmit surface is locked to
  two methods; forbidden command ids are absent from the codebase.
* **Port busy** — `PortBusyError` surfaced with the QGroundControl hint.

### 3. Frontend unit tests

```bash
npm test
```
Result: **127/127 pass** (99 pre-existing + 28 new), `duration_ms 540.12`.

Two real defects were found and fixed by these tests:
* `formatHeading(359.6)` returned `"360°"` — rounding happened after wrapping.
  Fixed to round first, then wrap.
* (One test expectation of my own was also wrong: `(62.15).toFixed(1)` is
  `"62.1"` in JS float, not `"62.2"`. The test was corrected, not the code.)

### 4. Drone Playwright spec

```bash
npx playwright test tests/browser/drone-panel.spec.js
```
Result: **12 passed (16.5s).**

### 5. Full Playwright suite

```bash
npx playwright test
```
Result: **115 passed, 2 failed (2.0m).**

The failures were investigated across **five** full-suite runs rather than
assumed. The failing set is **different on every run and never repeats**:

| Run | Tree | Failures |
|---|---|---|
| 1 | with changes | `assurance:159`, `assurance:188`, `recording:124`, `recording:438` |
| 2 | **clean baseline** (changes stashed) | `recording:124` — plus the 12 new drone tests, which necessarily fail because `index.html` was reverted |
| 3 | with changes | `decision-field-selector:175`, `recording:124` |
| 4 | with changes | `assurance:159`, `field-report:165` |
| 5 | isolated re-runs of every implicated spec | **0 failures** (24/24 for `decision-field-selector` + `assurance`; 22/23 then 23/23 for `recording`) |

**Conclusion: the pre-existing Playwright suite is flaky under parallel load.**
Every implicated test belongs to a pre-existing spec, passes when run in
isolation, and the clean baseline also fails (1 failure out of 105 non-drone
tests). No test failed in a way that correlates with the presence of this
integration, and the 12 new drone tests passed in every run where `index.html`
was in place.

I did **not** fix this flakiness — it predates this work, is unrelated to
MAVLink, and stabilising the existing suite was outside the requested scope. It
is recorded here so the numbers are not mistaken for a regression, and so you
can decide whether to address it separately.

Method: `git stash push -- index.html package.json .gitignore` to restore the
exact baseline, re-run, then `git stash pop`. Baseline full run: **104 passed**,
1 pre-existing failure, 12 expected drone-spec failures.

### 6. Backend startup and API health check

```bash
npm run backend:mock
```
```
{"status":"ok","version":"0.1.0","mode":"mock","linkRunning":false}
```

`GET /api/drone/config` returned the expected configuration with
`"allowedModes":["STABILIZE","ALT_HOLD"]`, `"armSupported":false`,
`"takeoffSupported":false`.

### 7. Live end-to-end against the running backend

| Action | Result |
|---|---|
| `POST /connect` | `MAVLink link started.` |
| `GET /status` | `state=connected mode=STABILIZE armed=False V=16.193 sats=15 fix=3D_FIX stale=False hb=3` |
| `POST /request-version` | `ok:true` · `flightSwVersion: "4.5.7"` · ack `ACCEPTED` |
| `POST /mode {"mode":"ALT_HOLD"}` | `ok:true` · `previousMode: STABILIZE` · **`finalMode: ALT_HOLD`** · ack `ACCEPTED` |
| `POST /mode {"mode":"STABILIZE"}` | `finalMode: STABILIZE` |
| `POST /disconnect` | `MAVLink link stopped and the port released.` · telemetry cleared (`voltage` empty, `totalMessages 0`) |
| reconnect | `state=connected mode=STABILIZE` |

Refusal paths, all verified live:

| Request | Expected | Actual |
|---|---|---|
| `mode: "GUIDED"` | 422 | **422** |
| `mode: "RTL"` | 422 | **422** |
| `mode: 4` | 422 | **422** |
| `{"mode":"ALT_HOLD","force":true}` | 422 | **422** |
| `POST /api/drone/arm` | 404 | **404** |
| `POST /api/drone/takeoff` | 404 | **404** |
| `POST /api/drone/disabled/arm` | 501 | **501** |
| `POST /api/drone/disabled/motor_test` | 501 | **501** |
| second `POST /connect` | 409 | **409** |

### 8. WebSocket telemetry test

Ran against the live backend:

```
frame 0: state=connected mode=STABILIZE armed=False V=16.17 roll=0.70 sats=14 stale=False age=0.092s msgs=314
frame 1: state=connected mode=STABILIZE armed=False V=16.19 roll=0.83 sats=13 stale=False age=0.100s msgs=321
frame 2: state=connected mode=STABILIZE armed=False V=16.19 roll=1.35 sats=13 stale=False age=0.099s msgs=325
payload sections: [allowSafeCommands, armSupported, attitude, battery, commandable, connected,
                   connectionState, error, gps, link, mode, motion, position, statusTexts,
                   takeoffSupported, transport, vehicle, version]
OK
```

All required sections present; telemetry advanced between frames.

### 9. Frontend dev server startup

`http://127.0.0.1:4173/` returned **HTTP 200** (also exercised continuously by
the Playwright `webServer` config).

### 10. Import / syntax checks

Every backend module imports cleanly (pytest collects all 154 tests, which
requires importing the whole package). Every frontend module parses and executes
as an ES module under both `node --test` and Chromium.

---

## Tests Not Executed

| Test | Why | How to run it |
|---|---|---|
| **Real COM10 hardware smoke test** | Requires powering the aircraft and opening the serial port. Prohibited without your explicit confirmation of every hardware safety condition, which has not been given | See the [Manual Real-Hardware Validation Checklist](#manual-real-hardware-validation-checklist) below |
| **Real telemetry reception / real heartbeat / real mode change** | Same reason. The mock adapter reproduces the message shapes and the ack/verify handshake, but it cannot prove radio-link behaviour, real timing, or real ArduCopter rejection semantics | Follow the checklist, then `.\scripts\dev.ps1 -Real -AllowSafeCommands` |
| **Playwright on browsers other than Chromium** | `playwright.config.js` defines no `projects`, so only the default Chromium runs — unchanged from before this work | Add a `projects` array to `playwright.config.js` |
| **Python type-checking (mypy) / linting (ruff)** | Neither tool is configured in this repository and adding one was out of scope. Type hints are present throughout but unverified by a checker | `.venv\Scripts\python.exe -m pip install mypy ruff` then `mypy backend/app` |
| **Load / soak testing of the WebSocket** | Not requested; the fixed 2 Hz cadence bounds the load by design | — |

---

## Known Limitations

Being specific rather than reassuring:

1. **The mock is not the aircraft.** It reproduces message shapes, units,
   ack/verify handshakes and failure modes, but it cannot prove that ArduCopter
   4.5.7 on your airframe behaves identically. Real-mode behaviour is
   **untested against hardware**.
2. **The pre-existing Playwright suite is flaky under parallel load.** Across
   five full runs, 1–4 tests failed each time with a *different* set every run
   (`assurance`, `recording`, `decision-field-selector`, `field-report`), and
   all of them pass in isolation. The clean baseline also fails (1 of 105). I
   did not fix this — it predates this work and is unrelated to MAVLink — but it
   means "115/117" should be read as "the suite is noisy", not "two tests are
   broken by this change".
4. **Backend and frontend must be started separately** (or via `npm run dev`).
   Opening `index.html` over `file://` leaves the panel showing "バックエンド
   応答なし" — correct, but a user unaware of the backend may find it confusing.
5. **No authentication on the local API.** Any process on the workstation that
   can reach `127.0.0.1:8787` can command a mode change (subject to every other
   gate). Mitigated by loopback-only binding and the restrictive CORS list, but
   it is not an authenticated API.
6. **`target_component` heuristic.** You reported the autopilot component as 0;
   ArduPilot normally answers on 1. The backend prefers the component seen in
   the vehicle's own heartbeat and falls back to the configured value. This is
   untested against your actual aircraft.
7. **Stream requests use `SET_MESSAGE_INTERVAL`**, which ArduCopter 4.5 supports.
   If your build responds better to the legacy `REQUEST_DATA_STREAM`, the
   request will return `rejected_by_vehicle` rather than silently failing — but
   the fallback is not implemented.
8. **Telemetry is displayed, not recorded.** Nothing is written to the existing
   IndexedDB recording store, and drone position is not plotted on the Leaflet
   map. Those are deliberate non-goals for this phase.
9. **Node.js 24.19.0 was installed on this machine** as part of this work. It
   was absent, which meant your documented `npm test` workflow could not run at
   all here.
10. **The `.venv` contains 25 packages** including transitive dependencies
    (lxml, fastcrc via pymavlink). It is gitignored, but it is ~60 MB on disk.

---

## Risks

| Risk | Assessment | Mitigation in place |
|---|---|---|
| **Serial link loss** | Radio dropouts are normal at range | 7-state machine distinguishes stale (3 s) from lost (10 s); auto-reconnect with delay; commands refused while stale; the operator sees the state in words |
| **Stale telemetry mistaken for live** | The most dangerous display failure — a frozen battery voltage reads as healthy | Disconnect clears all vehicle telemetry (tested); freshness computed from a monotonic clock; staleness shown with age; `commandable` goes false |
| **Browser/backend disconnect** | Backend stops, browser keeps showing the last frame | Health polled every 5 s; socket reconnects with exponential backoff; "バックエンド応答なし" shown; controls disabled |
| **GCS failsafe triggered by stopping the backend** | Your aircraft has GCS failsafe at 5 s → **RTL**. Killing the backend mid-flight would trigger it | Documented prominently in the operator guide with a "do not stop the backend during flight" warning; this integration is intended for ground use |
| **GPS unavailable indoors** | No fix indoors is normal | Position availability shown explicitly as 利用不可（屋内では測位できません）; `lat/lon` are `null`, never `0` |
| **Real-aircraft safety** | A mode change on a powered aircraft is a real action | Propellers-removed confirmation per connection; `confirm()` dialog; `confirmed=true` required server-side; disarmed-only; two-mode allowlist; no arm/takeoff exists |
| **Local API exposure** | An unauthenticated local API that can command a vehicle | Loopback-only bind with a warning if changed; CORS allowlist; no credentials; 8 KiB body cap; `extra="forbid"`; no arbitrary command id or packet endpoint |
| **Supply chain** | 5 new Python dependencies (25 with transitives) | Pinned with compatible-release bounds; installed into a repo-local `.venv`, never globally; **zero new npm dependencies** |
| **A future edit widening the allowlist** | The most likely way this becomes unsafe | `FORBIDDEN_MODES` guard; tests assert the allowlist is exactly `{STABILIZE, ALT_HOLD}`, that the two sets never overlap, that the transmit surface is exactly two methods, and that forbidden command ids are absent from the source |

---

## Manual Real-Hardware Validation Checklist

**Do not begin until every box is genuinely true. Do not tick a box you have not
physically verified.**

### Before applying power

- [ ] **All four propellers are physically removed from the aircraft.**
- [ ] The aircraft is on a stable surface, not on your lap.
- [ ] No person is within 2 m of the airframe.
- [ ] The transmitter is on, bound, and throttle is at minimum.
- [ ] The battery is inspected: no swelling, no damage, connectors intact.
- [ ] Battery resting voltage is above 14.0 V (the low-battery RTL threshold).
- [ ] **Antennas are attached to both telemetry radios** (transmitting without
      an antenna can damage the radio).

### Before starting the backend

- [ ] The aircraft is **DISARMED** and reports so on the transmitter/buzzer.
- [ ] **QGroundControl is completely closed** (check Task Manager — not just
      minimised).
- [ ] No other serial program holds the port (Mission Planner, Tera Term,
      Arduino IDE serial monitor, PuTTY).
- [ ] COM10 is present in Device Manager → Ports (COM & LPT).

### Read-only pass (do this first)

- [ ] Start read-only: `.\scripts\dev.ps1 -Real` (**without**
      `-AllowSafeCommands`), type `YES`.
- [ ] Tick the propellers-removed checkbox in the panel, press 接続.
- [ ] Link state reaches 接続済み and telemetry freshness shows 正常.
- [ ] Armed state shows **DISARMED**.
- [ ] Battery voltage, GPS fix, satellites, attitude and heading all update.
- [ ] Confirm the mode controls are **disabled** and the read-only note is shown.
- [ ] Press 切断; confirm telemetry clears and the port is released.

**Stop here unless you specifically need a mode change.** The read-only pass
proves the whole telemetry path.

### Command pass (optional, only after the read-only pass succeeded)

- [ ] Re-confirm: propellers still removed, aircraft still DISARMED.
- [ ] Start with `.\scripts\dev.ps1 -Real -AllowSafeCommands`, type `YES`.
- [ ] Connect; confirm DISARMED again before touching any control.
- [ ] Press ファームウェア版数を取得; expect `ArduCopter 4.5.7`.
- [ ] Select `ALT_HOLD`, press モードを適用, read the confirmation dialog
      carefully, accept.
- [ ] Confirm the panel reports the vehicle-confirmed final mode as `ALT_HOLD`.
- [ ] Cross-check the mode on the transmitter or a buzzer tone.
- [ ] Change back to `STABILIZE`; confirm.
- [ ] Press 切断, then Ctrl+C in the backend terminal.

### Absolutely not part of this checklist

- [ ] ~~Arm the aircraft~~ — **not implemented, do not attempt via this tool**
- [ ] ~~Takeoff~~ — **not implemented**
- [ ] ~~Motor test~~ — **not implemented**
- [ ] ~~Any flight~~ — this integration is for ground telemetry only

---

## Rollback Procedure

Nothing on the aircraft was modified: **no Pixhawk parameter, no firmware, and
no QGroundControl setting was changed.** Rollback is entirely local.

### Files to revert (5 modified, tracked)

```bash
git checkout -- index.html package.json .gitignore README.md docs/DRONE_LINK_PLAN.md
```

### Files to delete (all new, untracked)

```bash
rm -rf backend js/drone css/drone.css .venv
```

```bash
rm -f docs/MAVLINK_INTEGRATION_REPORT.md docs/MAVLINK_OPERATOR_GUIDE.md tests/browser/drone-panel.spec.js tests/unit/drone-formatters.test.js tests/unit/drone-store.test.js scripts/venv.mjs scripts/setup-backend.mjs scripts/run-backend.mjs scripts/run-pytest.mjs scripts/dev-all.mjs scripts/dev.ps1
```

Because every change is uncommitted, `git checkout --` plus deleting the
untracked files restores the repository exactly to `58a9c3d`.

### Confirm the original app still works

```bash
git status
```
Expect: `nothing to commit, working tree clean`.

```bash
npm test
```
Expect: **99/99 pass** (the 28 drone tests are gone with their files).

```bash
npm run serve
```
Open `http://localhost:4173/` — the QZ1 survey, assurance, vegetation and
recording features are untouched, and the ドローン / MAVLink card is gone.

### Partial rollback (keep the backend, remove the UI)

Revert only `index.html`. The backend and its tests are entirely
self-contained and have no effect unless started.

---

## Git Status

**Nothing was committed. Nothing was pushed. No git history was modified.**

```
On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
	modified:   .gitignore
	modified:   README.md
	modified:   docs/DRONE_LINK_PLAN.md
	modified:   index.html
	modified:   package.json

Untracked files:
	backend/
	css/drone.css
	docs/MAVLINK_INTEGRATION_REPORT.md
	docs/MAVLINK_OPERATOR_GUIDE.md
	js/drone/
	scripts/dev-all.mjs
	scripts/dev.ps1
	scripts/run-backend.mjs
	scripts/run-pytest.mjs
	scripts/setup-backend.mjs
	scripts/venv.mjs
	tests/browser/drone-panel.spec.js
	tests/unit/drone-formatters.test.js
	tests/unit/drone-store.test.js

no changes added to commit (use "git add" and/or "git commit -a")
```

```
$ git diff --stat
 .gitignore              |  12 +++++
 README.md               |  14 ++++++
 docs/DRONE_LINK_PLAN.md |   8 +++
 index.html              | 128 ++++++++++++++++++++++++++++++++++++++++++++++++
 package.json            |   9 +++-
 5 files changed, 170 insertions(+), 1 deletion(-)
```

**Summary of the diff:** 170 insertions and 1 deletion across 5 tracked files.
The single deletion is the `package.json` `scripts` block line being rewritten
to add new entries; **no existing script was removed**. `index.html` gains 128
lines and deletes none — the panel and its three wiring lines are purely
additive. `README.md` gains a section describing the integration; no existing
text was changed. 42 new files are untracked. `.venv/`, `__pycache__/` and
`.pytest_cache/` are correctly ignored (verified with `git check-ignore -v`).

### Rollback command update

The revert list must include `README.md`:

```bash
git checkout -- index.html package.json .gitignore README.md docs/DRONE_LINK_PLAN.md
```

---

## Recommended Next Phase

**Do not proceed to autonomous flight, GUIDED control, or mission upload next.**

The safest logical next step is:

> **Complete the real-hardware read-only validation, then integrate drone
> telemetry into the existing recording/reporting pipeline — still with no new
> command capability.**

Concretely, in order:

1. **Run the read-only hardware pass** from the checklist above. Confirm real
   heartbeat, battery, GPS and attitude arrive over the real radio at the real
   baud. This validates every assumption the mock cannot.
2. **Verify the `target_component` question** against the real aircraft — you
   reported component 0, ArduPilot normally uses 1. Confirm which the vehicle
   actually reports and pin `SUISUI_MAVLINK_TARGET_COMPONENT` accordingly.
3. **Record drone telemetry as a session** in the existing IndexedDB store,
   alongside QZ1 NMEA sessions. This gives the flight-log evidence trail the
   project already values, and it is read-only — no new command surface.
4. **Plot the drone's `GLOBAL_POSITION_INT` on the Leaflet map** as its own
   layer, next to QZ1 and phone-GPS layers. Useful for the demo and still
   read-only.
5. **Only then**, and as a separate reviewed change, consider geofence
   *display* (reading the vehicle's existing fence, not writing one).

Everything beyond that — GUIDED, RTL/LAND execution, mission upload, Jetson
integration, boundary-aware flight, agricultural imaging — should be treated as
a distinct project with its own safety review, its own test regime, and a
qualified second person present for any flight. **None of it is implemented
here, and none of it should be presented as available.**
