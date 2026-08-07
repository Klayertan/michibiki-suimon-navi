# UI / Architecture Redesign — Stage 0 Audit & Plan

Status: **Stage 0 (audit) complete.** No application code has been changed by this document. This is the reference plan for all later stages; update it as decisions are made or revised.

## 1. Motivation

SuisuiNavi has grown from a single-page hackathon demo into a real multi-subsystem application: GNSS survey + assurance scoring, field boundary/annotation management, water-management decisions, a field-recording pipeline with offline storage, a vegetation/pest/disease observation workflow, a read-only MAVLink drone telemetry bridge with its own FastAPI backend, a gamepad/keyboard input-preview pipeline, and a Windows desktop packaging (pywebview + PyInstaller). All of this is currently expressed as panels stacked inside one 6,120-line `index.html`. The interaction model — scroll through ~39 stacked cards to find the relevant control — no longer matches what the app does. The goal of this redesign is a map-first, workspace-based application shell (React + TypeScript + Vite) that keeps every one of these subsystems working, without rewriting the domain logic that already works and is already tested.

## 2. Current problems

- **One monolithic entry point.** `index.html` is 6,120 lines: ~1,260 lines of markup (39 stacked `.card` blocks in a single scrolling right-hand panel) plus a ~3,230-line inline `<script>` (lines 2888–6118) with 100+ top-level functions and 100+ top-level `let`/`const` globals, no module boundary, no namespacing except one wrapping `(async function init(){...})()` at the very end.
- **Only one level of navigation exists today**: a 4-tab `nav.workspace-nav` (`decision | survey | assurance | analysis`, `index.html:1638-1643`) that toggles `data-workspace="..."` visibility on the existing 44 sections. It does not cover drone, gamepad, or recording panels, which are simply always-rendered cards appended after the four tab groups (lines 2607–2879). There is no true routing, no per-workspace layout, and the map is a single shared instance all tabs draw into.
- **Inconsistent state ownership.** State lives in: (a) flat globals in the inline script (`fieldData`, `weatherData`, `activeWorkspace`, serial-connection variables, controller-instance holders — `index.html:3281-3359`), (b) per-controller instance state inside each `js/*-controller.js` class (no shared store, no pub/sub — callers must manually call `renderAll()`), and (c) `EventTarget`-based stores (`GnssStore`, `DroneStore`, `FieldRegistry`) that *do* emit `"change"` but are only consumed by their own controller, not shared across the app. There is no single source of truth for "active field," "selected map object," or "current GNSS position" — each subsystem tracks its own.
- **CSS is one file per feature with no shared design system** (`css/drone.css`, `field-annotation.css`, `field-report.css`, `gamepad.css`, `paddy-intelligence.css`, `recording.css`, `vegetation-intelligence.css` — 1,321 lines total), styled independently, which is why the app reads as a stack of unrelated widgets rather than one product.
- **`js/paddy-intelligence.js` (1,929 lines) is the one module never migrated** to the ES-module pattern used everywhere else — it's a classic global-scope IIFE (`window.PaddyFieldIntelligence`) with map drawing, zone/grid/drone-path logic, and demo data all in one class. It is the single largest decomposition task in the repository.
- **No shared design vocabulary for status.** GNSS, drone, camera(future), Jetson(future), and recording status are each rendered ad hoc inside their own card instead of one persistent status strip — exactly the gap Section 7 of the task asks to close.

## 3. Major features (confirmed present today)

