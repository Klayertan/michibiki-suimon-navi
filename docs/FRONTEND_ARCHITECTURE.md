# Frontend Architecture — `frontend/` (through Stage 3C)

This documents the new React/TypeScript/Vite frontend, living at `frontend/` beside the existing static app (`index.html`, `css/`, `js/`, `data/` at the repository root). Stage 1 established the shell, Stage 2 added Field management, Stage 3A added read-only saved surveys, Stage 3B added live WebSerial/recording, and Stage 3C bridges saved surveys into fields and field-aware observations. See [`docs/UI_REDESIGN.md`](./UI_REDESIGN.md) for the Stage 0 audit and migration plan.

## Stage 3C — survey registration and observations

### Survey boundary adapter

`domain/surveys/surveyBoundary.ts` selects the authoritative source rather than using the display path blindly. An explicit annotation `boundaryTrack.coordinates` wins because it is already classified as a boundary. Without one, valid (`fixValid !== false`) session/recording fixes are used. Non-finite points are dropped; duplicate vertices are preserved in order. Both sources remain `[lat, lon]`.

The adapter delegates closure and polygon checks to the existing `evaluateClosure()` and `validateBoundary()`. Three usable points is the hard floor. Existing non-fatal gap/self-intersection semantics remain possible, but the React preview requires acknowledgment before persistence. `SurveyBoundaryPreviewLayer` draws only an ephemeral dashed polygon and owns no persisted state.

`SurveyFieldRegistration` calls `FieldRepository.create()` with existing provenance fields. `LegacyFieldRepository` still calls legacy `buildField()`/area/ID logic, writes the exact seven-key annotation payload, and now updates a named annotation source session/track's existing `fieldId` within the same localStorage write. It does not alter raw points, boundary coordinates, timestamps, or the original record identity.

Live recordings already persist `fieldId` and `fieldName` in IndexedDB. `RecordedSurveyRepository.linkToField()` reuses `RecordingStore.updateSession()` for those properties. LocalStorage field creation and IndexedDB linking cannot form one browser transaction, so this cross-store boundary is intentionally non-atomic; a saved field is never destructively rolled back if the link fails.

An already-linked survey cannot silently create a duplicate. The UI offers Open Existing Field or an explicit Create Another Field. The latter preserves the existing source record's field link while still recording source provenance on the additional field.

### Observation repository and domain

`domain/observations/types.ts` models the existing annotation observation shape. `LegacyObservationRepository` is the only Stage 3C writer of `fieldObservations`. It reads/writes `localStorage["suimonNaviFieldAnnotationsV2"]` v3, uses unchanged `buildFieldObservation()` and `makeId()`, and emits the same seven root keys as the legacy controller and FieldRepository.

Stage 3C creation exposes only existing taxonomy identifiers `note`, `weed`, `insect`, and `disease`, with existing severities `low|medium|high|urgent`. Other valid legacy types still adapt and render. Stored point order remains `[lat, lon]`; source strings remain `manual_map_click` or `qz1_current_position`. Malformed child records are skipped with warnings, while malformed/inaccessible/wrong-version stores fail closed on mutation.

`ObservationComposer` is compact route content, not a persistent settings panel. It requires an active field and offers two explicit candidate sources: the current valid GNSS fix or an armed one-shot map click. The candidate is previewed before Save. Escape/Cancel disarm placement. `isPointInsideBoundary()` supplies the existing outside warning; the operator must choose Save Anyway, and coordinates are never snapped.

`ObservationLayer` owns its own persistent Leaflet `LayerGroup`, style/radius values come from the legacy annotation core, and marker clicks use the common `{type:'observation', id}` selection. `ObservationInspector` reads the repository and shows only stored type, severity, coordinates, time, field, source, and memo.

### Map and state ownership after Stage 3C

```text
one MapWorkspace / one L.Map
  ├─ FieldLayer
  ├─ SurveyLayer
  ├─ LiveSurveyLayer
  ├─ CurrentGnssLayer
  ├─ ObservationLayer
  ├─ ObservationPlacementLayer (ephemeral candidate)
  └─ SurveyBoundaryPreviewLayer (ephemeral polygon)
```

