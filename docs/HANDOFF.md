# Frontend migration handoff

Updated: 2026-08-09 (Asia/Tokyo)

## 1. Current migration stage

Stage 3C is complete at the smallest safe boundary: a saved annotation boundary track or valid recorded GNSS fixes can be previewed and registered through the existing `FieldRepository`; the supported survey/session `fieldId` link is updated; manual note/weed/insect/disease observations can be previewed from current GNSS or an explicit map click, saved into the existing annotation schema, rendered on the persistent map, and inspected. Stop here. Water/Stage 4 and Stage 2B have not started.

The legacy static app remains intact. The default legacy (`localhost:4173`) and React (`localhost:5173`) dev servers use different browser storage partitions. For a real same-data check, stop the legacy server and run `npm run dev:new-ui:shared-storage`; React then runs sequentially on the exact legacy `http://localhost:4173` origin and reads the same localStorage. A simultaneous `/new/` mount is still unresolved.

## 2. Stage 3C completion checkpoint

### Survey to field conversion

- `prepareSurveyBoundary()` is a typed, side-effect-free adapter. An explicit legacy `boundaryTrack.coordinates` is authoritative when present. Otherwise it uses valid (`fixValid !== false`) session/recording fixes. Malformed non-finite coordinates are excluded; no geographic range or accuracy threshold is invented.
- Coordinates remain **`[lat, lon]`**. Duplicate and repeated points remain in their recorded order because the legacy registration path does not silently deduplicate them. At least three usable points are required.
- `evaluateClosure()` and `validateBoundary()` remain authoritative. Fewer than three points is a hard failure. Large closure gaps and self-intersection retain legacy's non-fatal semantics but require an explicit preview acknowledgment before React will save.
- `SurveyBoundaryPreviewLayer` draws a temporary dashed polygon on the existing map. Cancel/unmount removes it without persistence.
- Registration calls `FieldRepository.create()` only. `CreateFieldInput` now carries the existing `sourceSessionId`, source filename/type, point count, quality summary, and optional source-track link. The repository still delegates record construction, area, gap, and IDs to the unchanged legacy helpers.
- For annotation-store surveys, field creation and updating existing `surveySessions[].fieldId` / `boundaryTracks[].fieldId` happen in one localStorage write. All raw points, track coordinates, metadata, and the source record remain intact.
- Recorded IndexedDB sessions already have `fieldId`/`fieldName`; `RecordedSurveyRepository.linkToField()` updates only those existing properties through `RecordingStore.updateSession()`. This cross-store link cannot be atomic with localStorage field creation. If it fails, the field remains safely persisted rather than being deleted or rolled back.
- A survey already linked to a field presents **Open Existing Field** and an explicit **Create Another Field** choice. The additional-field path does not overwrite the existing survey link.
- After success, the new field becomes the active field, selected entity becomes `{type:"field"}`, and the existing Field selector, FieldLayer, and FieldInspector update from the shared repository subscription without reload.

### Observation persistence and placement

- Persistence remains `localStorage["suimonNaviFieldAnnotationsV2"]`, schema version 3, array `fieldObservations`. Stage 3C creates no database, key, schema version, or renamed property.
- `LegacyObservationRepository` reads representative legacy records, skips malformed children with a warning, and fails closed on malformed/inaccessible/unsupported storage. Writes emit the legacy controller's exact seven root keys and preserve sibling datasets.
- Record construction reuses unchanged `buildFieldObservation()`, `nextObservationName()`, `normalizeObservationType()`, `normalizeSeverity()`, and `makeId()`. Stage 3C creation exposes only existing identifiers: `note`, `weed`, `insect`, and `disease`; severity remains `low`, `medium`, `high`, or `urgent`.
- Persisted point coordinates are exactly **`[lat, lon]`**. Sources are existing `manual_map_click` or `qz1_current_position`. Timestamp, memo, active `fieldId`, label/name, and severity retain the legacy shape.
- **Use Current GNSS** requires a valid current fix. **Place on Map** explicitly arms one map click; ordinary clicks never create data. The candidate is previewed first, Cancel and Escape clear placement, and no record is written until Save.
- `isPointInsideBoundary()` is the authoritative outside-field check. An outside candidate shows a warning and requires the explicit **Save Anyway** action, matching legacy semantics; no auto-snap occurs.
- `ObservationLayer` owns a separate long-lived Leaflet group beside FieldLayer, SurveyLayer, live track, and current fix. It uses the existing type colors and severity radii, selects through the shared selected-entity store, and never recreates the map.
- `ObservationInspector` displays only persisted type, severity, `[lat, lon]`, timestamp when present, field link, manual source, and memo. No AI/species/confidence/photo data is fabricated.

