# UI / Architecture Redesign — Stage 0 Audit & Plan

Status: **Stages 0, 1, 2, 3A, 3B, 3C, 4A, and 4B are complete.** Stage 4A built the water *foundation* (control points read+create, level readings read-only); Stage 4B ported the existing gate open/hold/close recommendation (`evaluateGate()`) into a typed, tested domain function with a compact React panel, with no algorithm change and no coupling to Stage 4A's water data. The implementation report is [`docs/FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md), and [`docs/HANDOFF.md`](./HANDOFF.md) is the authoritative continuation checkpoint.

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

1. **Export/import schema convergence** (§8): keep four independent versioned formats forever, or converge on one format with per-format import adapters? Affects Stage 5. Still open.
2. ~~**Routing model**~~ — resolved in Stage 1: React Router, not a plain state switch. See §22.
3. ~~**Shared state library**~~ — resolved in Stage 1: Zustand, four small domain-oriented stores. See §22.
4. **IndexedDB recording-store migration**: introduce record-level schema versioning now (proactive) or only if/when a shape change is actually needed (reactive)? Affects Stage 3/5. Still open.
5. ~~**Desktop dev-origin handling**~~ — resolved in Stage 1: Vite dev-proxy, no backend origin change needed. See §22.
6. **New: production mounting of the new frontend** (raised during Stage 1, not resolved): when a later stage decides the new UI should be reachable from the desktop build, should it be mounted at a sub-path (e.g. `/new/`) alongside the legacy app, or eventually replace it as the desktop's `/`? Affects whichever stage first needs the new UI runnable outside `npm run dev:new-ui`. See `docs/FRONTEND_ARCHITECTURE.md`'s "Production integration" section for the additive approach assumed if/when this happens.
7. **Concurrent same-origin mounting**: the default `:4173` and `:5173` servers are different storage partitions. Stage 2 adds `npm run dev:new-ui:shared-storage` for a sequential React run on the legacy `localhost:4173` origin; a simultaneous `/new/` mount remains unresolved.
8. **Cross-store field deletion policy**: field IDs also survive in recording IndexedDB data, vegetation records, and Satellite Assurance copies. Deletion remains disabled until those references have an explicit cascade, unlink, or retention policy.

## 22. Stage 1 — what was actually built