The two new Zustand stores contain only transient tool state (candidate/armed mode and preview coordinates). They do not duplicate fields, surveys, observations, GNSS fixes, or persisted records. Domain records remain repository-derived, and selected observations use the pre-existing selected-entity store.

### Stage 3C safety boundary

- No observation deletion/update/media, water points, Water workspace, Paddy Intelligence, AI, camera, mission, manual-flight, or MAVLink work.
- Stage 3B WebSerial, parsing, recording sequence/batching/quota/flush behavior is consumed unchanged.
- No unfinished-session recovery, automatic reconnect, wake lock, or Stage 2B drawing work.
- Annotation v3 and recording IndexedDB v1 schemas are unchanged.

## Historical Stage 3B — live GNSS and recording boundary

```text
navigator.serial
  -> SerialGnssService
  -> existing nmea-parser.js
  -> focused live-GNSS store + imperative Leaflet layers
  -> RecordingService
  -> existing recording-core.js / recording-store.js
  -> suimon-navi-recording IndexedDB
  -> RecordedSurveyRepository
  -> existing Survey workspace and inspector
```

### WebSerial ownership and lifecycle

`services/gnss/serialGnssService.ts` is the only React module that touches `navigator.serial`. It exposes unsupported/disconnected/requesting/opening/connected/stalled/disconnecting/error states, guards overlapping operations, requests a port without vendor filters so Bluetooth SPP remains supported, and first reuses a granted port when available. Baud choices match legacy: 4800, 9600, 38400, and 115200, with 115200 default; open keeps the 4096-byte buffer request.

Framing accepts CRLF, LF, and CR, retains an incomplete tail, bounds a line-less buffer at 8192 characters, and attempts `$G` prefix recovery. Parsing delegates to the unchanged `js/gnss/nmea-parser.js`; React contains no second NMEA parser or new quality threshold. A valid fix is cleared on disconnect, no stale coordinate is emitted as new, and ten seconds without input marks a connected stream stalled. Clean disconnect cancels the reader and closes the port. Reconnect is an explicit operator action and can reuse the granted port; the inline legacy page's bounded automatic reopen attempts are not copied into this stage.

`services/gnss/useGnssRuntime.ts` is mounted once by `App`. It owns one serial-line subscription, feeds recording, updates coarse top-bar status, and updates `useLiveGnssStore`. Listener sets and transition-disabled UI prevent duplicate subscriptions and double opens.

### High-frequency state and persistent map ownership

`useLiveGnssStore` holds the focused UI snapshot: connection state/message, current fix, last-input time, baud, recording state/session/counters, and visible warning/error. `CurrentGnssLayer` and `LiveSurveyLayer` consume event subscriptions directly and mutate long-lived Leaflet objects, localizing high-frequency updates.

The one persistent map now hosts independent `FieldLayer`, saved `SurveyLayer`, live `LiveSurveyLayer`, and `CurrentGnssLayer` owners. Each cleans up only its own `LayerGroup`, path, or marker. Routing, selection, metadata changes, connect/disconnect, and recording do not recreate the base map.

### Recording and IndexedDB compatibility

`services/recording/recordingService.ts` is a headless adapter, not a port of `recording-controller.js`. It uses unchanged `nextRecordingState`/`makeSessionId` from `js/recording/recording-core.js` and unchanged `RecordingStore` from `js/recording/recording-store.js`.

Persistence remains IndexedDB database `suimon-navi-recording`, version 1, with stores `sessions`, `rawNmeaLines`, `structuredFixes`, `markedObservations`, and `imageBlobs`. Stage 3B writes only the first three, adds no schema version, and performs no migration. Raw lines and valid structured fixes share one monotonic sequence. Pending writes flush at 25 records, one second, and stop; failed batches are requeued and quota failures remain distinguishable.

Legacy permits starting without a fix, so React does too. Active field id/name are copied when available; otherwise the link is null. A connection loss leaves the session recording with a visible warning, allowing explicit reconnect without fake points. Stop flushes before the session becomes stopped. An existing unfinished session blocks a new React recording and directs the operator to legacy recovery; React does not resume or mutate that session in Stage 3B.