| Feature | Where it lives | Status |
|---|---|---|
| NMEA upload / parsing / fix-quality classification | `js/gnss/nmea-parser.js`, `js/gnss/gnss-store.js` | Working, unit-tested |
| WebSerial live QZ1 recording | inline script (`index.html:5425-5920`) | Working, browser-tested |
| Field boundary / track / water-point / observation registry | `js/fields/field-annotation-core.js` + `-controller.js`, `js/fields/field-registry.js` | Working, unit + browser tested |
| Satellite Assurance (QZ1-vs-reference scoring, grid) | `js/assurance/*` | Working, unit-tested |
| Water/gate decision logic + Open-Meteo weather fetch | inline script + `data/gate_rules.json`, `data/weather.json` | Working |
| Field recording pipeline (IndexedDB sessions, raw NMEA, fixes, marked observations, photo blobs, wake lock) | `js/recording/*` | Working, browser-tested |
| Field report generation (HTML/Markdown, print/copy/export) | `js/reports/*` | Working, unit-tested |
| Vegetation/pest/disease observation + review workflow | `js/vegetation/*` | Working, unit-tested (AI detection itself is manual entry today, not model-driven) |
| Paddy Field Area Intelligence demo (zones, grid, drone flight-path planning, water-volume estimate, JSON export/import) | `js/paddy-intelligence.js` | Working, the "Analysis" tab's main content |
| Drone/Pixhawk telemetry (read-only) | `backend/app/mavlink/*` (FastAPI + pymavlink), `js/drone/*` | Working, extensively tested at both backend (pytest) and frontend (unit + Playwright) layers. Arm/takeoff/land/RTL/throttle/manual-control are structurally absent, not just disabled by flag. |
| Gamepad/keyboard input preview (drone-preview only, no vehicle control) | `js/gamepad/*` | Working, unit-tested; explicitly a preview/calibration tool, verified by a static safety-scan test (`gamepad-safety.test.js`) that no MAVLink command tokens appear in these files |
| Windows desktop packaging | `desktop/*`, `packaging/*` | Working — pywebview + WebView2 shell, FastAPI backend on a daemon thread (not subprocess), PyInstaller one-dir build |
| RealSense camera / weed-pest-disease ML inference / planting-density estimation | — | **Not implemented anywhere.** Vegetation observations today are manually entered, not detected. This is genuinely future work, matching the task's Stage 7 expectation. |

## 4. Existing reusable modules (migrate to `domain/` largely unmodified)

These already have zero DOM/browser-API coupling and (where noted) a passing Node-runnable unit test — they are the "move almost unmodified" set:

- `js/gnss/nmea-parser.js`, `js/gnss/gnss-store.js` (`GnssStore` wraps `EventTarget`; trivially portable to a hook/store)
- `js/assurance/assurance-engine.js`, `js/assurance/pairing.js`
- `js/fields/field-annotation-core.js`, `js/fields/field-registry.js` (`validateBoundary` is pure; the `FieldRegistry` class wraps `EventTarget`)
- `js/reports/field-report.js`
- `js/vegetation/vegetation-core.js`
- `js/recording/recording-core.js` (the `RecordingStore` IndexedDB wrapper is DOM-free but browser-API-bound — portable behind a repository interface, not a straight copy)
- `js/drone/drone-formatters.js`, `js/drone/drone-store.js`, `js/drone/drone-api-client.js` (already framework-agnostic; `drone-api-client.js` is close to being the `DroneService` implementation described in Section 18 of the brief as-is)
- `js/gamepad/gamepad-normalization.js`, `js/gamepad/gamepad-calibration.js`
- From `js/paddy-intelligence.js`: only `PaddyFieldIntelligenceUtils.polygonAreaSqm` / `formatAreaFull` are cleanly reusable today; everything else in that file is fused to Leaflet/DOM and will need decomposition, not a straight move.

Backend: `backend/app/mavlink/*` and `backend/app/main.py` need **no changes** for the frontend migration — the REST + WebSocket contract they expose is already a service boundary a TypeScript `DroneService` can wrap directly (see §9 of this doc and the backend audit below).

## 5. Problematic coupling