### Exact Stage 3C changed files

```text
docs/HANDOFF.md
docs/FRONTEND_ARCHITECTURE.md
docs/UI_REDESIGN.md
frontend/tests/browser/stage3c-survey-observation.spec.ts
frontend/src/components/layout/AppShell.tsx
frontend/src/components/layout/InspectorPanel.tsx
frontend/src/components/layout/__tests__/InspectorPanel.test.tsx
frontend/src/components/map/MapWorkspace.css
frontend/src/components/map/layers/ObservationLayer.tsx
frontend/src/components/map/layers/ObservationPlacementLayer.tsx
frontend/src/components/map/layers/SurveyBoundaryPreviewLayer.tsx
frontend/src/components/map/layers/__tests__/ObservationLayer.test.tsx
frontend/src/domain/fields/types.ts
frontend/src/domain/observations/types.ts
frontend/src/domain/surveys/surveyBoundary.ts
frontend/src/domain/surveys/__tests__/surveyBoundary.test.ts
frontend/src/features/observations/ObservationInspector.tsx
frontend/src/features/survey/ObservationComposer.tsx
frontend/src/features/survey/SurveyFieldRegistration.tsx
frontend/src/features/survey/SurveyInspector.css
frontend/src/features/survey/SurveyInspector.tsx
frontend/src/features/survey/__tests__/Stage3CWorkflow.test.tsx
frontend/src/services/fields/legacyFieldRepository.ts
frontend/src/services/fields/__tests__/legacyFieldRepository.test.ts
frontend/src/services/observations/legacyObservationRepository.ts
frontend/src/services/observations/useObservations.ts
frontend/src/services/observations/__tests__/legacyObservationRepository.test.ts
frontend/src/services/recording/recordedSurveyRepository.ts
frontend/src/services/recording/__tests__/recordedSurveyRepository.test.ts
frontend/src/store/useObservationPlacementStore.ts
frontend/src/store/useSurveyBoundaryPreviewStore.ts
```

### Stage 3C verification

- `npm.cmd test` in `frontend/`: **31 files, 106/106 passed**.
- `npm.cmd test` at repository root: **194/194 passed**.
- `node --test tests/unit/nmea-parser.test.js tests/unit/gnss-store.test.js tests/unit/recording-core.test.js tests/unit/field-annotation-core.test.js`: **49/49 passed**.
- React Playwright acceptance, `npx.cmd playwright test --config frontend/playwright.config.ts`: **2/2 passed**. Stage 3C covers legacy boundary read, preview, React field creation, same-session link, live-GNSS observation creation, exact persisted shapes/order, ObservationLayer, inspector, and all three required viewports.
- Focused legacy observation browser tests (types/field link, map-click/geolocation, persistence/reload): **3/3 passed**.
- `npx.cmd tsc -b`: passed.
- `npx.cmd vite build`: passed (112 modules; JS 515.37 kB / 157.05 kB gzip, CSS 26.58 kB / 8.62 kB gzip). Vite now reports its advisory >500 kB chunk warning; this is not a build failure and no warning limit was raised to hide it.
- `npm.cmd run lint`: passed with the one pre-existing `react-refresh/only-export-components` warning in `frontend/src/app/routes.tsx`; Stage 3C adds no warning.
- Backend tests were not run because Stage 3C changed no backend, API, MAVLink, or command contract.
- **1366×768, 1920×1080, and 1024×768** automated checks found exact document/viewport dimensions, accessible live-GNSS and placement controls, and no document scrolling. In-app visual inspection at 1024×768 measured document 1024×768; the inspector correctly scrolls internally (508px client / 711px content) while the map remains usable.