`services/recording/recordedSurveyRepository.ts` joins sessions with `structuredFixes` and exposes read-only `SurveyRecord` values named `recording:<sessionId>`. `useSurveys()` combines these asynchronous IndexedDB records with Stage 3A annotation-store records and exposes real loading/error state. A refresh after stop makes the saved session selectable without recreating the map.

### Coordinate and quality authority

Live/recording records use named `lat` and `lon` numbers. Annotation `boundaryTracks[].coordinates` remain `[lat, lon]`, not GeoJSON. Leaflet receives `[lat, lng]` only inside layer adapters. Tests pin persisted and rendered axes.

The UI reports the existing parser's validity/quality code, HDOP, satellite count, and QZ1 fields. Satellite Assurance scoring remains separate and is not merged with recording quality.

### Stage 3B limitations

- WebSerial requires a compatible secure-context browser and first permission requires a user gesture.
- Reconnect is explicit; automatic transient reopen is deferred.
- Unfinished-session recovery is block/read-only in React; use the legacy recovery UI.
- Wake locks, observations, water measurements, photos, file import, WebSocket GNSS, and live assurance are excluded.
- Ports 4173 and 5173 remain separate browser storage origins; use sequential `npm run dev:new-ui:shared-storage` for shared IndexedDB/localStorage.

## Why a separate `frontend/` directory

The repository root has no bundler today — `package.json` there runs plain Node scripts (a static file server, Playwright, `node --test`) against hand-written `<script>` tags. Vite's toolchain (its own `node_modules`, `vite.config.ts`, TypeScript project) doesn't belong mixed into that. `frontend/` is a self-contained npm package with its own `package.json`, dependency tree, and build output (`frontend/dist/`), so it can be added, iterated on, and — if a stage ever needed to — removed, without touching the root project's scripts or dependencies at all. This matches the task's own suggested layout; nothing about this repository's existing structure argued for a different placement.

## Entry point

- `frontend/index.html` → `frontend/src/main.tsx` mounts `<App />` (from `frontend/src/app/App.tsx`) into `#root`, wrapped in `StrictMode`.
- `App` creates one `createBrowserRouter` (basename `import.meta.env.BASE_URL`) and mounts both `useDroneBackendStatus()` and `useGnssRuntime()` once outside route content, so backend and serial/recording lifecycles survive workspace changes.

## Component hierarchy

```
App
└─ RouterProvider
   └─ Layout (app/routes.tsx)          -- the pathless layout route
      └─ AppShell                       -- mounted once, never remounted by route changes
         ├─ TopStatusBar                -- reads useSystemStatusStore only
         ├─ Sidebar                     -- NavLink per workspace (app/workspaces.ts)
         ├─ MapWorkspace                -- one Leaflet instance, lives in AppShell, not in a route
         │  ├─ FieldLayer               -- (Stage 2) persisted field polygons, selection, fit-bounds
         ├─ InspectorPanel              -- <Outlet/> content, or FieldInspector/the generic selection card
         │  └─ features/<workspace>/…Inspector   -- one per workspace, routed via app/routes.tsx
         │     └─ features/fields/FieldWorkspace  -- (Stage 2) selector + field summary
         └─ TelemetryTray                -- collapsible; workspace-aware via useLocation(), status via useSystemStatusStore
```

`features/common/FeaturePlaceholder.tsx` is the one shared placeholder every not-yet-migrated workspace inspector renders (task: "do not build dozens of generic card components prematurely"). `features/drone/DroneInspector.tsx` is the exception — it renders real data.

## Routing

`app/workspaces.ts` is the single source of truth for the nine workspaces (id, path, label, sidebar tooltip, recommended map layers). `app/routes.tsx` derives both the React Router route table and (implicitly, via the Sidebar reading the same array) the nav — adding a workspace means editing one array, not several files in sync.

Routing is nested under one pathless layout route so `AppShell` (and therefore the map) mounts exactly once; only the `<Outlet/>` content — the per-workspace inspector — changes as the route changes. `/` redirects to the first workspace (`/overview`).

There is deliberately no separate `workspace` Zustand store, even though the task's example list of candidate stores mentions one: `useLocation()`/`NavLink`'s own `isActive` already give the sidebar and any other component the current workspace without a second, potentially-inconsistent copy of the same fact. Add one only if something outside the router's own render tree genuinely needs the current workspace outside of a component render (e.g. a non-React subscriber) — nothing in Stage 1 does.

