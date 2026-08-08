# SuisuiNavi — Claude Handoff

**Updated:** 2026-08-08
**Working branch:** `feature/mavlink-integration`
**Purpose:** concise project context and safe next steps for the next developer.

## What SuisuiNavi is

SuisuiNavi is a map-first precision-agriculture application for rice paddies. It combines QZSS/Michibiki GNSS survey and assurance data, field boundaries and annotations, irrigation/water decisions, offline field recording, vegetation observations, reporting, and a desktop-ready drone-telemetry integration.

The active repository is `Klayertan/michibiki-suimon-navi`. The current application is still a static HTML/JavaScript interface, with a Python FastAPI backend for the MAVLink slice and a Windows desktop build.

## Completed work

### 1. MAVLink drone telemetry integration

- Implemented a FastAPI + `pymavlink` backend under `backend/app/mavlink/`.
- The frontend uses REST and WebSocket telemetry through `js/drone/`.
- The implementation is intentionally conservative: telemetry is the primary capability.
- Existing command capability is strictly limited to confirmed, disarmed `STABILIZE` / `ALT_HOLD` mode changes when the backend is explicitly started with safe commands enabled. There is **no** arm, takeoff, land, RTL, mission upload, RC override, or manual flight-control implementation.
- The backend requests essential telemetry streams on connection, but real-aircraft validation is still required. Do not open the real serial link or power the aircraft merely to develop UI.
- Known issue to retain: the no-heartbeat timeout in `LinkManager._session()` was previously noted as using a loop-local time value, so a never-heartbeating vehicle may remain in `connecting` longer than intended. Confirm and fix it in a separately tested change.

Relevant documents: `docs/MAVLINK_INTEGRATION_REPORT.md`, `docs/MAVLINK_OPERATOR_GUIDE.md`, and `docs/DRONE_LINK_PLAN.md`.

### 2. Safe pilot-input preview

- Added a browser gamepad / keyboard preview system under `js/gamepad/`.
- It supports calibration, normalization, dead zones, an explicit dead-man gate, mock input (`?gamepadMock=1`), and a keyboard preview source.
- The `js/gamepad/` modules remain **input sources only**. They deliberately contain no network transport or MAVLink command path; automated safety tests scan for prohibited command tokens and for `fetch(` / `WebSocket(`.
- Real DualSense behavior inside WebView2 has not been tested. Do not claim physical-controller support as verified.
- The control phase described here as future work has since been implemented as a *separate* layer — see §6. The preview modules were not turned into a flight-control channel; they are read by a distinct one.

Relevant documents: `docs/GAMEPAD_PHASE1_REPORT.md` and `docs/GAMEPAD_OPERATOR_GUIDE.md`.

### 3. Windows desktop application

- Added a Windows desktop shell using pywebview/WebView2, FastAPI, and a PyInstaller one-directory build.
- The packaged application defaults to **Preview** mode. It starts the backend, serves the frontend, and includes safe single-instance handling using a named mutex rather than a PID-file liveness check.
- Packaged lifecycle, clean shutdown, and second-instance rejection were tested. Build output is intentionally ignored by Git; distribute the whole `dist/SuisuiNavi/` folder or a portable ZIP, not the `.exe` alone.

Relevant documents: `docs/DESKTOP_APPLICATION_ARCHITECTURE.md`, `docs/DESKTOP_BUILD_GUIDE.md`, `docs/DESKTOP_OPERATOR_GUIDE.md`, and `docs/DESKTOP_RELEASE_CHECKLIST.md`.

### 4. UI migration preparation (Stage 0 complete)

- A thorough architecture audit is complete in `docs/UI_REDESIGN.md`.
- The app has reusable framework-independent domain logic, but the current presentation layer is highly coupled: a large `index.html`, inline globals, DOM-heavy controllers, and several modules independently manipulating the same Leaflet map.
- The approved direction is a staged migration to **React + TypeScript + Vite**, using React Router and small Zustand stores only for cross-cutting state.
- Do **not** perform a broad rewrite. Migrate the presentation/orchestration layer gradually while preserving tested domain logic and existing persistence/export contracts.
- Start with a coexistence shell rather than replacing `index.html`: persistent map host, top status bar, sidebar/workspaces, contextual inspector, and collapsible bottom tray. Keep the legacy app available throughout the migration.
- Keep Leaflet for the first stage. Use a Vite proxy for `/api/*` and `/ws/*` during development; retain FastAPI/pywebview serving in production.

### 5. Product and hardware decisions