Compatibility is pinned in both directions: literal legacy observation bytes render in React without a write; React field/observation records have the exact v3 key/record shapes consumed by `field-annotation-controller.js`; focused legacy browser tests read/render the same observation schema. Shared-origin real data still requires sequential `npm run dev:new-ui:shared-storage` until concurrent mounting exists.

The Playwright dev server logged expected `/api`/WebSocket proxy aborts because the optional backend was not running; both frontend acceptance tests passed and Stage 3C has no backend dependency.

### Known limitations and deferred work

- Recorded-session linking crosses IndexedDB/localStorage and therefore is not atomic. No destructive rollback is attempted.
- Observation update/delete and media/photos remain deferred. Field deletion remains disabled.
- Stage 2B manual field drawing/editing, automatic serial reconnect, unfinished-session recovery, wake locks, and live assurance remain deferred.
- Water points/workspace, Paddy Intelligence, reports, AI/camera, drone missions, manual flight, and MAVLink changes are untouched.

### Unrelated dirty files that must remain untouched

Preserve all pre-existing changes under `backend/`, `js/gamepad/`, `js/pilot/`, `css/pilot.css`, pilot/gamepad/MAVLink docs and tests, `index.html`, `scripts/dev.ps1`, `scripts/run-backend.mjs`, `.claude/launch.json`, `docs/CLAUDE_HANDOFF.md`, and the root `package.json`. Stage 3C did not edit them.

### Recommended next stage

Recommend **Stage 4 — Water read-only/persistence audit and smallest safe workspace slice**, beginning with the existing water-control-point schema and deletion/reference semantics. Do not begin Stage 4 automatically.

## 3. Historical Stage 3B completion checkpoint

- `SerialGnssService` is the sole React owner of `navigator.serial`. It requests ports without USB filters (preserving USB and Bluetooth SPP support), reuses a previously granted port when available, opens at 4800/9600/38400/115200 baud (115200 default), frames CR/LF-delimited input with an 8192-character guard, and delegates parsing to the unchanged `js/gnss/nmea-parser.js`.
- Connection state is explicit: unsupported, disconnected, requesting, opening, connected, stalled, disconnecting, or error. A valid current fix is cleared on disconnect; stale state is visible after 10 seconds without input. Clean disconnect closes the reader and port. Reconnect is an explicit operator action and can reuse the granted port; the legacy page's bounded automatic reopen attempts are not copied into React.
- `useLiveGnssStore` owns the low-frequency UI snapshot. Imperative `CurrentGnssLayer` and `LiveSurveyLayer` subscriptions localize high-frequency Leaflet updates instead of re-rendering the application shell.
- `RecordingService` delegates IDs and recording transitions to the unchanged `js/recording/recording-core.js` and writes through the unchanged `js/recording/recording-store.js`. It batches writes at 25 records or one second, assigns one monotonic sequence across raw-line and structured-fix records, and requeues a failed batch without duplicating records.
- Starting is allowed without a fix and records an explicit null field link when no field is active. When a field is active, its id/name are copied into the existing session fields. Stopping flushes pending data before marking the session stopped. Disconnect does not invent points or silently stop the session; it leaves recording active with a visible warning so an explicit reconnect can continue the same in-memory session.
- An existing unfinished IndexedDB session blocks a new React recording. React deliberately does not implement legacy session resume/recovery UI in Stage 3B; the error directs the operator to the legacy interface rather than risking a forked or overwritten session.
- `RecordedSurveyRepository` is read-only and adapts stopped/recording sessions plus `structuredFixes` into the Stage 3A `SurveyRecord` model. Saved recording IDs are namespaced as `recording:<sessionId>`, and repository refresh after stop makes the completed session selectable without recreating the map.
- Persistence authority is IndexedDB **`suimon-navi-recording` version 1**, with existing stores `sessions`, `rawNmeaLines`, `structuredFixes`, `markedObservations`, and `imageBlobs`. Stage 3B writes only the first three and changes neither the database version nor any record shape.
- Live and persisted positions use named `lat`/`lon` values. The older annotation boundary tuple authority remains **`[lat, lon]`**. Leaflet receives `[lat, lng]` only inside map-layer view adapters; no GeoJSON `[lon, lat]` conversion or schema rewrite occurs.
- GNSS quality remains raw/authoritative: parser fix validity, HDOP, satellite count, quality code, and QZ1 sentence fields are displayed as supplied. React introduces no new thresholds and does not merge NMEA quality with Satellite Assurance scoring.
- WebSerial unsupported, permission rejection, open/read failure, storage/quota failure, and unfinished-session blocking are distinct user-visible states. Repeated clicks and duplicate listener registration are guarded.
- WebSerial is still only available in a secure context and requires a user gesture for first permission. The React and legacy default ports remain different storage origins; use `npm run dev:new-ui:shared-storage` sequentially on `localhost:4173` for the same localStorage and IndexedDB data.