## State ownership

Small domain-oriented Zustand stores live under `frontend/src/store/`; there is no giant application store or Redux. The original cross-cutting stores remain, with focused active-survey/live-GNSS and transient Stage 3 tool stores added alongside them:

| Store | Holds | Notes |
|---|---|---|
| `useSelectedEntityStore` | `SelectedEntity \| null` | The one generic selection model (`types/selection.ts`). `InspectorPanel` reads it directly and takes over the panel whenever it's non-null. |
| `useSystemStatusStore` | `Record<ServiceId, ServiceStatus>` | Coarse status per subsystem. Backend/drone are wired through their existing service; GNSS/serial/recording are real as of Stage 3B; camera remains not integrated. |
| `useMapLayersStore` | Layer-id → visibility boolean | Registry (`MAP_LAYER_IDS`) for layer toggles. `field-boundary` is wired to a real layer (`FieldLayer`) as of Stage 2; the rest are still placeholders. |
| `useActiveFieldStore` | `activeFieldId: string \| null` | Just the id -- the `Field` object itself is always derived from the live repository (`services/fields/useActiveField.ts`'s `useActiveField()`), never duplicated into the store. `useActiveFieldReconciliation()` clears both a stale id and its matching inspector selection after an external store change. |

A fifth store, `useDroneTelemetryStore`, is kept **separate** from `useSystemStatusStore` on purpose: the telemetry WebSocket pushes a full snapshot at ~2Hz (`backend/app/config.py: ws_interval`), and only `DroneInspector` needs the raw snapshot. `TopStatusBar` and `TelemetryTray` subscribe only to the small derived status string in `useSystemStatusStore`, so they do not re-render at telemetry rate — see the task's guidance on high-frequency data not triggering whole-app re-renders.

Everything else (tray collapsed/expanded, form inputs, etc.) is local component `useState` — not moved into a store, per the task's "do not move every application variable into Zustand."

## Map ownership

`components/map/MapWorkspace.tsx` creates exactly one `L.map()` instance in a `useRef`-managed `useEffect`, torn down on unmount. It is rendered once, inside `AppShell`, outside the `<Outlet/>` — switching workspaces never remounts it (verified in `frontend/src/app/__tests__/routes.test.tsx` and `frontend/src/components/layout/__tests__/AppShell.test.tsx`, both of which assert the map's DOM node is reference-identical before/after a workspace switch, the latter with a real field polygon rendered throughout).

This map is a **completely separate Leaflet instance** from the one the legacy `index.html` creates — they do not share layers or state. `MapWorkspace` accepts `children`: layer components attach through `MapContext` and render as siblings of the Leaflet-owned `<div>`. Field, saved/live survey, current GNSS, observation, and ephemeral placement/preview layers now use this pattern; water/drone/mission layers can follow later.

**Why plain Leaflet instead of react-leaflet:** at the time of this migration, `react-leaflet`'s support for React 19 (the version this scaffold resolved) was not established, and a ~20-line ref-managed host doesn't need the extra dependency or its abstraction. `FieldLayer` validates that the plain-Leaflet-plus-context approach scales to a real interactive layer (click-to-select and live metadata/selection redraws) without becoming unwieldy; reconsider `react-leaflet` only if a later stage's layer needs noticeably more imperative bookkeeping than this.

## Service boundaries

`services/drone/droneService.ts` wraps the **existing, unmodified** `js/drone/drone-api-client.js` (imported via the `@legacy` Vite/TS alias — see below) behind a small `DroneService` interface:

```ts
interface DroneService {
  getHealth(): Promise<DroneHealth>
  getStatus(): Promise<DroneStatusSnapshot>
  subscribeTelemetry(handlers: TelemetrySubscriptionHandlers): TelemetrySubscription
}
```

This is deliberately narrower than `DroneApiClient`'s full surface (which also has `connect`/`disconnect`/`setMode`/`requestVersion`/`requestStreams`): Stage 1's job is proving the shell can display real backend state, not building command UI, and the task is explicit that no flight command belongs here. `frontend/src/services/drone/__tests__/droneService.test.ts` locks this down — it asserts the adapter's surface is exactly `['getHealth', 'getStatus', 'subscribeTelemetry']`, so adding a command method later is a deliberate, reviewed change to that test, not an accident.

`FieldRepository` (Stage 2), `LegacySurveyRepository` (Stage 3A), `SerialGnssService`/`RecordingService` (Stage 3B), and `LegacyObservationRepository` (Stage 3C) follow the same narrow-adapter pattern. Each wraps the existing legacy core/storage authority instead of copying it into React.

### The `@legacy` alias

`vite.config.ts` defines `resolve.alias['@legacy']` → `../js` (the repository's existing `js/` tree) and `tsconfig.app.json` mirrors it under `compilerOptions.paths`. `server.fs.allow` is set to the repository root so Vite's dev server permits serving a file outside `frontend/`. This is how Stage 1 imports `js/drone/drone-api-client.js`, and Stage 2 imports `js/fields/field-registry.js` (`validateBoundary`) and `js/fields/field-annotation-core.js` (`buildField`, `evaluateClosure`, `polygonAreaSquareMeters`, `makeId` via `js/gnss/gnss-store.js`, persistence constants) — all **unmodified**, per the task's instruction to adapt rather than duplicate. Any other already-framework-independent module identified in the Stage 0 audit can be imported the same way when its feature's stage arrives.

## Development proxy

`vite.config.ts`'s `server.proxy['/api']` forwards this dev server's `/api/*` requests — HTTP and the telemetry WebSocket (`ws: true`) — to the existing FastAPI backend on `127.0.0.1:8787`. `createDroneService()` defaults its `baseUrl` to `window.location.origin`, so every request the new frontend makes is same-origin from the browser's point of view; the proxy forwards it server-side. This is why **no backend CORS/origin configuration changed** for this migration — `backend/app/config.py`'s `allowed_origins` default is untouched. The same same-origin assumption is what makes this work unmodified in production too (see below).

Run both together for local development:

```bash
npm run backend:mock      # from the repository root -- FastAPI on 127.0.0.1:8787
npm run dev:new-ui        # from the repository root -- Vite on localhost:5173
```

(`npm run dev` continues to start the **legacy** frontend + backend, unchanged, exactly as before this migration.)

To verify against the legacy app's actual localStorage partition, stop the legacy server and run `npm run dev:new-ui:shared-storage`. This starts Vite at exactly `http://localhost:4173/` with the same API proxy, so React reads the data previously written by the legacy app on that origin. It is intentionally a sequential compatibility mode; a concurrent `/new/` mount remains future work.

## Production integration

Still not built, through Stage 2 — deliberately. Both stages' acceptance criteria require the existing desktop packaging (`backend/app/desktop_assets.py`, `desktop/*`, `packaging/*`) to keep working exactly as-is, and none of it has been touched. `backend/app/desktop_assets.py` currently mounts and serves only the legacy `index.html`/`css`/`js`/`data` tree; it has no awareness of `frontend/dist` yet.

The intended path, once a later stage decides the new UI is ready to be reachable from the desktop build, is additive: mount a built `frontend/dist` at a distinct path (e.g. `/new/`) inside `mount_frontend()` (or a sibling function) the same way the legacy assets are mounted today, and update `packaging/SuisuiNavi.spec`'s bundled `datas` to include `frontend/dist`. Because `createDroneService()` already defaults to same-origin, no service code would need to change for that — only the backend's static-mounting and the PyInstaller spec. This is intentionally left as a Stage-2-or-later decision (see docs/UI_REDESIGN.md's unresolved decisions) rather than done speculatively now.

For local, non-desktop use today, the new UI's entry points are:

- **Legacy app (unchanged):** `npm run dev` → `http://localhost:4173/`
- **New app:** `npm run backend:mock` + `npm run dev:new-ui` → `http://localhost:5173/`

Both default entry points can run at once; they use different ports and never touch each other's code or backend origin assumptions. They target the same **data format** — `localStorage["suimonNaviFieldAnnotationsV2"]` — but `4173` and `5173` are different storage partitions. Representative legacy-v3 bytes are covered by adapter tests, and the sequential `dev:new-ui:shared-storage` mode lets either interface read the same real `localhost:4173` data. A simultaneous same-origin mount (for example `/new/` in the desktop/static server) has not been implemented or claimed here.

## Stage 2 — Field management

Stage 2 added the first real migrated feature end-to-end: `existing persisted field data → FieldRepository → domain types → React state → Field workspace → Leaflet field layer → Inspector`. `docs/UI_REDESIGN.md`'s Stage 2 section has the full audit-to-implementation narrative; this section documents what exists in `frontend/` as a result.

### Authoritative data source

Two different "field" concepts existed before Stage 2 (see the Stage 0 audit, section 4/9): `js/fields/field-registry.js`'s `FieldRegistry` (in-memory, used only by Satellite Assurance) and `js/fields/field-annotation-core.js`'s flat persisted records (`localStorage["suimonNaviFieldAnnotationsV2"]`, managed by `js/fields/field-annotation-controller.js`). Stage 2 targets the **second** one — it is where saved user fields live. `FieldRegistry` itself is untouched; only its pure `validateBoundary` helper is available through the typed geometry adapter.

### `FieldRepository`

`frontend/src/services/fields/legacyFieldRepository.ts` exports:

```ts
interface FieldRepository {
  list(): Promise<Field[]>
  get(id: string): Promise<Field | null>
  create(input: CreateFieldInput): Promise<Field>
  update(id: string, patch: FieldPatch): Promise<Field>
}
```

`LegacyFieldRepository` implements it directly against `localStorage`, using `js/fields/field-annotation-core.js`'s own `buildField`/`emptyPersistedStore`/`normalizePersistedStore`/`LOCAL_STORAGE_KEY`/`SCHEMA_VERSION` and `js/gnss/gnss-store.js`'s `makeId` — **unmodified**, imported via `@legacy`. Every write reads the current full v3 store and emits the legacy controller's exact seven root keys, preserving the sibling arrays and workflow state. A literal representative legacy-v3 record is tested through `list()`/`get()` with exact `[lat, lon]` order and a no-write assertion.

Reads retain legacy's defensive behavior (malformed JSON becomes an empty list), while the React workspace separately surfaces that condition as an error instead of an ordinary empty state. There is no artificial loading state because localStorage reads are synchronous. Mutations fail closed when existing bytes are malformed, inaccessible, or not schema v3, so React never overwrites recoverable bytes or performs an implicit migration.

Deletion is intentionally absent from the repository and disabled in the UI. The annotation controller's local cascade does not cover recording data in IndexedDB, vegetation field references, or Satellite Assurance's copied registry records. Removing a field before those cross-store references have an explicit policy would be unsafe.

`update()` is deliberately narrower than legacy's own feature-editor: only `name`/`memo` are patchable. Legacy also allows renaming a field's `id`, cascading that rename across every foreign-key reference (`saveSelectedFeature()`); Stage 2 does not reproduce that (see Unresolved decisions below).

The class also exposes `subscribe()`/`getSnapshot()` (not part of the `FieldRepository` interface — an implementation-specific React binding) so `services/fields/useFields.ts`'s `useFields()` can use `useSyncExternalStore`. A `window` `"storage"` listener invalidates the cache on same-origin cross-tab writes.

### Domain layer

`frontend/src/domain/fields/`:
- `geometry.ts` — typed wrappers over `validateBoundary`/`evaluateClosure`/`polygonAreaSquareMeters` (still the actual legacy functions; no formula is reimplemented).
- `types.ts` — `Field`/`FieldProperties`/`CreateFieldInput`/`FieldPatch`, documented field-by-field as persisted/computed/legacy-compatibility.
- `selectors.ts` — pure display helpers (`formatAreaSquareMeters`, `findFieldById`, `sortFieldsByName`, etc.).

**Area parity:** `frontend/index.html` loads the same Turf.js build (same version/integrity hash) the legacy app uses, so `polygonAreaSquareMeters()` takes the same Turf branch in a browser. The TypeScript wrapper delegates directly to that authoritative function, and its test asserts exact equality rather than a second formula.

### State

`useActiveFieldStore` holds only `activeFieldId`. `services/fields/useActiveField.ts` provides `useActiveField()` (derives the `Field` from `useFields()` + the id — never a second copy) and `useActiveFieldReconciliation()` (clears a stale id and matching field selection once the record no longer exists; mounted once in `App.tsx`). Selecting from the dropdown or clicking a polygon always sets both `activeFieldId` and `useSelectedEntityStore.selectedEntity`; there is no separate map-selected state.

### UI

- `features/fields/FieldWorkspace.tsx` — the `/field` route's compact inspector content: selector, explicit empty/read-error state, and active-field summary. No permanent field-card list.
- `features/fields/FieldToolbar.tsx` — compact selector plus visibly disabled New Field, Edit Boundary, and Delete controls whose tooltips explain the safety boundary.
- `features/fields/FieldInspector.tsx` — shown whenever `selectedEntity.type === "field"`: real name, memo, area, boundary-point count, timestamps, narrow name/memo editing, and a disabled Delete control.
- `components/map/layers/FieldLayer.tsx` — persisted field polygons (legacy's own `FIELD_POLYGON_STYLE`, reused not reinvented), active-field styling, click-to-select, fit-bounds on selection (skipped on first render so opening the app doesn't yank the view).
- `components/map/MapContext.tsx` — new: publishes the one Leaflet instance to layer components via React context, so `MapWorkspace` never needs to know what layers exist.

### Deferred (deliberately, not overlooked)

- **Map creation and boundary editing** — deferred to Stage 2B. The discarded draft implementation mixed walked-track closure semantics with manual polygon clicks and could leave draw state active across navigation; it is not shipped.
- **Deletion** — disabled until recording, vegetation, and assurance references have a cross-store policy.
- **Field-id renaming with FK cascade** — legacy supports it; Stage 2's `FieldPatch` intentionally excludes `id`.
- **"Save as boundary track" instead of a closed polygon** — out of scope since boundary tracks/survey are Stage 3, not Stage 2.
- Paddy intelligence, planting estimate, water/observations/GNSS/reports — unchanged, per the task's explicit non-goals.

## Stage 3A — Survey/GNSS read-only foundation

Stage 3A extends the compatibility architecture without adding a live receiver service:

```text
localStorage schema v3 surveySessions + boundaryTracks
  -> domain/surveys compatibility adapters
  -> read-only LegacySurveyRepository
  -> useSyncExternalStore snapshot
  -> Survey workspace / shared selection / Survey inspector
  -> SurveyLayer on the existing MapWorkspace Leaflet instance
```

The persisted annotation store, not `GnssStore`, is authoritative for saved survey data. `GnssStore` remains an in-memory receiver/assurance store. `LegacySurveyRepository` never writes or migrates storage; it reports unsupported schema or malformed storage as an error and skips malformed child records with visible warnings.

Coordinate contracts are explicit:

- saved raw survey points: `{ lat, lon }`;
- saved boundary-track tuples: `[lat, lon]`;
- Leaflet view boundary: `[lat, lng]`, same order;
- GeoJSON `[lon, lat]` is not used for this persistence path.

Session raw points supply the rendered path when at least two valid positions exist. A linked boundary track is the fallback. Tracks without a session remain independent read-only survey records. `FieldLayer` and `SurveyLayer` coexist as separate persistent `LayerGroup`s under the one map context.

Quality systems remain separate: recorded per-point fix/HDOP/satellite values, annotation-core fix summaries, and Satellite Assurance/QZ1 classifications are not merged. The React inspector displays recorded values without adding thresholds. The existing NMEA parser is reused through an ephemeral typed preview adapter; no second parser and no import persistence were added.

Stage 3B is deferred: WebSerial permissions/connections, live recording and telemetry, and QZ1 hardware/service state require a separate service lifecycle design.

## Migration strategy (recap, updated after Stage 3A)

See `docs/UI_REDESIGN.md` section 18 for the staged plan. Stage 1 built the shell and service-adapter pattern; Stage 2 proved it on persisted Field data; Stage 3A now proves read-only Survey/GNSS compatibility and layer coexistence. The recommended next step is Stage 3B's live-GNSS service boundary, after an explicit WebSerial lifecycle and permission design. Stage 2B remains independently deferred.
