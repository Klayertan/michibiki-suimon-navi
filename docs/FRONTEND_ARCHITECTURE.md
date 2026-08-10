# Frontend Architecture — `frontend/` (through Stage 5B)

This documents the new React/TypeScript/Vite frontend, living at `frontend/` beside the existing static app (`index.html`, `css/`, `js/`, `data/` at the repository root). Stage 1 established the shell, Stage 2 added Field management, Stage 3A added read-only saved surveys, Stage 3B added live WebSerial/recording, Stage 3C bridged saved surveys into fields and field-aware observations, Stage 4A added the water foundation, Stage 4B added the gate decision/recommendation, Stage 5A added recording crash recovery, and Stage 5B added transient GNSS serial disconnect/reconnect reliability. See [`docs/UI_REDESIGN.md`](./UI_REDESIGN.md) for the Stage 0 audit and migration plan.

## Stage 5B — GNSS reconnect reliability

Stage 3B's `SerialGnssService` already silently retried every already-granted port on a manual `connect()` call, but nothing triggered that retry automatically, and a declared-but-dead `'stalled'` state sat unused in the type since Stage 3B. Stage 5B wires both up without adding a second serial service or a parallel connection concept.

### Disconnect classes, and which ones retry

| Class | What it is | Reconnects automatically? |
|---|---|---|
| A — device disconnect event | The browser's native `serial` `'disconnect'` event | Yes |
| B — read-loop failure | `reader.read()` rejects, or the stream ends without an event | Yes (same path as A) |
| C — malformed NMEA | One bad sentence | No — parser-level, unchanged since Stage 3B |
| D — stalled input | Port open, read loop healthy, no byte for 8s (`DEFAULT_STALL_TIMEOUT_MS`, reused from `js/recording/recording-core.js`'s `DEFAULT_DIAGNOSTIC_THRESHOLDS_MS.byteStallMs`) | No — the transport is fine; reopening a healthy port cannot make a receiver produce fixes it doesn't have |

### State machine

`GnssConnectionState` gained `'reconnecting'` and `'reconnect_required'` — no parallel `isReconnecting`/`connectionLost` booleans anywhere. `'stalled'` (declared in Stage 3B, never previously set) is now wired to a lightweight watchdog that tracks the last time any byte arrived and flips `connected ⇄ stalled` independently of the reconnect path — it never touches the port.

```
                     Class A/B loss                     bounded attempts exhausted
        connected ──────────────────────► reconnecting ─────────────────────────► reconnect_required
            ▲                                  │  ▲                                      │
            │        attempt succeeds          │  │ attempt fails, more remain           │
            └──────────────────────────────────┘  └──────────────────────────────────────┘
            ▲                                                                             │
            └───────────────────────── manual connect() / "Reconnect now" ────────────────┘
```

An explicit `disconnect()` always lands on plain `disconnected` and clears the retry target, so nothing automatic ever follows a deliberate user action.

### Retry policy

Bounded, capped-exponential: `[1000, 2000, 4000, 8000]` ms, four attempts, ~15s worst case, injectable via the constructor for tests. Automatic reconnect retries **only the specific port (`lastPort`) that was already open** — it never calls `getPorts()`/`requestPort()` itself, so it can neither trigger a permission prompt nor arbitrarily pick a different granted device when more than one exists. A generation counter guards the race between a manual action and a pending automatic attempt: whichever wins closes what the other one just opened rather than leaving two live ports.

### Recording continuity — a guarantee that mostly already existed

`ingest()` only ever fires while a read loop is delivering lines; nothing calls it during a disconnect, so `RecordingService`'s monotonic `seq` counter is simply untouched by the gap — no reset, no duplicate, no loss, by construction. Stage 5B's contribution here is proof (a unit-level integration test wiring a real `SerialGnssService` to a real `RecordingService`, plus three Playwright cases covering a single cycle, repeated cycles, and Resume-then-reconnect), and one real messaging fix: `RecordingService.setConnectionMeta()` now distinguishes `reconnecting` (with the live attempt count), `reconnect_required`, `stalled`, and a plain disconnect, instead of one generic warning for all of them. `Stop Recording` was already independent of connection state and remains so — proven directly rather than assumed.

### Stale-fix gating — closing a real gap in Stage 3C/4A code

`ObservationComposer` and `WaterControlComposer`'s "Use Current GNSS" buttons previously disabled only on `!currentFix`. Both now call the exact legacy gate (`validateObservationCreation()`/`isFixStale()` from `js/recording/recording-core.js`, `DEFAULT_FIX_STALE_MS = 10000`) instead of a re-derived rule. This specifically matters for `'stalled'`: `currentFix` is deliberately preserved (not cleared) while stalled, so a bare null-check would have let an operator record a position from a fix that stopped updating minutes ago. Both components now also subscribe to `connectionState` (not just `currentFix`) so they re-render the instant a stalled transition makes an unchanged fix newly stale.

### UI

```
useLiveGnssStore ──► SurveyInspector ──┬──► "Connect GNSS" / "Reconnect GNSS" (state-aware label)
                                        └──► GnssReconnectBanner (presentational; reconnecting/reconnect_required only)
                                                   │
                                    onReconnect ───┘──► serialGnssService.connect()
                                    onStopRecording ──► recordingService.stop()
```

`GnssReconnectBanner` follows Stage 5A's `RecoveryPanel` pattern exactly: props in, callbacks out, renders nothing outside its two target states, and is unit-testable without any SerialPort at all. It shows only inside the existing Survey inspector — no full-page workflow, no blocking modal — so Survey stays map-first even mid-retry.

The status bar (`useGnssRuntime.ts`'s `publishSerialStatus`, now exported for direct testing) maps `reconnecting`/`reconnect_required`/`stalled` to their own `warning` badges with the attempt count in the detail text, distinct from a plain `disconnected`.

### Stage 5B safety boundary

No IndexedDB schema change, no automatic session resume, no automatic permission prompt, no Wake Lock, no legacy `js/` file touched, no backend file touched.

## Stage 5A — recording crash recovery

Stage 3B could *detect* that an unfinished IndexedDB session existed (it blocked starting a new one) but offered no way to resolve it. Stage 5A closes that gap without adding a second recording system: the existing `RecordingService` singleton gained four methods, and the existing legacy state machine supplied the vocabulary.

### "Unfinished" is defined by the existing store, not by this stage

`RecordingStore.listUnfinishedSessions()` (`js/recording/recording-store.js:131`) already answers this: `status === "recording" || status === "paused"`. React writes only `"recording"`/`"stopped"`, but the unmodified query is used, so a legacy-created *paused* session is detected too. There is no heartbeat, no crash flag, and no timestamp heuristic — a session is unfinished precisely because nothing ever wrote `"stopped"` to it.

### No schema change

`suimon-navi-recording` v1 is untouched — same DB name, version, five object stores, keyPaths, indexes, and field names. Recovery reads only fields `recording-controller.js` already writes. This is verified rather than assumed: a Playwright fixture seeds a session shaped exactly as the legacy controller would have written it and proves React detects and finalizes it, after which the full 14-case legacy recording browser suite still passes against the same database.

### State machine — reused, not duplicated

`RecordingState` gained `'recovery_available'`, which is **not new**: `js/recording/recording-core.js` already lists it in `RECORDING_STATES` with transitions `recovery_available → {resume, finish, delete}`. React now speaks the same vocabulary.

```
                 checkForRecovery() finds candidates
        idle ──────────────────────────────────────► recovery_available
          ▲                                            │      │      │
          │   checkForRecovery() finds none left       │      │      │
          └────────────────────────────────────────────┘      │      │
                                    resumeRecovery() ──────────┘      │
                                          │                           │
                                          ▼          finalizeRecovery()
                                      recording ──────────► stopped
```

Two invariants the code enforces structurally:

- **`recovery_available` is entered only from `idle`** and released back to `idle` only when the last candidate is resolved. A background scan can never overwrite an in-flight recording or an error state, and `recording` + `recoveryRequired` can never both be true.
- **`recoveryInProgress` is checked synchronously before any `await`**, so a double-click cannot race two resumes against the same session. Legacy has the identical guard.

Both directions of the idle transition matter. The initial implementation had only the forward one, which left the app permanently unable to start a new recording after finalizing a session inherited from a previous page load — see `docs/HANDOFF.md` §2.9.

### Sequence integrity

`rawNmeaLines` and `structuredFixes` share **one** monotonic per-session `seq`. `resumeRecovery()` sets `this.seq = await store.getMaxSeq(sessionId)` — the max across both stores — and never resets to zero, so post-resume records cannot collide with pre-crash ones.

Counters are handled differently from the counter *display*, deliberately:

| Value | Source | Why |
|---|---|---|
| Resumed `pointCount`/`lineCount` | The session record's own `validFixCount`/`totalReceivedLines` | Mirrors legacy's `resumeSession()` exactly, including its staleness tradeoff. A "more correct" recount would make React and legacy disagree about the same session. |
| Recovery card's "Raw lines saved" | A live `countRawLines()` query | Matches legacy's own `recoveryLineCounts` display mechanism. |

### Resume does not touch the transport

`resumeRecovery()` opens no port, prompts for no permission, starts no reconnect, and takes no wake lock. Resuming restores recording state; connecting GNSS stays a separate explicit action — the same separation legacy documents in its own resume path. A unit test and a Playwright assertion both pin it.

### Failing closed

Every recovery method catches, reports, and returns `false` rather than claiming success. A failed *scan* is reported distinctly from "nothing to recover" — those are different facts. On any storage failure the original session record is left exactly as it was, and no "recovered successfully" state is ever entered.

`adaptRecoverableSession()` is a pure, exported, never-throwing adapter. It drops a candidate **only** when `sessionId` is missing or unusable (no action could safely target it); everything else degrades to a safe default — malformed timestamps to `null`, a non-numeric count to `0`, a fix with non-finite coordinates to `null`. Dropped candidates are counted and surfaced, never silently hidden. Detection performs no writes.

A stale field link is preserved, not cleared: if `fieldId` names a field that no longer exists, the card renders `Linked field no longer exists (<fieldId>)`.

### Discard is destructive and that was proven safe first

Unlike Stage 2's deferred field deletion, Discard shipped — because `RecordingStore.deleteSession()` (`recording-store.js:136`) opens one transaction across all five stores and cascades via `deleteByIndexCursor` on `by_sessionId` for raw lines, structured fixes, marked observations, and image blobs. Nothing can be orphaned. That was read in source before the UI exposed the action. The UI requires a two-step inline confirmation rather than `window.confirm()`, because the panel can list several sessions and a native modal gives no indication which one it targets.

### UI and map ownership

```
useGnssRuntime (app root)  ──► recordingService.checkForRecovery()   once per app load
                                        │
                              RecordingSnapshot.recoverySessions
                                        │
SurveyInspector ──► RecoveryPanel (presentational; props in, callbacks out)
                                        │
                       resumeRecovery / finalizeRecovery / discardRecovery
```

`RecoveryPanel` reads no service or store directly (only `useFields()` for a field name), which is why its rendering and interaction logic is unit-testable in jsdom with no IndexedDB at all — the repository has no `fake-indexeddb` polyfill, so anything requiring real IndexedDB must go through Playwright. `SurveyInspector` owns the wiring to the real singleton.

The panel is a compact card list inside the existing inspector, not a new full-page workflow; Survey stays map-first at 1366×768, 1920×1080, and 1024×768 with no document-level scrolling. The status bar reuses the existing `recording` slot with a `warning` tone and the message `RECOVERY REQUIRED` rather than inventing a subsystem category — and never reports recording as actively running merely because an unfinished record exists.

On the map, `resumeRecovery()` fires a `{type: 'start'}` live-track event, which clears `LiveSurveyLayer`'s stale in-memory polyline so the resumed portion begins a fresh segment. The persisted pre-crash portion is drawn by `SurveyLayer` from storage, so the two coexist without duplication, and no map instance or `LayerGroup` is recreated.

### Stage 5A safety boundary

No schema migration, no automatic resume, no silent discard, no automatic serial reconnect, no retry loop, no wake lock, no hardware access. No legacy `js/` file, backend file, or pilot/MAVLink file was modified.

## Stage 4B — gate decision

`evaluateGate()` is unlike every domain function wrapped so far: it has no export boundary to import through at all. It lives inline inside `index.html`'s ~3,270-line monolithic `<script>` (`index.html:3672-3710`), so `frontend/src/domain/water/decision.ts` hand-transcribes it — same branch order, same `>=` comparisons at every threshold, same Japanese output strings — rather than importing it via the `@legacy` alias pattern Stages 1-4A established. Because no legacy unit test of this function exists anywhere in the repository, the transcription is pinned by tests that reproduce the legacy source's literal expected outputs directly (documented in the file's own header), not by cross-executing against a legacy reference.

**Inputs and units** (see `docs/HANDOFF.md` §2.2 for the full provenance table): `rain24hMm`/`daysSinceRain`/`forecastRainProbPct` are operator-editable, prefilled from a build-time import of `data/weather.json`; the four thresholds (`heavyRain24hMm`/`lightRain24hMm`/`forecastRainProbPct`/`drySpellDays`) are shown read-only, sourced from a build-time import of `data/gate_rules.json`. A new `@data` Vite/TS alias (`vite.config.ts`, `tsconfig.app.json`) resolves both, mirroring the existing `@legacy` alias exactly. This is a **build-time read**, unlike legacy's runtime `fetch()` of the same files — the only behavior this could change (a fetch failure falling back to a hardcoded default) cannot happen for a bundled JSON import, so it isn't reproduced; `frontend/src/domain/water/gateRules.ts` documents the resulting per-field fallback semantics precisely.

**Two audited traps are structurally impossible to violate, not just avoided by convention:**
- The legacy "判断プロファイル" (decision profile) selector is confirmed display-only at two independent legacy call sites and has no React counterpart at all; `evaluateGate.length === 2` is asserted by a test, so an accidental future profile parameter fails immediately rather than silently changing behavior.
- Stage 4A's water data (control points, level readings) cannot reach this function — `GateDecisionPanel` never imports either water repository, and a test proves an identical verdict whether the panel is told 0 or 3 contextual readings exist for the active field. Where readings are surfaced nearby, the UI text is explicit: "Context only — not used by this recommendation."

**Architecture:**

```
data/gate_rules.json   data/weather.json        (@data alias, build-time import)
       │                      │
resolveGateThresholds   resolveDefaultWeather     domain/water/gateRules.ts
       │                      │
       └──────────┬───────────┘
                   │
         evaluateGate(weather, thresholds)         domain/water/decision.ts (hand-ported)
                   │
            GateDecisionPanel                      features/water/ (local useState only)
                   │
              WaterWorkspace                       mounted above the Stage 4A sections
```

`GateDecisionPanel` is field-independent (legacy's own decision inputs are one global configuration, not one per field) and touches no map, no `MapContext`, and no Leaflet API — it cannot recreate the map by construction, which a dedicated test also verifies directly (typing in the rainfall field while Field/Water map layers are mounted leaves the map DOM node and every layer's `LayerGroup` count unchanged). No persistence, no new repository, no new Zustand store, and no new `SelectedEntity` member were introduced — this is the smallest-footprint stage of the migration by file count.

**Deliberately not reproduced:** legacy's in-app "what-if" threshold override UI (explicitly framed by legacy itself as temporary, layered on top of the authoritative JSON file) and the Open-Meteo live weather auto-fetch (a separate, DOM-coupled function that would additionally require reproducing legacy's `activeGate()`/`surveyedGate` position-resolution concept, which has no React equivalent). Both are documented as deferred in `docs/HANDOFF.md` §2.7, not silently dropped.

**Safety boundary:** no gate/actuator/MAVLink/backend command was added or considered. The panel is purely informational, matching the task's explicit separation between a recommendation (判断) and a physical command (制御).

## Stage 4A — water foundation

### Water is two unrelated persisted things

The single most important finding of the Stage 4A audit, and the thing that shapes every decision below:

| | Water control point | Water level reading |
|---|---|---|
| What it is | A *location* — 水門 / 給水口 / 排水口 / 水位センサ / 撮影地点 | A *reading* — a number captured at a position and time |
| Storage | `localStorage["suimonNaviFieldAnnotationsV2"].waterControlPoints` | IndexedDB `suimon-navi-recording` v1, store `markedObservations`, `observationType === "water_level"` |
| Builder | `buildWaterControlPoint()` (`js/fields/field-annotation-core.js:323-342`) | `buildMarkedObservation()` (`js/recording/recording-core.js:197-225`) |
| Coordinates | `coordinates: [lat, lon]` tuple | named `latitude` / `longitude` |
| Field link | **`relatedFieldId`** | `fieldId` |
| Owner | Standalone; unlinked when its field is deleted | Child of a recording session; cascade-deleted with it |

Nothing links the two. A 水位センサ control point marks *where a sensor sits*; it carries no reading. They are therefore modelled as two domain types, two repositories, two map layers and two selected-entity types — never merged into one ambiguous "water" entity.

### What Stage 4A migrated, and what it deliberately did not

- **Water control points — read + create.** `LegacyWaterControlRepository` (`frontend/src/services/water/legacyWaterControlRepository.ts`) is `list`/`get`/`create` only, mirroring Stage 3C's observation repository: same fail-closed rules, same snapshot-carried read error, same explicit seven-key write. Creation delegates record construction, naming and ids to the unchanged `buildWaterControlPoint()`, `nextWaterControlName()` and `makeId('wcp')`.
- **Water level readings — read only.** `RecordedWaterMeasurementRepository` reads them through the unchanged `RecordingStore.readAll()`. **No creation.** A reading is a child of a recording session and legacy only ever builds one from a validated, non-stale live fix, filling `fixQuality`/`hdop`/`satelliteCount`/`rawSourceSentence` from it. A map click has no such provenance, and fabricating it is exactly what this migration forbids. There is also no unit in the schema (see below).
- **No update, no delete, anywhere in water.** Legacy water-point deletion is a bare identity filter with no cascade, but `js/reports/field-report.js:225` and `index.html:3822` read that same array live. Stage 2 already established that destructive operations wait for a cross-store reference policy.

### Compatibility rules the code and tests pin

- **`type` persists the LONG exported string** — `water_gate`, `water_inlet`, `water_outlet`, `water_level_sensor`, `photo_point`. The short keys (`gate`, …) drive labels and styling only. This is the opposite of field observations, which persist the *short* key plus a `label`. A water point has **no `label` key**.
- **Coordinates are `[lat, lon]`**, Leaflet order, never GeoJSON.
- **The field link is `relatedFieldId`**, unlike every sibling collection.
- **All seven root keys** (`schemaVersion`, `fields`, `boundaryTracks`, `waterControlPoints`, `surveySessions`, `fieldObservations`, `workflowState`) are written from an explicit literal, and sibling datasets round-trip untouched. Reads never rewrite storage. Writes fail closed on a malformed store, an unsupported `schemaVersion`, or *any* of the five arrays being malformed — including ones water does not own, because writing would persist a silently normalized version of them.
- **An unknown type normalizes to `gate`**, matching `normalizeWaterControlType()`, rather than being dropped.
- **`properties.updatedAt` is not durable.** Legacy rehydration re-runs every stored point through the builder with `nowIso: properties.createdAt`, resetting `updatedAt` on each page load. No UI or test depends on an edit timestamp surviving a reload.

### Two legacy behaviours that surprised the audit

1. **There is no outside-field check for water.** `isPointInsideBoundary` is called exactly once in the entire 1,928-line legacy controller — inside the *observation* map-click handler. Water placement (`createWaterControlPoint`, `js/fields/field-annotation-controller.js:833`) persists unconditionally. Stage 4A therefore does **not** add a Save-Anyway gate for water; it shows a non-blocking note so the position is not accepted *silently*, and saves normally. Adding a block would have invented semantics.
2. **A stored `waterLevel` of `0` is ambiguous, and common.** The builder's default parameter is `waterLevel = null`, and `Number(null) === 0` passes its finiteness check — so a blank legacy input *and* an omitted argument both persist as `0`. A stored `null` only occurs for a non-numeric value. The adapter preserves the raw value and the inspector explains a zero rather than presenting it as a measured depth. (The Stage 4A audit's own first pass got this partly wrong; a test pins the real behaviour.)

### Units

The reading carries **no unit anywhere in the persisted schema**. "cm" appears only in a legacy input label (`index.html:2705`) and in no code or test. Stage 4A therefore renders readings as `"<value> (unit not recorded)"` and performs no conversion, and a test asserts no selector ever emits `cm`/`mm`.

### Map, state and selection

`WaterControlLayer`, `WaterMeasurementLayer` and `WaterPlacementLayer` each own a long-lived `L.LayerGroup` whose lifetime is tied only to the map instance, alongside Field/Survey/live-GNSS/Observation layers on the one `MapWorkspace` map. Symbols are shape- and glyph-coded, not colour-only: control points are squares carrying `G`/`I`/`O`/`S`/`P`, readings are diamonds carrying `L`; fills reuse the legacy `WATER_CONTROL_STYLES` palette. Visibility is driven by `useMapLayersStore` ids `water-points` and the new `water-measurements`.

`SelectedEntity` gained `waterControl` and `waterMeasurement`, replacing the never-backed `water`/`sluice` placeholders from Stage 1. Active field remains `useActiveFieldStore` — no separate "water active field" concept was introduced, because the legacy domain has none.

### Stage 4A safety boundary

No decision/recommendation logic was migrated or altered, no agronomic threshold was added or changed, `js/paddy-intelligence.js` was not touched, and no backend, MAVLink, pilot or flight-control file was modified.

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