### Exact Stage 3B changed files

```text
docs/HANDOFF.md
docs/FRONTEND_ARCHITECTURE.md
docs/UI_REDESIGN.md
frontend/playwright.config.ts
frontend/tests/browser/gnss-recording.spec.ts
frontend/vite.config.ts
frontend/src/app/App.tsx
frontend/src/components/layout/AppShell.tsx
frontend/src/components/layout/TopStatusBar.tsx
frontend/src/components/map/layers/CurrentGnssLayer.tsx
frontend/src/components/map/layers/LiveSurveyLayer.tsx
frontend/src/components/map/layers/__tests__/LiveGnssLayers.test.tsx
frontend/src/domain/surveys/types.ts
frontend/src/features/survey/SurveyInspector.css
frontend/src/features/survey/SurveyInspector.tsx
frontend/src/features/survey/__tests__/SurveyInspector.test.tsx
frontend/src/services/fields/legacyFieldRepository.ts
frontend/src/services/gnss/serialGnssService.ts
frontend/src/services/gnss/useGnssRuntime.ts
frontend/src/services/gnss/__tests__/serialGnssService.test.ts
frontend/src/services/gnss/__tests__/useGnssRuntime.test.tsx
frontend/src/services/recording/recordedSurveyRepository.ts
frontend/src/services/recording/recordingService.ts
frontend/src/services/recording/__tests__/recordedSurveyRepository.test.ts
frontend/src/services/recording/__tests__/recordingService.test.ts
frontend/src/services/surveys/legacySurveyRepository.ts
frontend/src/services/surveys/useSurveys.ts
frontend/src/store/useLiveGnssStore.ts
frontend/src/store/useSystemStatusStore.ts
```

### Stage 3B verification

- `npm.cmd test` in `frontend/`: **27 files, 93/93 passed**.
- `npm.cmd test` at repository root: **194/194 passed**.
- `node --test tests/unit/nmea-parser.test.js tests/unit/gnss-store.test.js tests/unit/recording-core.test.js tests/unit/field-annotation-core.test.js`: **49/49 passed**.
- React browser acceptance, `npx.cmd playwright test --config frontend/playwright.config.ts`: **1/1 passed**. It uses fake WebSerial, records a valid fix, verifies status/current marker/live track/field coexistence, inspects exact IndexedDB session and raw-line records, reloads, and reads the saved session in Survey.
- Relevant legacy browser cases (Bluetooth SPP, recording lifecycle, quota recovery, exactly-once sequence): **4/4 passed**. The exactly-once case first exposed a UI-counter timing race in a combined run (15 displayed while 14 were committed), then passed **1/1** in isolation; persisted IDs remained unique and no production change was made for the timing-only assertion.
- `npx.cmd tsc -b`: passed.
- `npx.cmd vite build`: passed (101 modules; JS 497.66 kB / 152.82 kB gzip, CSS 25.94 kB / 8.50 kB gzip).
- `npm.cmd run lint`: passed with the one pre-existing `react-refresh/only-export-components` warning in `frontend/src/app/routes.tsx`; Stage 3B adds no lint warning.
- Backend tests were not run because Stage 3B changed no backend/API/MAVLink file.
- Automated connected-and-recording browser checks at **1366x768**, **1920x1080**, and **1024x768** found exact document/viewport dimensions and no document-level scroll. The 1024x768 state was also visually inspected; overflow remains inside the inspector.

### Unrelated dirty files that must remain untouched