- `js/fields/field-annotation-controller.js` (1,929 lines): the heaviest single file — ~90 element IDs, direct Leaflet layer manipulation, `map.on("click")` placement-mode state machine, `document.addEventListener("keydown")`, and localStorage persistence all interleaved. It also receives closures from the inline script (`getParsedPoints`, `getSmartphonePosition`, `onEnterPlacementMode`) rather than reading from a shared store — meaning it cannot be lifted into React without first defining what replaces those closures (context values / props).
- `js/paddy-intelligence.js`: constructed directly by the inline script with a large options/callback object; owns its own Leaflet layers independently of the ones the inline script and other controllers create on the *same* map instance. Any redesign must reconcile "who owns which Leaflet layer group" before this can become one `<MapCanvas>` component with pluggable layers.
- `js/gamepad/gamepad-controller.js`: builds its entire panel via template-literal `innerHTML` — a full rewrite as React components, not an extraction.
- The inline script is the connective tissue for almost everything (map instance, `paddyLayers`, workspace switching, weather fetch, gate-decision evaluation) — no single file can be "cut out"; the map instance and layer-group ownership need to be re-homed into a `MapCanvas`/layer-registry component before any panel can be extracted cleanly.
- CORS/origin pinning on the backend (`backend/app/config.py: allowed_origins`, and the desktop launcher's per-launch pinned origin in `desktop/runtime.py`) is currently scoped to `http://localhost:4173` / `127.0.0.1:4173`. A Vite dev server on a different port will need `SUISUI_MAVLINK_ALLOWED_ORIGINS` updated for local dev; the desktop build must keep serving frontend and backend from the same origin since `backend/app/desktop_assets.py` mounts the built frontend itself.

## 6. State-management problems

No shared application state layer exists. Concretely missing (all called for in the task brief, §11):

- **Active field** — tracked ad hoc via inline-script globals and passed into controllers as closures; not shared.
- **Selected map object** — each controller (`field-annotation`, `vegetation`, `assurance`, `paddy-intelligence`) manages its own "selected feature" panel independently; no unified inspector.
- **Current GNSS position** — held inside `gnss-store.js` for the assurance flow, and separately in inline-script globals for the live-recording flow. Two sources of truth for what should be one signal.
- **Recording / connection state** — `RecordingSessionController` and the raw WebSerial globals in the inline script are separate state machines that happen to describe overlapping reality (is a QZ1 physically connected right now?).
- **Drone / camera / Jetson state** — `DroneStore` already does this correctly (EventTarget, single `getState()`, derived `canCommand` flag never computed client-side beyond what the backend reports) and should be the *template* other domains follow, not something to redesign from scratch.

Recommendation (to decide at Stage 1, not now): a light global layer (React Context or Zustand) for the small cross-cutting set above, with everything else (form state, per-panel UI state) local to its feature. No Redux — nothing here needs time-travel debugging or complex middleware, and the existing `EventTarget`-store pattern already used by `GnssStore`/`DroneStore`/`FieldRegistry` maps naturally onto a `useSyncExternalStore` hook, which is the lowest-friction bridge from current code to React.

## 7. CSS/UI problems

- 1,321 lines split across 7 feature-named stylesheets with no shared tokens (spacing scale, color palette, elevation, typography) — every panel invented its own card chrome.
- No responsive strategy: the layout is a fixed `.map-wrap` + `.panel` split; there's no collapse behavior for tablet, and mobile support today is a single bolted-on `.mobile-decision` banner (`index.html:1646-1652`), not a real responsive design.
- No design system component library (buttons, badges, form controls are each styled per-feature) — this is exactly the "generic SaaS card clutter" the task brief asks to move away from, except inverted: today it's clutter from *inconsistency*, not from over-designed cards.

## 8. Data persistence architecture

Static JSON (bundled, not user data): `data/field.json` (boundary/channel/gate geometry), `data/gate_rules.json` (decision thresholds, links via `fieldId`), `data/weather.json` (manual weather fallback).

Browser persistence (user data — **must not be silently discarded**):

| Storage | Key | Owner | Schema version |
|---|---|---|---|
| localStorage | `suimonNaviFieldAnnotationsV2` | `field-annotation-core.js` / `-controller.js` | `SCHEMA_VERSION = 3`, normalized defensively on load, no explicit migration between versions |
| localStorage | `suimonNaviFieldMode` | `recording-controller.js` | none (single boolean flag, low risk) |
| IndexedDB `suisuinavi-gamepad` v1 | store `calibrations` | `gamepad-storage.js` / `gamepad-calibration.js` | `CALIBRATION_SCHEMA_VERSION = 1`, unknown versions rejected (`migrateCalibration` returns `null`), no forward migration |
| IndexedDB `suimon-navi-recording` v1 | stores `sessions`, `rawNmeaLines`, `structuredFixes`, `markedObservations`, `imageBlobs` | `recording-store.js` | **No record-level schema version** — only a DB-level version used for object-store creation. Any shape change here needs new migration code from scratch. |

Export/import JSON (files users save to disk — also must not be silently broken): at least **four independent, inconsistent** schema-version conventions exist today — `paddy-intelligence.v1` (hard-rejects anything else), Satellite Assurance `"2.0.0"` (the *only* module that explicitly imports the legacy `paddy-intelligence.v1` format via `onImportLegacy`), Vegetation (`VEGETATION_SCHEMA_VERSION`, rejects only *newer* unknown versions), Recording (`schemaVersion: 1`). A redesign must either preserve all four loaders verbatim or deliberately design one converged export format with a migration path from each — this needs an explicit decision before Stage 5 (Data/Reports), not a silent choice.

## 9. Map architecture

Single `L.map("map", {...})` instance created in the inline script (`index.html:3144`), `setView([34.65, 135.83], 14)`. Layer groups: `pointLayer`, `phoneLayer`, `fieldLayer`, `liveLocationLayer`, plus a `paddyLayers` bundle (`boundary/water/plant/problem/irrigation/obstacle/drone/grid`, `index.html:3283-3297`). `L.markerClusterGroup` is used conditionally for point-heavy tracks (>400 points, per README). Additional Leaflet layers are created independently inside `satellite-assurance-controller.js`, `field-annotation-controller.js`, and `vegetation-controller.js` — i.e. **four separate places already draw onto the same map instance without a shared layer registry.** This maps well onto the task's requested layer model (§12) but the map instance and a layer-toggle registry need to be centralized into one `MapCanvas` component *before* the panel-by-panel migration, otherwise each migrated feature will fight over the same global `map` variable.

## 10. WebSerial/GNSS architecture

WebSerial itself (`navigator.serial.requestPort/getPorts`, connect/disconnect listeners) lives entirely in the inline script (`index.html:5425-5920`) — not yet extracted into a module, unlike almost everything else. `nmea-parser.js` (pure, tested) already cleanly separates "parse a line" from "own the port," so the extraction path is: wrap the existing WebSerial calls in a `services/serial/WebSerialGnssService.ts` implementing a `GnssService` interface, keep `nmea-parser.js`'s logic verbatim, and have `GnssStore` (already `EventTarget`-based) be the thing React subscribes to. This is a clean, low-risk boundary — no algorithm here needs to change, only its home.

## 11. Recommended migration boundaries

Migrate **feature by feature**, in the order the task brief already specifies (Field → Survey/GNSS → Water → Data/Reports → Drone → AI), because:
1. Field and Survey are the most self-contained (`field-registry.js`, `nmea-parser.js`, `gnss-store.js` have no cross-feature dependencies).
2. Drone is already the cleanest module in the repo (store/controller/view/formatters split, backend contract stable) — lowest-risk full slice to prove the new shell end-to-end.
3. `paddy-intelligence.js` and `field-annotation-controller.js` are the highest-effort, highest-risk migrations (map-layer ownership, largest files) — sequence them after the shell and at least one simple feature have round-tripped successfully, so lessons are already learned.
4. AI/RealSense has no existing implementation, so it is pure interface/placeholder design, not migration — can happen anytime after the shell exists.

## 12. Files that should initially remain untouched

All of `backend/`, `desktop/`, `packaging/`, and `data/*.json` — none of this needs to change for a frontend shell migration, and the desktop packaging in particular has carefully-reasoned safety properties (single-instance mutex, backend-as-thread not subprocess, `FORBIDDEN_CONFIG_KEYS`) that must not be touched incidentally. Also untouched initially: every `-core.js` / `-engine.js` / formatter file listed in §4 — these move by reference (import path change only) before any behavior migrates.

## 13. Files likely to be replaced (rewritten as components, not moved)

`index.html`'s inline `<script>` (2888–6118) and markup (1622–2884), `js/paddy-intelligence.js`, `js/fields/field-annotation-controller.js`, `js/vegetation/vegetation-controller.js`, `js/assurance/satellite-assurance-controller.js`, `js/recording/recording-controller.js`, `js/reports/field-report-controller.js`, `js/drone/drone-view.js` + `drone-controller.js` (thin — mostly becomes a hook), `js/gamepad/gamepad-controller.js`, and all 7 `css/*.css` files (superseded by a shared design system with feature-scoped overrides only where truly needed).

## 14. Risks

- **Data loss risk** is the top concern: four divergent export schema-version conventions and one IndexedDB store with no record-level versioning (§8). Mitigate by writing a compatibility test suite *first* (load every existing sample export + a live localStorage/IndexedDB snapshot) before any storage-touching code changes.
- **Map layer ownership collision**: four modules currently draw on one global `map` — migrating them independently without first centralizing layer registration risks silent rendering bugs (a migrated panel's layer never gets added, or gets added twice).
- **Desktop origin/CORS coupling**: introducing a Vite dev server changes the origin the frontend is served from; must update backend `allowed_origins` for local dev without weakening the desktop build's same-origin assumption.
- **Safety-critical drone code must not be “simplified” accidentally**: `command_service.py`'s mode-allowlist / disarmed-only / staleness-gated design and the frontend's `canCommand` derivation are safety properties, not incidental code — any TS `DroneService` port must be reviewed against `backend/tests/test_command_service.py` line-by-line, not just against the docs.
- **`gamepad-safety.test.js`** is a static source-scan for forbidden MAVLink tokens — if gamepad code moves into new file paths/names during migration, this test (or its equivalent) must be updated to still scan the right files, or a real regression could go undetected.
- **Scope creep**: the task list is large (14 domains, 9 migration stages); the biggest execution risk is attempting too much per stage rather than any single technical unknown.

## 15. Target architecture (recap, per task brief)

React + TypeScript + Vite, workspace-based navigation (Overview / Field / Survey / Water / Drone / AI Inspection / Data / Reports / Settings), persistent top status bar, map as permanent central workspace, right-hand contextual inspector instead of a scrolling panel, collapsible bottom telemetry tray. Domain logic (`domain/fields`, `domain/gnss`, `domain/observations`, `domain/water`, `domain/planting`, `domain/missions`) built from the existing `-core.js`/`-engine.js` files with type annotations added, not rewritten. Services layer (`services/serial`, `services/api`, `services/websocket`) wraps existing WebSerial code and the existing FastAPI backend contract behind `GnssService`/`DroneService`/`CameraService`/`FieldRepository` interfaces — the current browser implementations satisfy these interfaces today; a future FastAPI/WebSocket implementation (already partially built for the drone case) can satisfy the same interfaces later without UI changes.

## 16. Component / state / service architecture (Stage 1 target, for later stages to fill in)

To be elaborated in the Stage 1 implementation report once the shell is built. Placeholder shape:

- `app/` — `App.tsx`, `router.tsx` (workspace switch, likely a simple state-based switch rather than a full router initially — no deep-linking requirement has been stated), `providers/` (app-state context/Zustand store, theme).
- `components/layout/` — `AppShell`, `Sidebar`, `TopStatusBar`, `InspectorPanel`, `TelemetryTray`.
- `components/map/` — `MapCanvas` (owns the single Leaflet instance and a layer registry other features register into), layer toggle UI.
- `features/{overview,fields,survey,water,drone,ai,data,reports,settings}/` — one folder per workspace, each consuming `domain/*` and `services/*`, never reimplementing logic.
- `domain/` — ported `-core.js`/`-engine.js` files, typed.
- `services/` — `serial/WebSerialGnssService.ts`, `api/DroneApiService.ts` (wraps existing `drone-api-client.js` behind the `DroneService` interface), `storage/` (wraps localStorage/IndexedDB access behind repository interfaces so schema-version handling lives in one place per domain instead of scattered).
- `store/` — small shared-state layer for the cross-cutting signals identified in §6.

## 17. Data flow (target)

```
Browser (React+TS)  ──WebSerial──▶  QZ1 GNSS receiver
        │
        ├──HTTP + WebSocket──▶ FastAPI backend (already exists, unchanged)
        │                          │
        │                          ├──MAVLink──▶ Pixhawk (mock or real)
        │                          └── (no RealSense/AI wiring yet — future work)
        │
        └── localStorage / IndexedDB (fields, calibration, recording sessions)
```

High-frequency signals (GNSS position updates, drone telemetry at 2Hz, future camera frames) must update only the map layer / status bar / telemetry tray subscribed to them — not trigger a re-render of the whole app. The existing `EventTarget`-store pattern (`GnssStore`, `DroneStore`) already isolates this correctly at the data layer; the React binding (`useSyncExternalStore`) must preserve that isolation rather than lifting telemetry into a top-level context that re-renders everything.

## 18. Migration stages

Stages 0–8 as specified in the task brief (Audit → Shell → Field → Survey/GNSS → Water → Data/Reports → Drone → AI/RealSense → Cleanup). This document will be updated with a per-stage "what was preserved / what changed / files touched" log as each stage completes, per the working method in the brief (§20).

## 19. Testing strategy

- Preserve all 16 existing `tests/unit/*.test.js` (Node test runner) by keeping the ported `domain/*` modules behaviorally identical — these tests should be portable to the new module paths with import-path updates only, not rewrites, since none of them touch the DOM.
- Preserve all `tests/browser/*.spec.js` Playwright specs as the acceptance bar for each migrated feature — a feature is not "done" migrating until its existing spec(s) pass against the new UI (specs may need selector updates, not behavior changes).
- Preserve all `backend/tests/*.py` untouched — the backend does not change in this migration.
- Add: a compatibility test that loads real/representative localStorage and IndexedDB snapshots plus one sample of each export-JSON schema version (`paddy-intelligence.v1`, assurance `2.0.0`, vegetation, recording) and asserts they still load correctly through the new storage services (see Risk in §14).
- Add: unit tests for any `domain/` logic that gains TypeScript types but didn't have a test before (gap noted in the audit: `js/paddy-intelligence.js`'s extracted pure functions currently have none).

## 20. Jetson / backend roadmap

No new backend work is required to start the frontend migration. The existing FastAPI + MAVLink backend already models the target shape from the task brief (§18) closely enough that `services/api/DroneApiService.ts` can be a near-direct TypeScript port of `js/drone/drone-api-client.js` behind a `DroneService` interface. `GnssService` and `FieldRepository` interfaces are new (today's GNSS/field code is browser-only) but can be defined now and satisfied first by the existing WebSerial/localStorage implementations, then later by RealSense/Jetson-side FastAPI additions without changing calling code in `features/`. `CameraService` has no existing implementation to port from — it will need to be designed from scratch when RealSense integration begins (Stage 7), most likely mirroring the drone telemetry pattern (WebSocket snapshot push + REST for connect/config).

## 21. Unresolved decisions (need a decision before the relevant stage, not now)

1. **Export/import schema convergence** (§8): keep four independent versioned formats forever, or converge on one format with per-format import adapters? Affects Stage 5.
2. **Routing model**: plain state-based workspace switch (matches today's tab behavior, no URL deep-linking) vs. a real router (enables bookmarkable/shareable workspace URLs, e.g. for desktop window restore)? Affects Stage 1.
3. **Shared state library**: React Context vs. Zustand for the small cross-cutting state set in §6 — brief allows either; recommend Zustand once more than ~3-4 cross-cutting signals exist (avoids provider nesting), otherwise Context is sufficient. Decide at Stage 1 based on actual signal count once inventoried in code.
4. **IndexedDB recording-store migration**: introduce record-level schema versioning now (proactive) or only if/when a shape change is actually needed (reactive)? Affects Stage 3/5.
5. **Desktop dev-origin handling**: how the Vite dev server's origin gets allow-listed in the backend for local development without weakening the desktop build's same-origin posture — needs a decision before Stage 1's dev workflow is finalized.