Full detail lives in [`docs/FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md); this is the summary of decisions made while implementing it, for anyone reading this plan document in isolation.

- **Placement**: a new `frontend/` directory (React + TypeScript + Vite + React Router + Zustand), sibling to the existing root project, per §11's migration-boundary reasoning — the root project has no bundler today and shouldn't be made to host one just for this.
- **Legacy coexistence**: `index.html`, `css/`, `js/`, `data/`, the backend, and desktop packaging are all byte-for-byte unchanged. The new UI runs at `http://localhost:5173` (`npm run dev:new-ui`) alongside the legacy app at `http://localhost:4173` (`npm run dev`, unchanged) — both were run simultaneously against the same mock backend during Stage 1 verification with no conflicts.
- **Shell**: `AppShell` (top status bar, sidebar, one persistent `MapWorkspace`, contextual `InspectorPanel`, collapsible `TelemetryTray`) is mounted once by a pathless layout route; workspace routes only swap the inspector's content. Verified at 1366×768 and 1920×1080 with no document-level scroll (`document.documentElement.scrollHeight <= clientHeight`, checked live), and at 1024×768 for the tablet secondary target.
- **Map**: plain Leaflet (not react-leaflet — see `docs/FRONTEND_ARCHITECTURE.md`'s reasoning), one instance, same default view/tiles as the legacy map, completely separate Leaflet instance from the legacy app's. No real layers migrated yet; `useMapLayersStore` only scaffolds the toggle model.
- **Selection model**: implemented exactly as specified in the task (`SelectedEntity` discriminated union); `InspectorPanel` takes over the panel whenever a selection is present, from any workspace.
- **Status model**: `not_integrated`/`unknown`/`connected`/`disconnected`/`warning`, never a faked "connected." Only `backend` and `drone` are wired to anything real in Stage 1 (via the existing FastAPI backend); `gnss`/`serial`/`recording`/`camera` correctly show `not_integrated` until their own migration stage.
- **Drone integration**: `services/drone/droneService.ts` wraps the **existing, unmodified** `js/drone/drone-api-client.js` (imported via a new `@legacy` Vite/TS alias) behind a narrow, read-only `DroneService` interface — no flight command, no connect/disconnect UI. Verified against the real mock backend: `/api/health` and the telemetry WebSocket both worked end-to-end through the Vite dev proxy, and `DroneInspector` showed live telemetry (mode, commandable, arm/takeoff-supported flags) sourced entirely from the real backend response.
- **Dev proxy**: `vite.config.ts` proxies `/api/*` (HTTP and WebSocket) to `127.0.0.1:8787`; `createDroneService()` defaults to `window.location.origin`. **No backend CORS/origin configuration was changed** — this was the resolution to unresolved decision #5 above.
- **Tests**: 8 new Vitest files / 22 tests (stores, the selection model, the drone service adapter including a test that pins its surface to exactly the three read-only methods, `MapWorkspace` mounting/unmounting Leaflet cleanly, `AppShell` rendering, and workspace-routing behavior including a same-DOM-node assertion that the map is never remounted on navigation). All existing suites re-verified with zero regressions — see the Stage 1 report for exact counts.

## 23. Stage 3A — what was actually built

- **Read-only persistence boundary:** React reads `surveySessions` and `boundaryTracks` from the existing `suimonNaviFieldAnnotationsV2` schema-v3 store. It performs no survey writes and no schema migration.
- **Typed adapters:** raw legacy point properties and boundary-track records are validated into `domain/surveys` types. Malformed children are skipped with warnings; fatal storage/version problems are distinct error states.
- **Coordinate safety:** raw positions remain `{lat, lon}` and boundary tuples remain `[lat, lon]`. Tests pin exact order through persistence, domain joining, and the Leaflet view boundary. No GeoJSON order is inferred.
- **Survey workspace:** the placeholder is replaced by a compact survey/session selector, explicit empty/error/warning states, and a read-only scope note. Synchronous localStorage does not get an artificial loading spinner.
- **Persistent map layer:** `SurveyLayer` renders session tracks and orphan boundary tracks beside `FieldLayer` on the existing Leaflet map. Selector and path clicks drive shared survey selection; lifecycle tests pin non-recreation.
- **Real inspector:** point count, recorded time, HDOP and satellite ranges, source/measurement metadata, and linked-field information are shown when authoritative data exists.
- **Quality boundaries:** no React thresholds were invented. Raw GNSS values, annotation fix summaries, and QZ1/Satellite Assurance remain documented as separate systems.
- **NMEA reuse:** a typed ephemeral adapter calls `js/gnss/nmea-parser.js` directly. No second parser, import persistence, WebSerial, or legacy controller migration was added.
- **Verified layout:** 1366x768, 1920x1080, and 1024x768 retain the fixed shell with no document-level scrolling. Exact tests/counts and the full changed-file list are in `docs/HANDOFF.md`.

Stage 3B was subsequently completed as the bounded live connection/recording slice described below. Stage 2B field drawing remains independently deferred.

## 24. Stage 3B — what was actually built

Stage 3B replaces only the Survey workspace's live-GNSS placeholder controls. `SerialGnssService` owns WebSerial permission, open/read/stall/disconnect state and passes framed lines to the unchanged legacy NMEA parser. The top bar reports real serial and recording state. The Survey inspector provides compact connect/disconnect, baud, start/stop, current-fix, counter, and error/warning feedback.

`RecordingService` reuses the legacy recording state machine and exact IndexedDB adapter. It writes the existing session, raw-line, and structured-fix shapes to `suimon-navi-recording` v1 with one monotonic per-session sequence, batched flushes, and final flush before stop. No schema, backend, or legacy controller changed.

The persistent Leaflet map adds independent current-fix and live-track layers alongside Field and saved Survey layers. Their subscriptions update Leaflet objects imperatively, so high-frequency GNSS input does not drive application-shell renders and never recreates the map.

Stopped sessions are read back through a read-only IndexedDB adapter into the Stage 3A Survey model and become selectable after stop and reload. Coordinates remain named `lat`/`lon` in recording records and `[lat, lon]` in annotation boundary tuples; only the Leaflet boundary uses `[lat, lng]`.

The safety boundary is explicit: unsupported browser, permission rejection, malformed NMEA, open/read failure, stalled input, storage/quota failure, and an existing unfinished session are separately surfaced. React does not resume unfinished sessions, retry transient serial loss automatically, or acquire wake locks. Stage 3C subsequently added annotation observations, but did not modify this recording pipeline.

## 25. Stage 3C — what was actually built

- **Boundary source is explicit:** an existing `boundaryTrack` wins; otherwise valid saved session/recording fixes are used. Invalid finite checks are narrow, `[lat, lon]` is pinned, and duplicate vertices are not silently removed.
- **Preview before persistence:** the legacy closure and validation functions provide all geometry decisions. The hard floor is three points; gap/self-intersection warnings require explicit acknowledgment while retaining the legacy ability to force-close a walked path.
- **FieldRepository remains the writer:** Survey UI never writes field storage directly. `FieldRepository.create()` delegates to the legacy field builder, records source provenance, links existing annotation session/track `fieldId` values in the same write, and immediately drives active-field selection and FieldLayer.
- **Existing link semantics:** annotation sessions/tracks and recording sessions already have `fieldId`. IndexedDB recording links use the existing `RecordingStore.updateSession()` shape. Already-linked surveys show Open Existing or explicit Create Another; no silent duplicate/overwrite occurs.
- **Narrow observations:** Stage 3C creates only legacy `note`, `weed`, `insect`, and `disease` records with legacy severity, memo, timestamp, active `fieldId`, source, and `[lat, lon]`. A typed repository preserves the exact annotation v3 root/record shapes and fails closed on malformed storage.
- **Explicit placement:** current valid GNSS and armed one-shot map click both produce a preview. Normal clicks do nothing, Escape/Cancel disarm, and outside-field candidates require the visible Save Anyway action using the existing point-in-field helper.
- **Persistent map/inspector:** `ObservationLayer` is independent of Field/Survey/live layers and uses the shared selected-entity model. The inspector displays only stored facts; no AI confidence/species/media is fabricated.
- **Verified compatibility/layout:** representative legacy observations render in React, React-created field/observation bytes match the schema the legacy controller consumes, legacy observation browser tests remain green, and all three required viewports have no document scroll.
- **Deferred:** observation editing/deletion/photos, Water, Stage 2B drawing, automatic reconnect, unfinished-session recovery, wake locks, and all later intelligence/AI/mission work.

## 26. Stage 4A — what was actually built

Full detail lives in [`docs/FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md)'s "Stage 4A — water foundation" section.

- **The audit's headline finding: water is two unrelated persisted things.** Water *control points* (locations: 水門/給水口/排水口/水位センサ/撮影地点) live in the localStorage annotation store; water *level readings* live in the IndexedDB recording store as `markedObservations` with `observationType === "water_level"`. Different builders, different coordinate conventions (`[lat, lon]` tuple vs named `latitude`/`longitude`), different field-link property names (`relatedFieldId` vs `fieldId`), different ownership (standalone vs child of a recording session). Nothing links them. A 水位センサ point is a pin, not a reading. They stay two entity types.
- **This resolves §21's implicit question about "water measurements".** They exist, but not where the water UI lives, and not in a form that can be created safely from the Water workspace.
- **Control points: read + create.** Create supports the two positions legacy supports — current QZ1 fix and one explicit map click. No phone-GPS path, because legacy has none for water. Records are built by the unchanged legacy builder and are byte-identical to what the legacy controller writes.
- **Readings: read-only.** Creation is deferred, not forgotten: a reading is a session child, legacy only builds one from a validated non-stale fix, and the schema records no unit.
- **No outside-field gate for water.** `isPointInsideBoundary` is called exactly once in the legacy controller, for observations only. Stage 4A shows a non-blocking note instead of inventing a Save-Anyway step.
- **No update or delete in water**, matching the Stage 2/3C precedent while reports and the decision panel still read the same array.
- **Two legacy quirks pinned by tests:** `updatedAt` does not survive a reload (rehydration resets it), and a stored `waterLevel` of `0` usually means "left blank" rather than a measured zero.
- **Deferred:** the Stage 4B decision engine, water-point editing/deletion, reading creation, Stage 2B drawing, Paddy Intelligence, reports, AI/camera, drone missions.

## 27. Stage 4B — what was actually built

Full detail lives in [`docs/FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md)'s "Stage 4B — gate decision" section and [`docs/HANDOFF.md`](./HANDOFF.md) §2.

- **`evaluateGate()` had no export boundary to import through** — it lives inline in `index.html`'s monolithic `<script>`, unlike every other domain wrapper so far in this migration. Stage 4B hand-transcribes it verbatim into `frontend/src/domain/water/decision.ts` and pins the transcription with tests reproducing the legacy source's exact branches, `>=` comparisons, and Japanese strings, since no legacy test of this function existed to cross-check against.
- **Algorithm unchanged.** Same two inputs (weather values, four `data/gate_rules.json` thresholds), same fixed priority order (heavy rain → light rain → forecast → dry spell → generic hold), same inclusive `>=` at every boundary, same exact output strings. Every threshold has a dedicated `threshold − ε / threshold / threshold + ε` test.
- **Both audited traps confirmed and preserved, not just avoided:** the 判断プロファイル selector is display-only at two independent legacy call sites and was not reproduced (`evaluateGate.length === 2` is pinned so a future accidental profile parameter is caught); `data/field.json`'s `gate` and the paddy-intelligence `targetWaterDepthInput` remain untouched and unreferenced.
- **Stage 4A's water data provably does not influence the decision.** A test renders the panel with 0 and with 3 contextual water-level readings and asserts an identical verdict; the UI labels any shown reading count "Context only — not used by this recommendation." No water control point is referenced by the decision panel at all.
- **No new persistence, no new store, no new selected-entity type, no map interaction.** Weather inputs are local component state, exactly as ephemeral as legacy's DOM values; thresholds are read-only, sourced from a build-time `data/gate_rules.json` import via a new `@data` alias (mirroring the existing `@legacy` alias). This is the smallest-footprint stage of the migration so far.
- **Threshold overrides and the Open-Meteo live-fetch pipeline were deliberately not reproduced** — both are legacy features layered on top of the core recommendation, not part of it, and reproducing the fetch would require a position-resolution concept (`surveyedGate`) React has no equivalent of. Documented as deferred, not lost.
- **No gate actuation of any kind was added or considered** — the panel is informational only, with no MAVLink/actuator/backend call anywhere in the change.
- **Deferred:** editable threshold overrides, live weather auto-fetch, the legacy decision tab's independent field-selector/proof-card subsystem, water-level reading creation, Stage 2B, Paddy Intelligence, Reports, AI/camera, drone missions.

## 28. Stage 5A — what was actually built

Full detail lives in [`docs/FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md)'s "Stage 5A — recording crash recovery" section and [`docs/HANDOFF.md`](./HANDOFF.md) §3.

- **This closes the gap Stage 3B explicitly left open.** Stage 3B blocked a new recording when an unfinished session existed but gave the operator no way to resolve it. Stage 5A adds the three explicit choices — **Resume**, **Finish & Save**, **Discard** — with no automatic resume, no silent discard, and no hidden condition.
- **"Unfinished" was derived, not invented.** It is exactly what `RecordingStore.listUnfinishedSessions()` already returns: `status === "recording" || status === "paused"`. No heartbeat, no crash flag, no timestamp heuristic. Because the unmodified query is used, a legacy-created *paused* session is detected too, even though React never writes that status.
- **No IndexedDB schema change.** `suimon-navi-recording` v1 — same name, version, five stores, keyPaths, indexes, field names. Verified by seeding a legacy-shaped session and proving React detects and finalizes it, then confirming all 14 legacy recording browser tests still pass against the same database.
- **No second recording state machine.** `recovery_available` was already defined in `js/recording/recording-core.js`'s `RECORDING_STATES` with `{resume, finish, delete}` transitions; React now uses that same vocabulary on the existing Stage 3B `RecordingService` singleton. The `idle ⇄ recovery_available` transition is symmetric in both directions, and `recording` + `recoveryRequired` can never both be true.
- **Sequence integrity is the core correctness property.** Resume continues the shared per-session `seq` from `getMaxSeq()` across both `rawNmeaLines` and `structuredFixes` and never resets to zero, so pre-crash and post-resume records coexist exactly once with no collisions. Proven at both the unit level and end-to-end against real IndexedDB.
- **Resume and GNSS stay separate concerns.** Resuming opens no port, triggers no WebSerial permission prompt, starts no reconnect, and takes no wake lock — matching the separation legacy already documents.
- **Discard shipped because cascade safety was proven, not assumed.** Unlike Stage 2's deferred field deletion, `RecordingStore.deleteSession()` was read in source and confirmed to cascade across all five stores via `by_sessionId`, so nothing can be orphaned. The UI requires a two-step inline confirmation.
- **Corrupt candidates fail safely without mutation.** A candidate is dropped only when `sessionId` is unusable; malformed timestamps, counts, and fixes degrade to safe defaults. Dropped candidates are counted and reported rather than silently hidden. A field link pointing at a deleted field shows `Linked field no longer exists (<fieldId>)`, preserving the original identifier.
- **A real bug was caught by the real-IndexedDB test, not by unit tests.** Finalizing the only unfinished session left the app permanently unable to start a new recording, because the `recovery_available → idle` transition was missing and the finalize path's own state patch only fires for the *active* session. Fixed and pinned by both a Playwright case and a unit test.
- **Compatibility is claimed only where tested:** legacy-created session → detected/resumable/finalizable by React (tested); React-finalized session → still readable by legacy readers with the legacy suite green (tested). No broader bidirectional claim is made.
- **Deferred / explicitly not started:** Stage 5B automatic transient WebSerial reconnect (scoped in `docs/HANDOFF.md` §3.16 at the time, since implemented — see §29 below), retry loops, wake locks, Visibility API work, Reports, Paddy Intelligence, observation photos, water-level creation, Stage 2B, gate actuation, pilot/MAVLink/backend changes, schema convergence, bundle optimization.

## 29. Stage 5B — what was actually built

Full detail lives in [`docs/FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md)'s "Stage 5B — GNSS reconnect reliability" section and [`docs/HANDOFF.md`](./HANDOFF.md) §2.

- **Closes the reliability gap Stage 5A's own recommendation flagged.** A transient WebSerial interruption (cable wiggle, read-loop rejection, a stalled receiver) previously required a full manual reconnect with no automatic recovery at all — Stage 3B's `'stalled'` connection state was declared but never wired to anything.
- **Four disconnect classes, audited and handled differently on purpose.** Physical disconnect and read-loop failure both trigger a bounded automatic reconnect; malformed NMEA (already a parser-level concern) and a stalled-but-otherwise-healthy port do not — reopening a fine port cannot make a receiver produce fixes it doesn't have.
- **One authoritative state, no parallel booleans.** `GnssConnectionState` gained `reconnecting` and `reconnect_required`; no `isReconnecting`/`connectionLost` flags were added anywhere that could contradict it.
- **Bounded, capped-exponential retry against one specific port only.** `[1000, 2000, 4000, 8000]`ms, four attempts, ~15s worst case before giving up — and the automatic path never calls `getPorts()`/`requestPort()` itself, so it can neither prompt for permission nor pick a different granted device when more than one exists. A manual "Reconnect now"/"Reconnect GNSS" action always remains available and always wins any race against a pending automatic attempt.
- **Recording continuity was mostly already guaranteed by the existing architecture** — `ingest()` only fires while a read loop is delivering lines, so a disconnect cannot fabricate, duplicate, or reset a sequence number by construction. Stage 5B's job here was proving it (a unit-level service integration test plus three Playwright cases covering single-cycle, repeated-cycle, and Resume-then-reconnect scenarios) and fixing the one place that needed a real change: interruption messaging, which previously said "GNSS disconnected" for every non-connected state and now distinguishes reconnecting/reconnect_required/stalled/disconnected.
- **A real, pre-existing gap was found and closed in Stage 3C/4A code.** `ObservationComposer` and `WaterControlComposer`'s "Use Current GNSS" buttons checked only `!currentFix`, never staleness — meaning a `'stalled'` link's deliberately-preserved-but-aging fix could have been used to record a "current" position that was actually minutes old. Both now call the exact legacy staleness gate (`validateObservationCreation()`, `js/recording/recording-core.js`) instead of a re-derived rule.
- **No IndexedDB schema change, no automatic session resume, no automatic permission prompt.** Recovery (Stage 5A) and reconnect (Stage 5B) remain deliberately separate concerns — resuming an unfinished session still never touches the serial transport, and a legacy-inherited unfinished session still cannot receive live data before the operator explicitly clicks Resume.
- **Deferred / explicitly not started:** Stage 5C Wake Lock / display-sleep prevention (scoped as a recommendation in `docs/HANDOFF.md` §2.16, deliberately not implemented), Reports, Data workspace redesign, Paddy Intelligence, AI, RealSense, pilot/manual flight, MAVLink, field boundary editing, observation photos, water-level recording creation, schema convergence.

## 30. Historical Stage 2 — what was actually built

Full detail lives in [`docs/FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md)'s "Stage 2 — Field management" section. Summary for anyone reading this plan document in isolation.

- **Target identified correctly**: two different "field" concepts existed pre-Stage-2 (§4/§9) — `FieldRegistry` (in-memory, Satellite-Assurance-only) and `field-annotation-core.js`'s persisted records (`localStorage["suimonNaviFieldAnnotationsV2"]`, what the legacy field selector/registered-fields panel/decision workspace actually use). Stage 2 correctly targeted the second, the one holding real user data; `FieldRegistry`'s `validateBoundary` is reused, its class is untouched.
- **`FieldRepository`**: `list`/`get`/`create`/`update`, implemented against the v3 annotation localStorage contract using the existing core's `buildField`/normalization/constants and `gnss-store.js`'s `makeId`. Writes preserve the legacy controller's exact seven root keys. Malformed or non-v3 bytes are never overwritten by a mutation. `delete` is deliberately absent because the legacy annotation cascade is not globally complete.
- **Area parity**: `frontend/index.html` now loads the same Turf.js build the legacy app does, so `polygonAreaSquareMeters()` takes its Turf branch in both apps. Confirmed live in the browser, not just in unit tests.
- **Compatibility is explicit**: a literal representative legacy-v3 field fixture is read unchanged through `list()` and `get()`, preserves exact `[lat, lon]` order, and performs no write. The area wrapper is compared directly with the authoritative legacy function. The default development ports have separate partitions; `dev:new-ui:shared-storage` supplies a sequential check against the real legacy origin, while concurrent mounting remains future work.
- **Smallest safe UI slice**: existing fields load into a compact selector, render as a dedicated Leaflet layer, select consistently from selector or polygon, and drive a real field inspector. Name/memo edits are supported. Empty and persistence-error states are distinct. New Field, Edit Boundary, and Delete remain visible but disabled.
- **Deferred, not overlooked**: map creation/boundary editing (Stage 2B), cross-store-safe deletion, field-id rename with FK cascade, and "save as boundary track" (Stage 3). No `paddy-intelligence.js` or `field-annotation-controller.js` migration occurred.
- **Tests and viewport checks**: the Stage 2 suite covers representative legacy reads, fail-closed writes, authoritative area parity, active state/reconciliation, selector and polygon selection, inspector updates, layer/map lifecycle, and safety-disabled actions. Live checks at 1366×768, 1920×1080, and 1024×768 found no document-level scrolling. Exact final commands/results are recorded in `docs/HANDOFF.md`.