Preserve all pre-existing changes under `backend/`, `js/gamepad/`, `js/pilot/`, `css/pilot.css`, pilot/gamepad/MAVLink docs and tests, `index.html`, `scripts/dev.ps1`, `scripts/run-backend.mjs`, `.claude/launch.json`, `docs/CLAUDE_HANDOFF.md`, and the root `package.json`. Stage 3B did not edit them.

### Deferred work and recommended next stage

Deferred: automatic transient serial reopen, React recovery/resume of unfinished recording sessions, wake-lock handling, marked observations/photos, live Satellite Assurance integration, persisted NMEA-file import, WebSerial device metadata beyond browser-provided info, session deletion/editing, and all Stage 3C/non-goal domains.

Recommended next stage: **Stage 3C planning only**, beginning with an explicit decision about unfinished-session recovery and reconnect ownership before adding any UI. Do not begin Stage 3C automatically. Stage 2B remains independently deferred.

## 4. Historical Stage 3A completion checkpoint

- Persistence authority remains `localStorage["suimonNaviFieldAnnotationsV2"]`, numeric schema version `3`. Stage 3A reads only `surveySessions` and `boundaryTracks`; it performs no writes and changes no schema.
- `surveySessions[].rawPoints` persist positions as named `{ lat, lon }` properties. `boundaryTracks[].coordinates` persist tuples as **`[lat, lon]`**. These are not GeoJSON `[lon, lat]`. `SurveyLayer` converts only at its Leaflet view boundary, where `[lat, lng]` has the same axis order.
- `LegacySurveyRepository` validates the store version, adapts valid records and points, surfaces malformed child records as warnings, reports unreadable/malformed/unsupported storage as an error, and never rewrites source bytes.
- A display record is a saved session optionally joined through `boundaryTracks[].sourceSessionId`. Valid session raw points are the display path when at least two exist; the linked track is the fallback. Orphan boundary tracks remain visible/selectable as `boundary-track:<track id>` records.
- The Survey route is a compact read-only workspace with empty/error/warning states and a survey/session selector. Selector and map selection share the selected-entity model.
- The inspector shows point count, recorded time, raw HDOP/satellite ranges, source/measurement metadata, and linked field name/id when present.
- No React quality thresholds were introduced. Raw GNSS values, annotation-core fix summaries, and Satellite Assurance/QZ1 scoring remain distinct systems.
- `SurveyLayer` and `FieldLayer` own separate persistent `Leaflet.LayerGroup`s on the one `MapWorkspace` map. Route and selection changes do not recreate the map.
- `parseSurveyNmeaPreview()` is a typed ephemeral wrapper over the existing `js/gnss/nmea-parser.js`; it proves parser reuse and writes nothing. There is no import UI in Stage 3A.
- Loading is not synthesized because localStorage reads are synchronous.

### Exact Stage 3A changed files

```text
docs/HANDOFF.md
docs/FRONTEND_ARCHITECTURE.md
docs/UI_REDESIGN.md
frontend/src/components/layout/AppShell.tsx
frontend/src/components/layout/InspectorPanel.tsx
frontend/src/components/map/layers/SurveyLayer.tsx
frontend/src/components/map/layers/surveyCoordinates.ts
frontend/src/components/map/layers/__tests__/SurveyLayer.test.tsx
frontend/src/domain/surveys/types.ts
frontend/src/domain/surveys/adapters.ts
frontend/src/domain/surveys/selectors.ts
frontend/src/domain/surveys/__tests__/adapters.test.ts
frontend/src/features/survey/SurveyInspector.tsx
frontend/src/features/survey/SurveyInspector.css
frontend/src/features/survey/SurveySelector.tsx
frontend/src/features/survey/SurveyDetail.tsx
frontend/src/features/survey/__tests__/SurveyInspector.test.tsx
frontend/src/services/surveys/legacySurveyRepository.ts
frontend/src/services/surveys/useSurveys.ts
frontend/src/services/surveys/__tests__/legacySurveyRepository.test.ts
frontend/src/store/useActiveSurveyStore.ts
frontend/src/types/selection.ts
```

### Stage 3A verification