- **QGroundControl is not embedded in the web UI.** It remains responsible for aircraft setup, calibration, firmware, parameters, failsafes, and emergency/manual operations. SuisuiNavi integrates at the MAVLink data layer and focuses on field-aware visualization, agricultural workflows, and later guarded mission planning.
- A water-allocation planner is desired. It should calculate per-field water demand from area, target depth, losses, current water, rainfall, and growth stage, then allocate constrained supply using priority weights—not a simple equal split. Important conversion: 1 mm over 1 m² equals 1 litre.
- An Intel RealSense depth camera is planned for the drone, primarily as a downward agricultural sensor. It can support RGB-based weed/plant/disease observation and depth-based canopy/terrain estimates. It is **not** a reliable standalone sensor for precise paddy-water height because reflective/textureless water produces unreliable stereo depth. A dedicated reference/sensor remains necessary for water level.
- Camera model naming should be verified from the hardware label before writing integration code. Use M3 mounting hardware only after confirming the exact RealSense model and bracket design; do not assume an unverified model specification.

### 6. Low-speed pilot velocity control (opt-in)

Added at the operator's explicit request, as a deliberately separate layer rather than an extension of the preview code.

- Off unless the backend is started with `SUISUI_MAVLINK_ALLOW_PILOT_CONTROL=1`. A default install cannot move an aircraft.
- Browser side: `js/pilot/` (axes, HTTP client, send/stop controller, panel). It knows no MAVLink message, frame, or speed — it posts four numbers in `-1..+1` plus a neutral flag.
- Backend side: `backend/app/mavlink/pilot_service.py` holds the latest desired state and applies every gate; `pilot_limits.py` is the **only** place speeds and MAVLink constants for this feature are written.
- Transmits `SET_POSITION_TARGET_LOCAL_NED` in `MAV_FRAME_BODY_NED` with velocity + yaw rate only, so ArduPilot's stabilization is always in the loop. No motor PWM, no `MAV_CMD_DO_SET_SERVO`, no RC override.
- **Still does not arm, take off, land, RTL, or change flight mode.** It refuses to transmit unless the operator has independently armed the vehicle and selected GUIDED, and it says which gate is closed.
- Limits: 0.30 m/s horizontal (total, diagonals normalized), 0.30 m/s climb, 0.20 m/s descent, 12 °/s yaw. 15 Hz setpoints, 0.5 s input timeout, explicit neutral on key release / Space / focus loss / tab hidden / link loss.
- **Not validated against SITL or real hardware.** Implementation, 273 backend tests, 194 JS unit tests and 26 browser tests pass, but no aircraft has flown on it. The propellers-removed bench procedure in `docs/PILOT_CONTROL_GUIDE.md` §7 is the first real check and has not been executed.

Relevant document: `docs/PILOT_CONTROL_GUIDE.md`.

## Safety and compatibility constraints

1. Never broaden drone control casually. Keep no-arm/no-takeoff/no-RTL/no-mission-upload boundaries unless a separately reviewed safety project authorizes them. The velocity slice in §6 is the one authorized exception and is scoped to that: it moves an already-armed, already-GUIDED aircraft slowly, and nothing else.
2. Do not test new drone behavior on a powered aircraft. Use mocks or SITL first; physical validation requires the documented propellers-removed procedure.
3. Treat JSON exports, localStorage, and IndexedDB data as compatibility contracts. There are multiple existing schema conventions and an unversioned recording-store record format. Do not silently redesign or converge them during Stage 1.
4. Preserve the desktop single-instance and shutdown safety properties. Do not reintroduce PID-based `os.kill(pid, 0)` liveness logic on Windows.
5. Do not make gamepad or keyboard input modules (`js/gamepad/`) capable of sending aircraft commands. They stay transport-free; anything that transmits belongs in `js/pilot/` behind the backend's gates.
6. Do not raise the pilot velocity limits, shorten the input timeout, or remove a gate without a bench re-test. All of them live in `backend/app/mavlink/pilot_limits.py` and `pilot_service.py`; do not reintroduce speeds anywhere else.

## Recommended next work

1. Commit the currently untracked `docs/UI_REDESIGN.md` together with this handoff document.
2. Implement UI migration Stage 1 only: React/TypeScript/Vite shell running alongside the legacy UI, with routing, a persistent Leaflet host, status bar, inspector, bottom tray, and real read-only backend status.
3. Add tests for routing, shell rendering, selected-entity state, and service adapters; preserve existing test suites.
4. Before any MAVLink feature expansion, complete the read-only real-hardware validation checklist and separately fix/test the no-heartbeat timeout if confirmed.
5. Prototype agricultural imaging independently of vehicle control: camera stream verification, image capture, and georeferenced observation records before AI inference or autonomous behavior.

## Current repository state

- Latest commit: `20e3bd7 feat: add Windows desktop app and pilot input preview`.
- The active branch is `feature/mavlink-integration` tracking `origin/feature/mavlink-integration`.
- At the time of this handoff, `docs/UI_REDESIGN.md` was untracked; preserve and commit it rather than discarding it.