- `npm.cmd test` in `frontend/`: **22 files, 79/79 passed**.
- `npm.cmd test` at repository root: **194/194 passed**.
- `node --test tests/unit/nmea-parser.test.js tests/unit/gnss-store.test.js tests/unit/field-annotation-core.test.js`: **40/40 passed**.
- `npx.cmd playwright test tests/browser/field-annotation.spec.js --grep "small NMEA upload stores rawNmeaText" --reporter=line`: **1/1 passed**.
- `npx.cmd tsc -b`: passed.
- `npx.cmd vite build`: passed (91 modules; JS 469.62 kB / 144.66 kB gzip, CSS 25.14 kB / 8.36 kB gzip).
- `npm.cmd run lint`: exit 0. One pre-existing `react(only-export-components)` warning remains in `frontend/src/app/routes.tsx:27`; Stage 3A introduced no lint warning.
- Backend tests were not run because no backend file, API contract, or command path changed.
- Real-browser checks at **1366x768**, **1920x1080**, and **1024x768**: document width/height exactly matched the viewport, map and inspector stayed in bounds, and there was no document-level scrolling. The compact layout was also visually inspected.

Two verification attempts were command-level failures, not product failures: Vitest rejected the unsupported Jest flag `--runInBand`, then passed 79/79 with its configured sequential runner; an attempt to run the entire large legacy `field-annotation.spec.js` inside a 120-second combined command timed out, then the directly relevant NMEA-persistence case passed 1/1 in 5.5 seconds.

### Unrelated dirty files that must remain untouched

The Stage 2 protected list remains authoritative. Preserve all existing changes under `backend/`, `js/gamepad/`, `js/pilot/`, `css/pilot.css`, pilot/gamepad/MAVLink docs and tests, `index.html`, `scripts/dev.ps1`, `scripts/run-backend.mjs`, `.claude/launch.json`, and `docs/CLAUDE_HANDOFF.md`. Stage 3A did not edit any of them.

### Deferred work and recommended next stage

Deferred: WebSerial and serial-permission UI, live GNSS recording/telemetry, QZ1 hardware connection, persisted NMEA import, observation/water placement, Survey deletion/editing, Stage 2B field drawing, and later water/data/report/drone/AI/mission work.

Recommended next stage: **Stage 3B — live GNSS service boundary**, starting with a written WebSerial lifecycle and permission design plus a typed `GnssService` interface. Keep it separate from persisted survey reads and do not begin it automatically. Stage 2B remains an independent alternative, but it must not reuse walked-track closure semantics for manual polygon drawing.

## 5. Historical Stage 2 checkpoint

The remaining subsections preserve the Stage 2 handoff for audit history. Their test counts, deferred list, and recommendation are superseded by the Stage 3B checkpoint above.

- A typed `FieldRepository` adapter over `localStorage["suimonNaviFieldAnnotationsV2"]`, numeric schema v3.
- The persisted flat `field.coordinates` annotation record is authoritative. The assurance-only in-memory `FieldRegistry` is not used as storage.
- Exact legacy `[lat, lon]` order, field shape, area function, normalization, and seven-key write payload are preserved.
- Representative legacy-v3 reads do not rewrite storage. Malformed/inaccessible/non-v3 bytes fail closed on mutation; read failures are visibly different from an empty store.
- `useActiveFieldStore` stores only `activeFieldId`; the record is derived from the live repository. Reconciliation clears a stale ID and its matching field inspector selection.
- `FieldLayer` owns persisted polygons on one long-lived Leaflet `LayerGroup`. Selector and polygon clicks update the same active-field and selected-entity state.
- The compact Field workspace has a selector, empty/error states, real field summary, and a real inspector with area, point count, timestamps, memo, and narrow name/memo editing. No artificial loading state is shown because localStorage reads are synchronous.
- New Field, Edit Boundary, and Delete remain visible but disabled. Deletion is not part of `FieldRepository`.
- `npm run dev:new-ui:shared-storage` provides a sequential same-origin compatibility mode on `localhost:4173`.

### Exact Stage 2-owned files

The whole `frontend/` package is still untracked relative to `HEAD`, so Git cannot separate its earlier Stage 1 files from Stage 2 automatically. The Stage 2-owned/touched set is:

```text
package.json
docs/FRONTEND_ARCHITECTURE.md
docs/UI_REDESIGN.md
docs/HANDOFF.md
frontend/README.md
frontend/index.html
frontend/package.json
frontend/vite.config.ts
frontend/src/app/App.tsx
frontend/src/app/routes.tsx
frontend/src/app/__tests__/routes.test.tsx
frontend/src/components/layout/AppShell.tsx
frontend/src/components/layout/InspectorPanel.tsx
frontend/src/components/layout/__tests__/AppShell.test.tsx
frontend/src/components/layout/__tests__/InspectorPanel.test.tsx
frontend/src/components/map/MapContext.tsx
frontend/src/components/map/MapWorkspace.tsx
frontend/src/components/map/__tests__/MapWorkspace.test.tsx
frontend/src/components/map/layers/FieldLayer.tsx
frontend/src/components/map/layers/__tests__/FieldLayer.test.tsx
frontend/src/domain/fields/geometry.ts
frontend/src/domain/fields/selectors.ts
frontend/src/domain/fields/types.ts
frontend/src/domain/fields/__tests__/geometry.test.ts
frontend/src/domain/fields/__tests__/selectors.test.ts
frontend/src/features/fields/FieldInspector.css
frontend/src/features/fields/FieldInspector.tsx
frontend/src/features/fields/FieldSelector.tsx
frontend/src/features/fields/FieldToolbar.css
frontend/src/features/fields/FieldToolbar.tsx
frontend/src/features/fields/FieldWorkspace.css
frontend/src/features/fields/FieldWorkspace.tsx
frontend/src/features/fields/__tests__/FieldInspector.test.tsx
frontend/src/features/fields/__tests__/FieldSelector.test.tsx
frontend/src/features/fields/__tests__/FieldToolbar.test.tsx
frontend/src/features/fields/__tests__/FieldWorkspace.test.tsx
frontend/src/services/fields/fieldRepositoryErrors.ts
frontend/src/services/fields/legacyFieldRepository.ts
frontend/src/services/fields/useActiveField.ts
frontend/src/services/fields/useFields.ts
frontend/src/services/fields/__tests__/legacyFieldRepository.test.ts
frontend/src/services/fields/__tests__/useActiveField.test.tsx
frontend/src/store/useActiveFieldStore.ts
frontend/src/store/useMapLayersStore.ts
frontend/src/store/__tests__/useActiveFieldStore.test.ts
```

Removed from the draft implementation before handoff:

```text
frontend/src/components/map/layers/FieldDrawLayer.tsx
frontend/src/components/map/layers/__tests__/FieldDrawLayer.test.tsx
frontend/src/features/fields/fieldDrawStore.ts
frontend/src/features/fields/__tests__/fieldDrawStore.test.ts
```

### Architecture decisions

- Persistence target: `field-annotation-core.js` records, not `FieldRegistry`.
- No domain formulas were copied. Geometry wrappers call the legacy functions directly; Turf 7.2.0 is loaded with the same URL/integrity metadata as the legacy app.
- Reads remain tolerant for legacy parity, but the React UI surfaces corrupt storage and writes never overwrite it or down-stamp an unknown schema.
- Creation remains in the adapter contract and tests, but no creation UI is exposed until Stage 2B defines correct manual-polygon semantics and route cleanup.
- Deletion is disabled because the annotation store's cascade does not cover recording IndexedDB `fieldId` values, vegetation field references, or assurance copies.
- Name/memo are the only editable fields. Field-ID rename and its foreign-key cascade are not exposed.
- Map and layer ownership stay outside route content. Route, selection, inspector, and metadata changes do not recreate the base map or `LayerGroup`.

### Tests and exact results

Final verification:

| Command/check | Result |
|---|---|
| `npm.cmd --prefix frontend test` | 18 files, **65 passed**, 0 failed |
| `npm.cmd --prefix frontend run build` | TypeScript + Vite build passed |
| `npm.cmd --prefix frontend run lint` | Exit 0; one existing warning at `src/app/routes.tsx:27` (`react/only-export-components`) |
| `npm.cmd test` | **194 passed**, 0 failed |
| `npm.cmd run test:backend` | **273 passed**, 0 failed |
| `npm.cmd run test:browser -- tests/browser/field-annotation.spec.js tests/browser/assurance.spec.js` | **51 passed**, 0 failed |
| `npm run dev:new-ui:shared-storage` smoke check | `http://localhost:4173/` returned HTTP 200 with the React app title |
| `git diff --check` | Passed |

Live React checks used a persisted four-point field and verified selector-to-inspector, metadata save, route switching, one map node, and one polygon. Layout metrics:

| Viewport | Document client/scroll | Map | Inspector | Window scroll |
|---|---:|---:|---:|---:|
| 1366×768 | 1366×768 / 1366×768 | 918×508 | 280×508 | 0,0 |
| 1920×1080 | 1920×1080 / 1920×1080 | 1432×820 | 320×820 | 0,0 |
| 1024×768 | 1024×768 / 1024×768 | 648×508 | 280×508 | 0,0 |

There was no ordinary document-level scrolling at any required viewport.

### Known failures

No final Stage 2, root unit, backend, or focused legacy field/assurance check failed.

- Lint reports the pre-existing Stage 1 fast-refresh warning in `frontend/src/app/routes.tsx`; it is not a correctness failure.
- An earlier backend baseline run had one transient failure in `test_vehicle_rejection_is_reported_never_swallowed` while unrelated dirty essential-stream work was present. Its isolated retry passed, and the final full backend run passed 273/273.
- The predecessor's last full legacy Playwright run reported 189 passed and one known timeout-shaped recording flake at `tests/browser/recording.spec.js:124`. The final Stage 2-focused legacy run was 51/51; the full 190-test browser suite was not rerun during this cleanup.

### Dirty files belonging to other work — do not touch

These are concurrent pilot/manual-control/MAVLink changes and were preserved:

```text
backend/app/config.py
backend/app/main.py
backend/app/mavlink/interface.py
backend/app/mavlink/link_manager.py
backend/app/mavlink/mock_connection.py
backend/app/mavlink/real_connection.py
backend/app/mavlink/pilot_limits.py
backend/app/mavlink/pilot_service.py
backend/app/models.py
backend/tests/test_command_service.py
backend/tests/test_essential_streams.py
backend/tests/test_pilot_service.py
css/pilot.css
docs/CLAUDE_HANDOFF.md
docs/GAMEPAD_OPERATOR_GUIDE.md
docs/MAVLINK_OPERATOR_GUIDE.md
docs/PILOT_CONTROL_GUIDE.md
index.html
js/gamepad/gamepad-controller.js
js/gamepad/keyboard-provider.js
js/pilot/
scripts/dev.ps1
scripts/run-backend.mjs
tests/browser/desktop.spec.js
tests/browser/pilot.spec.js
tests/unit/pilot-axes.test.js
tests/unit/pilot-controller.test.js
```

`.claude/launch.json` is dirty from Stage 1 frontend work, not from Stage 2. Do not discard it casually. Root `package.json` and `docs/UI_REDESIGN.md` contain frontend-migration changes as well as sharing the dirty worktree.

### Deferred functionality

- Stage 2B: manual polygon creation, boundary editing, and robust draw-state lifecycle.
- Cross-store-safe deletion policy and implementation.
- Field-ID rename with reference cascade.
- Saving an open boundary track rather than a polygon.
- Concurrent same-origin `/new/` or desktop mounting.
- All Survey/GNSS, Water, observations, AI, reports, missions, and drone-control migration work.

### Recommended next step

Do not start automatically. When authorized, decide between:

1. a small Stage 2B design pass for correct manual-polygon semantics and cross-store deletion policy; or
2. Stage 3 Survey/GNSS, which is the natural producer of real field boundaries and can reuse the existing framework-independent NMEA/store modules.

Before either, decide the simultaneous same-origin `/new/` mounting strategy so legacy and React can be compared against one live store without stopping one server.

### Unresolved questions

- Where should the built React app be mounted for concurrent same-origin operation: `/new/` beside legacy, or eventually at `/`?
- For each non-annotation reference to a removed field, should deletion cascade, unlink, retain a tombstone, or remain prohibited?
- Should Stage 2B manual map clicks be modeled as explicit polygon vertices, rather than reusing walked-track closure-gap semantics?
- When should field-ID rename and import/export schema compatibility be exposed in React?
