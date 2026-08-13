# Frontend migration handoff

Updated: 2026-08-09 (Asia/Tokyo)

## 1. Current migration stage

**Stage 5C (field-session resilience / Screen Wake Lock) is complete.** An active GNSS recording now holds a standard Screen Wake Lock for as long as it is genuinely recording — not merely because Survey is open, GNSS is connected, or an unresolved recovery is showing — and releases it the instant recording stops. A temporary loss of the lock (tab hidden, or the browser taking it away on its own) never pauses or fails the recording; reacquisition happens only when the tab becomes visible again and recording is still active, with no polling and no uncontrolled retry loop. An unsupported browser or a rejected request degrades to a compact, non-blocking status — recording is never gated on it. Stop here. No Stage 6 has been scoped yet; see §2.16 for an analysis of Data/Reports as the likely next candidate.

Stage 5B (bounded, single-port automatic WebSerial reconnect) and Stage 5A (recording crash recovery — Resume/Finish & Save/Discard for an unfinished session after a reload or crash) remain complete and untouched by this stage. Stage 4B (water decision/recommendation) and Stage 4A (water foundation) remain complete and untouched. Stages 0–3C remain as previously recorded; all checkpoints are preserved further down this document.

The legacy static app remains intact. The default legacy (`localhost:4173`) and React (`localhost:5173`) dev servers use different browser storage partitions. For a real same-data check, stop the legacy server and run `npm run dev:new-ui:shared-storage`; React then runs sequentially on the exact legacy `http://localhost:4173` origin and reads the same localStorage. A simultaneous `/new/` mount is still unresolved.

## Manual Control checkpoint (parallel legacy UI/backend work)

This checkpoint is independent of the React Water migration recorded below. No Water, Stage 4A/4B/5, React source, persistence contract, or migration decision was changed for Manual Control.

- **Root cause corrected:** the former keyboard pilot path fed normalized axes into `send_velocity_setpoint()` / `SET_POSITION_TARGET_LOCAL_NED`. That transport is Guided external control, so STABILIZE correctly produced `Blocked: Not in GUIDED mode` and no transmission. Removing only the mode check would not have made a Guided velocity target behave like an RC stick.
- **Transport split:** legacy Manual Control now owns `RC_CHANNELS_OVERRIDE`; `send_velocity_setpoint()` remains isolated on the MAVLink interface for a future Guided external-control consumer and is not called by the Manual Control panel.
- **One input architecture:** the legacy page has one `手動操縦 / Manual Control` card and one source selector (`Keyboard` / `PS5 Controller`). The transport-free `js/gamepad/` providers own browser input and PS5 calibration; both publish the same `pitch/roll/throttle/yaw`, provider-level `deadmanHeld`, connection/calibration/staleness state to the common `PilotController`. Keyboard digital input is quarter-stick. PS5 uses saved Mode 2 axis/dead-man mapping rather than a backend button index.
- **Vehicle-derived RC mapping:** after HEARTBEAT the backend read-requests, but never writes, `RCMAP_*`, `RC1..8_MIN/TRIM/MAX/REVERSED`, `RC_OVERRIDE_TIME`, `RC_OPTIONS`, and legacy/new GCS source-ID parameters. Primary axes use the reported RCMAP and calibration. STABILIZE throttle zero is the low-stick endpoint; ALT_HOLD zero is the calibrated range midpoint. Unowned active CH1-8 fields are `65535` (ignore); release is all eight fields `0` (return ownership to normal RC input).
- **Fail closed:** missing/invalid calibration or mapping, disabled/infinite/non-finite/too-short override timeout, ignored overrides, missing or mismatched GCS source-ID range, wrong mode, unknown/disarmed vehicle, stale link/input, released dead-man, a simulated provider against real mode, or disabled Pilot all prevent active output. Manual modes are STABILIZE and ALT_HOLD; enable never changes mode. A finite autopilot-side `RC_OVERRIDE_TIME` with cadence margin is mandatory and is never rewritten.
- **Release discipline:** dead-man, focus/tab/page loss, source/provider/controller/WebSocket/MAVLink disconnect, telemetry/input staleness, Space, Escape, disable, transmit failure, and DISARM clear desired movement and output-active state. Writable links receive all-zero releases repeatedly; graceful link close attempts a release burst. Sequence high-water state rejects delayed/replayed frames; safety recovery requires a dead-man release/re-press, and a new transport session discards all previous telemetry/RC parameters before reacquisition.
- **Normal ARM/DISARM only:** `/api/drone/arm` and `/api/drone/disarm` require `{confirmed:true}`, safe commands, a fresh link, MAVLink command 400 with `param2=0`, accepted ACK, and matching HEARTBEAT state. ARM additionally requires the Pilot channel, valid RC configuration/manual mode, known DISARMED state, and stored props acknowledgement in Bench Mode. DISARM remains available after Pilot disable. The force value `21196`, pre-arm bypass, failsafe weakening, and automatic parameter changes are absent.
- **Validation boundary:** the automated operator flow uses the mock backend and simulated PS5 only. No COM10, real Pixhawk, physical DualSense, motor, propeller, hover, or flight validation is claimed. The first real step is the exact 15-step propellers-removed procedure in `docs/PILOT_CONTROL_GUIDE.md`; a rejected pre-arm check must never be bypassed.

## 2. Stage 5C completion checkpoint

### 2.1 Architecture — a narrow service, not calls scattered through components

`WakeLockService` (`frontend/src/services/wakeLock/wakeLockService.ts`) wraps `navigator.wakeLock.request("screen")` behind exactly four members: `request()`, `release()`, `getSnapshot()`, `isWanted()`. It knows nothing about recording, GNSS, or recovery — the same separation Stage 3B/5A/5B already established between `SerialGnssService` and `RecordingService`. All orchestration — *when* to call `request()`/`release()` — lives in one small hook, `useWakeLockRuntime` (`frontend/src/services/wakeLock/useWakeLockRuntime.ts`), mounted once at the app root beside `useGnssRuntime()`.

```
useWakeLockRuntime (app root, mounted once)
   ├─ subscribes to RecordingService.subscribe()
   │     state edge-transitions into 'recording'  → wakeLockService.request()
   │     state edge-transitions out of 'recording' → wakeLockService.release()
   ├─ subscribes to WakeLockService.subscribe()  → publishes the "Screen" status badge
   └─ one document.visibilitychange listener
         visible AND still recording AND isWanted() → wakeLockService.request()
```

Legacy already has an equivalent (`recording-controller.js`'s `requestWakeLock()`/`releaseWakeLock()`/`handleVisibilityChange()`, using `wakeLockSupported = "wakeLock" in navigator` and a `#recWakeLockStatus` display of 非対応/有効/無効); this stage is a fresh TypeScript implementation of the same lifecycle, not a port, since the legacy version is inline inside `recording-controller.js`'s monolithic class rather than an exported pure function.

### 2.2 Acquisition — recording-lifecycle only, nothing else

A lock is requested **only** on a genuine `RecordingState` transition into `'recording'` — captured as an edge (`wasRecording` false → true), not a level, so repeated snapshot notifications while already recording (every ingested point re-notifies subscribers) never re-request. Both paths that reach `'recording'` — a fresh `start()` and a successful `resumeRecovery()` — trigger it identically, since both simply set the same state; no special-casing per method was needed.

Explicitly does **not** acquire merely because:
- the Survey workspace is open,
- GNSS is connected,
- an unfinished session exists,
- `recovery_available` (Recovery Required) is showing.

Each of these is pinned by a dedicated test in `useWakeLockRuntime.test.tsx`.

### 2.3 Release — the instant recording leaves the active state

Symmetric with acquisition: release fires on the edge transition *out of* `'recording'` — Stop, Finish & Save of the active session, Discard of the active session, or an error transition all leave `'recording'`, and all are covered by the same one check rather than one handler per action. Release happens as soon as `stop()` sets state to `'stopping'` (immediately, not after the flush completes) — data-safety never depends on the lock (§2.8), so there is no reason to hold it through the drain.

### 2.4 Visibility handling — event-driven, not polled

The Screen Wake Lock spec allows (and Chromium does) release a lock automatically when the document becomes hidden. `useWakeLockRuntime` installs exactly one `document.visibilitychange` listener for the lifetime of the app. On `visible`, it re-requests **only if** `recordingService.getSnapshot().state === 'recording'` **and** `wakeLockService.isWanted()` — the latter distinguishes "the operator still wants this held" (recording never stopped) from "the operator released it on purpose" (recording stopped while hidden, so `isWanted()` is already `false` and nothing reacquires on return). No interval, no repeated polling of the sentinel's state anywhere in the implementation — task section 18's explicit constraint.

### 2.5 The sentinel `release` event — status only, never a retry trigger

`WakeLockService`'s own listener on the sentinel's `release` event does exactly one thing: transition its internal state to `'released'` and notify subscribers. It never calls `request()` itself. This is deliberate and tested (`wakeLockService.test.ts`): the *only* code path that ever re-requests after an unsolicited release is `useWakeLockRuntime`'s `visibilitychange` handler, which only fires on an actual visibility change — so a burst of spurious `release` events (were the browser to produce one) can never trigger a retry storm.

### 2.6 Unsupported browsers and request failures — both non-fatal, both compact

If `navigator.wakeLock` doesn't exist, `WakeLockService`'s constructor sets state to `'unsupported'` permanently; `request()` becomes a safe no-op that still records the caller's intent (`isWanted()` still flips true) but never throws. If `navigator.wakeLock.request()` itself rejects (browser policy, permissions, battery/system restriction, or an implementation-specific error), state becomes `'error'` with the message preserved — again, never thrown up to the caller. Neither condition disables **Start Recording**, and neither is rendered as an `alert`/blocking dialog: both show as a single `role="status"` line in the Survey inspector —

> Screen keep-awake unavailable. Recording will continue; prevent the device from sleeping manually.

or

> Keep-awake request failed. Recording is still active.

### 2.7 Recording remains authoritative — proven, not assumed

`RecordingService` has zero import of, or reference to, `wakeLockService` anywhere in its source — the coupling is structurally one-directional (`useWakeLockRuntime` reads `RecordingService`, never the reverse), so "wake lock state cannot affect recording correctness" is true by construction. A dedicated test still drives the point home directly: it forces `WakeLockService` into an `'error'` state while a recording is active and asserts `RecordingService.stop()` is never called and the recording's own state never changes as a result (task section 14's exact example: "Recording = active, Wake Lock = error, and data continues to persist normally").

### 2.8 Interaction with Stage 5B and Stage 5A — independent axes, verified independently

- **Stage 5B (GNSS reconnect):** the wake lock is tied to the *recording* lifecycle, not the *serial connection* lifecycle. A test starts a recording, drives `RecordingService.setConnectionMeta()` through a reconnect-interruption warning exactly as Stage 5B's own UI would, and asserts `wakeLockService.release()` is never called — `recording active / GNSS reconnecting / wake lock active` is a valid, expected combination, not a bug.
- **Stage 5A (recovery):** `checkForRecovery()` and an unresolved `recovery_available` state never acquire a lock — proven directly, not just by absence of a call site. Only after the operator explicitly clicks **Resume**, landing on the same `'recording'` state a fresh Start reaches, does the lock get requested — exactly the same edge-transition rule as §2.2, applied uniformly rather than special-cased for the recovery path.

### 2.9 Status bar and Survey workspace UX

A new `wakeLock` `ServiceId` drives a compact "Screen" badge in the existing top status bar (`TopStatusBar.tsx`'s `ORDER` array, right after `recording`) — no new panel. Values: `connected`/"Awake" while active and recording, `warning`/"Reconnecting-style" text while `released` or `error`, `warning`/"Keep-awake unsupported" when the browser lacks the API (shown regardless of recording state, since it's worth knowing proactively), and `disconnected` whenever not recording.

Inside the Survey inspector, one new row was added to the *existing* `survey-recording` metrics list — `Keep screen awake: ● Active` / `Unavailable` / `Reacquiring…` / `Failed` / `—` — no new section, no enlarged control area (viewport-tested).

### 2.10 What the Screen Wake Lock API does *not* do — stated precisely, nothing invented

Screen Wake Lock can request that the display stay on. Nothing in this stage claims it can guarantee Windows/macOS won't sleep, that a laptop lid close is ignored, that OS suspend is disabled, that battery depletion cannot occur, or that the browser process cannot be killed. No `powercfg`, `caffeinate`, or other platform shell command was added anywhere — Stage 5C is browser-API-level only, exactly as scoped.

### 2.11 Exact Stage 5C changed files

New:
```text
frontend/src/services/wakeLock/wakeLockService.ts
frontend/src/services/wakeLock/useWakeLockRuntime.ts
frontend/src/services/wakeLock/__tests__/wakeLockService.test.ts
frontend/src/services/wakeLock/__tests__/useWakeLockRuntime.test.tsx
frontend/tests/browser/wakelock.spec.ts
```

Modified:
```text
docs/HANDOFF.md
docs/FRONTEND_ARCHITECTURE.md
docs/UI_REDESIGN.md
frontend/src/app/App.tsx                                          (mounts useWakeLockRuntime)
frontend/src/types/systemStatus.ts                                (+'wakeLock' ServiceId)
frontend/src/store/useSystemStatusStore.ts                        (+wakeLock initial status)
frontend/src/store/__tests__/useSystemStatusStore.test.ts         (+1 assertion)
frontend/src/components/layout/TopStatusBar.tsx                   (+wakeLock in ORDER)
frontend/src/features/survey/SurveyInspector.tsx                  ("Keep screen awake" row + notices)
frontend/src/features/survey/__tests__/SurveyInspector.test.tsx   (+5 tests)
```

No legacy `js/` file, no backend file, no pilot/MAVLink file, and no IndexedDB schema definition was modified. No changes to Stage 5A or Stage 5B semantics.

### 2.12 Stage 5C verification results

| Check | Result |
|---|---|
| `npm test` in `frontend/` | **44 files, 296/296 passed** (Stage 5B end: 41 files, 249) |
| `npm test` at repository root | **219/219 passed** (Stage 5B end: 216 — the +3 delta is concurrent pilot work; Stage 5C added no root-level test) |
| Legacy recording browser, `npx playwright test tests/browser/recording.spec.js` | **13/14 passed** — the same isolated failure reported at the end of Stage 5B (`an interrupted session survives reload...`, a timing assertion against the legacy static app's `index.html`, which Stage 5C did not touch either). Unchanged in nature, not newly introduced. |
| React acceptance, `npx playwright test` in `frontend/` | **18/18 passed** (14 pre-existing + 4 new Stage 5C) |
| `npx tsc -b` | passed |
| `npx vite build` | passed |
| `npm run lint` | passed with the one pre-existing `routes.tsx` warning; Stage 5C adds none |
| `git diff --check` | clean |
| Backend pytest | **Not run.** Stage 5C changed no backend/API/MAVLink/command file. |

Failure classification: **no Stage 5C regression** in any suite covering code this stage touched. The one legacy-suite failure is the same pre-existing issue already isolated and described at the end of Stage 5B, in a file this stage did not modify.

Viewport acceptance, asserted with an active recording (and therefore an active wake lock) at **1366×768, 1920×1080, and 1024×768**: no document-level scrolling, and the recording control area's height stays within a generous bound that would catch an accidental new panel while tolerating normal layout variance — the "Keep screen awake" row is one line inside the existing metrics list, not a new section.

### 2.13 Test coverage map

| Requirement | Where proven |
|---|---|
| Unsupported browser still records normally | `wakeLockService.test.ts`; `wakelock.spec.ts` |
| Request on record-start, released on stop, no redundant re-request | `wakeLockService.test.ts`; `useWakeLockRuntime.test.tsx` |
| Hidden tab: no unsafe repeated requests; visible-again reacquire only if still recording | `useWakeLockRuntime.test.tsx`; `wakelock.spec.ts` |
| Stopped-while-hidden: no reacquire on return | `useWakeLockRuntime.test.tsx`; `wakelock.spec.ts` |
| Sentinel unexpectedly releases: status updates, no self-triggered retry | `wakeLockService.test.ts` |
| Request rejection is non-fatal | `wakeLockService.test.ts`; `SurveyInspector.test.tsx` |
| Repeated start/stop cycles: no leaked sentinels/listeners, exact call counts | `wakeLockService.test.ts`; `useWakeLockRuntime.test.tsx` |
| Recording remains authoritative over wake lock state | `useWakeLockRuntime.test.tsx` (task section 14, direct proof) |
| Independent of Stage 5B GNSS reconnect | `useWakeLockRuntime.test.tsx` |
| Independent of Stage 5A recovery-required; requested after Resume | `useWakeLockRuntime.test.tsx` |
| Status bar and Survey workspace rendering, all states | `useWakeLockRuntime.test.tsx` (`publishWakeLockStatus`); `SurveyInspector.test.tsx` |
| Real-browser: full lifecycle, hidden/stopped-no-reacquire, unsupported path, viewports | `wakelock.spec.ts` (4 tests) |

### 2.14 Bundle size

| | Raw | Gzip |
|---|---|---|
| End of Stage 5B | 553.35 kB | 164.75 kB |
| End of Stage 5C | 558.37 kB | 166.04 kB |
| Delta | +5.02 kB | +1.29 kB |

### 2.15 Dirty files belonging to other work — do not touch

Concurrent pilot/manual-control/MAVLink work continued throughout this stage, and separately, an in-progress Stage-2B-adjacent field-boundary-area feature landed in `frontend/src/features/survey/__tests__/Stage3CWorkflow.test.tsx`/`SurveyInspector.css` mid-session from a different concurrent source — neither was authored, reviewed, or touched as part of Stage 5C. Everything under `backend/`, `js/pilot/`, `css/pilot.css`, `js/gamepad/`, `tests/unit/pilot-*.test.js`, `tests/unit/gamepad-*.test.js`, `tests/browser/manual-control-helpers.js`, `mock-manual-acceptance.html`, and the pilot/gamepad/MAVLink operator guides in `docs/` continues to belong to that separate work.

### 2.16 Recommended next step — analysis, not a decision

With Stage 5A, 5B, and 5C complete, the reliability layer the Stage 4B recommendation originally flagged (unrecoverable interrupted session; silent reconnect failure; screen sleep during a field survey) is now closed end to end. The app has Field + Survey/GNSS + Observations + Water + Decision + a complete reliability layer, and the next natural candidate is a coherent output layer over all of it:

- **Data + Reports** (the default candidate): `js/reports/field-report.js` already renders water control points and would be a natural next consumer of the now-typed `GateDecision` output (Stage 4B, §5.7 in this document's numbering) — read-heavy, low risk, and the first stage where the value of everything built so far (recordings, observations, water points, decisions) becomes visible to the farmer as one coherent output rather than four separate workspaces.
- **Paddy Intelligence**: the largest remaining legacy surface (1,929 lines, never modularized), but demo-only geometry today, not real field data — migrating it does not depend on anything built in Stages 4–5.
- **Stage 2B (boundary editing)**: a real gap (fields can only be created from a walked/uploaded track today, never hand-drawn or edited after the fact), but orthogonal to the reliability work just completed.
- **Observation photo/media support**: `markedObservations`' `imageRef` plumbing already exists in the legacy schema and recording store; React has never surfaced it.

No single option is blocked by another. Data + Reports has the strongest case: it is the first stage that makes the reliability investment of 5A–5C *visible* to the person actually using this app in a field, rather than adding another independent capability. This is analysis for the next authorization, not a decision — do not start any of it automatically.

## 3. Stage 5B completion checkpoint

### 3.1 Disconnect taxonomy — audited, not assumed

Stage 3B's `SerialGnssService` already had a "granted-port reconnect" path (`connect()` silently retries every port `navigator.serial.getPorts()` already knows about before ever calling `requestPort()`), but nothing triggered it automatically — any interruption, of any kind, landed on a bare `disconnected` and stayed there until the operator clicked Connect again. The audit found the class was declared but never wired: `GnssConnectionState` already listed `'stalled'` in Stage 3B, yet no code path ever set it.

Four classes, from the task brief, each handled differently on purpose:

| Class | Trigger | Stage 5B behavior |
|---|---|---|
| **A — physical/device disconnect** | The browser's native `serial` `'disconnect'` event fires for the currently-open port. | Automatic bounded reconnect (§3.3). |
| **B — read-loop failure** | `reader.read()` rejects, or the stream ends (`done: true`) without a device event. | Same automatic bounded reconnect — indistinguishable from A for retry purposes; only the surfaced message differs ("device disconnected" vs. "stream ended"). |
| **C — malformed NMEA** | One sentence fails to parse. | **Never triggers reconnect.** This is `handleLine()`'s existing per-sentence `malformed` counter, unchanged since Stage 3B — a bad sentence is a data-quality event, not a transport event. |
| **D — stalled input** | The port is open and the read loop is healthy, but no byte has arrived for `DEFAULT_STALL_TIMEOUT_MS` (8000ms, reused verbatim from `js/recording/recording-core.js`'s `DEFAULT_DIAGNOSTIC_THRESHOLDS_MS.byteStallMs` — not a new number). | **Never triggers reconnect either.** The transport itself is fine; closing and reopening a healthy port would not make a receiver produce fixes it doesn't have (e.g. no satellite lock indoors). Surfaced as its own `'stalled'` connection state; manual Reconnect remains available if the operator wants to force a cycle anyway. |

### 3.2 Reconnect state machine — one authoritative state, no parallel booleans

`GnssConnectionState` gained exactly two new values: `'reconnecting'` and `'reconnect_required'`. No `isConnected`/`isReconnecting`/`connectionLost` booleans were added anywhere — every consumer (the status bar, the Survey UI, `RecordingService.setConnectionMeta()`) branches on this one field.

```
                     Class A/B loss                     bounded attempts exhausted
        connected ──────────────────────► reconnecting ─────────────────────────► reconnect_required
            ▲                                  │  ▲                                      │
            │        attempt succeeds          │  │ attempt fails, more remain           │
            └──────────────────────────────────┘  └──────────────────────────────────────┘
            ▲                                                                             │
            └───────────────────────── manual connect()/Reconnect ───────────────────────-┘

        connected ⇄ stalled   (Class D — independent of the above; never touches the port)
```

`disconnect()` (the explicit, user-initiated action) always lands on plain `disconnected` and clears the retry target (`lastPort = null`), so a stray later event has nothing to act on — it can never be confused with an interruption the operator didn't ask for.

### 3.3 Retry policy — bounded, capped-exponential, against one specific port

Reconnect delays are `[1000, 2000, 4000, 8000]` ms (`DEFAULT_RECONNECT_DELAYS_MS`, `frontend/src/services/gnss/serialGnssService.ts`) — four attempts, worst case ~15s before giving up. This was not picked arbitrarily: it doubles each time (conservative enough not to hammer the device on a genuinely dead link) while still recovering a brief cable wiggle within a couple of seconds, and it is injectable via the constructor's `reconnectDelaysMs` option specifically so unit tests never wait out real wall-clock delays (they use `[5, 5, 5]`ms).

Automatic reconnect retries **only `lastPort`** — the exact `SerialPortLike` object the connection last succeeded on. It never calls `getPorts()` or `requestPort()` itself. Consequences:
- **No automatic permission prompts** (task section 4): `requestPort()` is a manual-`connect()`-only code path.
- **No arbitrary device selection with multiple granted ports** (task section 18): since the automatic path doesn't enumerate ports at all, there is no list to arbitrarily pick from — it either reopens the one specific port that was lost, or it doesn't reconnect automatically at all.
- A **generation counter** (`currentGeneration`) guards against a manual `connect()`/`disconnect()` racing a pending automatic attempt: every manual action and every new loss episode increments it, and a scheduled attempt checks its captured generation before acting (after its delay, and again after its own `await port.open()`) — a stale attempt that lost the race closes whatever it just opened rather than leaving two ports live.

### 3.4 Manual reconnect always wins

The existing "Connect GNSS" button is the same escape hatch during `reconnecting`/`reconnect_required` — it isn't blocked by the automatic retry (task section 7), and its label changes to **"Reconnect GNSS"** in those two states so the operator knows what it will do. Clicking it (or the reconnect banner's own **Reconnect now** button, which calls the identical `serialGnssService.connect()`) cancels any pending automatic timer immediately and proceeds through the normal granted-port-then-picker flow.

### 3.5 Recording continuity — mostly free, one real bug found

Ingest only ever happens through `serialGnssService.subscribeLines()` → `recordingService.ingest()` (wired once, at the app root, in `useGnssRuntime.ts`). While no read loop is active, nothing calls `ingest()` — so a disconnect **cannot** fabricate, duplicate, or lose a point by construction, and `RecordingService.seq` (the in-memory monotonic counter) is simply never touched during the gap. This is not new code; it was already true in Stage 3B/5A, and Stage 5B adds a unit test (`reconnectRecordingIntegration.test.ts`) and three Playwright cases that prove it end-to-end against a repeated disconnect/reconnect cycle, not just assert it by inspection.

What *did* need a code change: `RecordingService.setConnectionMeta()` previously wrote one generic "GNSS disconnected" warning for every non-connected state. It now distinguishes `reconnecting` (with the live attempt count), `reconnect_required`, `stalled`, and a plain disconnect — four distinct messages, all agreeing the session "remains open" and none ever implying it stopped. See `interruptionWarning()` in `recordingService.ts`.

**`Stop Recording` was already unconditional on connection state** (`stop()` only checks `RecordingService`'s own state, never `serialGnssService`'s) — confirmed by a dedicated test and by the Playwright case that stops mid-`reconnecting` and gets a normal, non-hanging finalize with no fabricated final fix.

### 3.6 Sequence guarantees, restated precisely

`rawNmeaLines` and `structuredFixes` share one monotonic per-session `seq`. Across any number of disconnect/reconnect cycles in the same page session (no reload):
- No reset to zero — the counter is a field on the live `RecordingService` instance, untouched by connection-state transitions.
- No duplicate `seq` — nothing appends while disconnected, so there is nothing to collide with on resume.
- No reuse — the same guarantee Stage 5A established for a crash+reload also composes with a disconnect that happens *before or after* a Resume: the recovery-plus-reconnect Playwright test proves the seeded pre-crash line, the Resume-time continuation, and the post-reconnect continuation all coexist exactly once.

### 3.7 Stale-fix behavior — a real gap this stage closed

The audit found `ObservationComposer` and `WaterControlComposer`'s "Use Current GNSS" buttons only ever checked `!currentFix` — never staleness. Legacy already has the authoritative gate for exactly this ("現在地を記録" / `js/recording/recording-core.js`'s `validateObservationCreation()` + `isFixStale()`, `DEFAULT_FIX_STALE_MS = 10000`), and both components now call it directly instead of re-deriving a rule. This matters specifically because of `'stalled'`: `currentFix` is deliberately **preserved** (not cleared) while stalled, so a null-check alone would have let an operator record a position from a fix that hasn't updated in minutes. Both composers now disable the button and show the legacy reason text (e.g. "最新の測位が古すぎます（15秒前）。/ Latest fix is stale.") whenever `isFixStale` says so, and both re-render on `connectionState` changes (not just `currentFix` changes) so the transition into `'stalled'` is caught even though the fix object itself doesn't change.

The map's current-fix layer is unaffected: `currentFix` still renders as "last known position" while stalled/reconnecting, exactly as task section 11 asks ("map may still display last known point but must not imply freshness") — freshness is enforced at the point of *creating new data*, not at the point of display.

### 3.8 Recovery interaction — no invalid state combinations

`recovery_available` and the Stage 5B connection states are unrelated axes and never combine: `resumeRecovery()` still touches no serial state at all (Stage 5A's own guarantee, re-verified unchanged), and `checkForRecovery()` runs once at app-root mount before any serial action is possible — there is no `connect()`/reconnect call anywhere in the mount sequence, so a legacy-inherited or reload-inherited unfinished session can never start receiving live data before the operator explicitly clicks **Resume**. A dedicated Playwright test seeds an unfinished session, resumes it, connects, disconnects, and reconnects, and confirms the final session contains the original point plus everything ingested after Resume and after the reconnect, exactly once.

### 3.9 A real bug this stage's tests caught

The exhausted-retry Playwright test failed on first write for a genuine reason, not a test mistake: `RecordingService.stop()`'s existing implementation was correct, but the *first* draft of `interruptionWarning()`'s reconnect-required message and the reconnect banner's own "Automatic reconnect unsuccessful." text collided in a Playwright `getByText()` strict-mode check, because both are legitimately visible at once (the Live GNSS section's own status line and the new banner both surface the same underlying `serialGnssService` message, deliberately, from two different UI contexts). Resolved by scoping the test's locator to the banner (`getByLabel('GNSS reconnect status')`), not by removing either message — both are correct to show.

Separately, a genuine timing bug surfaced while writing the reconnect-continuity test: the Playwright fake serial port kept streaming NMEA sentences between the "pending count reached zero" check and the simulated crash, occasionally landing a sentence in the gap and shifting the expected point count by one. Fixed by adding a `stopStream()`/`__fakeSerialStop`-style hook to freeze the fake before snapshotting "before" state — the same pattern the pre-existing legacy Playwright spec already uses for the identical reason.

### 3.10 Explicit non-goals — not started, not stubbed

Wake Lock API, screen/OS sleep prevention, Reports, Data workspace redesign, Paddy Intelligence, AI, RealSense, pilot/manual flight, MAVLink, field boundary editing, observation photos, water-level recording creation, any IndexedDB schema change or v2, automatic session *resume* (as opposed to automatic *transport* reconnect — these remain deliberately separate concepts, §3.8), and automatic permission prompts. None of these were touched.

### 3.11 Exact Stage 5B changed files

New:
```text
frontend/src/features/survey/GnssReconnectBanner.tsx
frontend/src/features/survey/__tests__/GnssReconnectBanner.test.tsx
frontend/src/services/gnss/__tests__/reconnectRecordingIntegration.test.ts
frontend/tests/browser/reconnect.spec.ts
```

Modified:
```text
docs/HANDOFF.md
docs/FRONTEND_ARCHITECTURE.md
docs/UI_REDESIGN.md
frontend/src/services/gnss/serialGnssService.ts                    (reconnect state machine + stall watchdog)
frontend/src/services/gnss/__tests__/serialGnssService.test.ts     (rewritten/extended: 14 tests)
frontend/src/services/gnss/useGnssRuntime.ts                       (status-bar mapping for the new states; publishSerialStatus exported for testing)
frontend/src/services/gnss/__tests__/useGnssRuntime.test.tsx       (+4 tests)
frontend/src/services/recording/recordingService.ts                (interruptionWarning() for state-aware messaging)
frontend/src/services/recording/__tests__/recordingService.test.ts (+5 tests)
frontend/src/features/survey/SurveyInspector.tsx                   (mounts GnssReconnectBanner; Reconnect GNSS label)
frontend/src/features/survey/SurveyInspector.css                   (.gnss-reconnect-banner styles)
frontend/src/features/survey/ObservationComposer.tsx               (stale-fix gate via legacy validateObservationCreation)
frontend/src/features/water/WaterControlComposer.tsx               (same stale-fix gate)
frontend/src/features/survey/__tests__/Stage3CWorkflow.test.tsx    (+1 stale-fix regression test; fixture receivedAtMs fix)
frontend/src/features/water/__tests__/WaterWorkspace.test.tsx      (+1 stale-fix regression test; fixture receivedAtMs fix)
frontend/src/components/map/layers/__tests__/LiveGnssLayers.test.tsx (snapshot fixture updated for new fields)
frontend/src/store/useLiveGnssStore.ts                              (reconnectAttempt/reconnectMaxAttempts fields)
frontend/tests/browser/recovery.spec.ts                             (viewport test extended, no behavior change)
```

No legacy `js/` file, no backend file, no pilot/MAVLink file, and no IndexedDB schema definition was modified.

### 3.12 Stage 5B verification results

Counts are fresh, not carried over — concurrent pilot work moved several of them again since Stage 5A.

| Check | Result |
|---|---|
| `npm test` in `frontend/` | **41 files, 249/249 passed** (Stage 5A end: 39 files, 222) |
| `npm test` at repository root | **216/216 passed** (Stage 5A end: 208 — the +8 delta is concurrent pilot work; Stage 5B added no root-level test) |
| Legacy recording browser, `npx playwright test tests/browser/recording.spec.js` | **13/14 passed.** The one failure (`an interrupted session survives reload and can be resumed from the recovery card`) is a `flushPending()`/IndexedDB-timing assertion against the **legacy static app**, which Stage 5B did not touch — `js/recording/*` has zero diff. `index.html` itself is under active concurrent modification by the parallel pilot work (confirmed via `git diff --stat`), which the same test's DOM/timing depends on. Re-run twice, including with an extended timeout; failed identically both times, consistent with a change outside this stage's files rather than a flake that would clear on retry. Not investigated further per this stage's explicit instruction not to touch pilot-adjacent files. |
| React acceptance, `npx playwright test` in `frontend/` | **14/14 passed** (9 pre-existing + 5 new Stage 5B) |
| `npx tsc -b` | passed |
| `npx vite build` | passed |
| `npm run lint` | passed with the one pre-existing `routes.tsx` warning; Stage 5B adds none |
| `git diff --check` | clean |
| Backend pytest | **Not run.** Stage 5B changed no backend/API/MAVLink/command file. |

Failure classification: **no Stage 5B regression** in any suite covering code this stage touched. The one legacy-suite failure is isolated to a file this stage did not modify, described above rather than fixed, per the explicit constraint against touching pilot-adjacent files.

Viewport acceptance, asserted with the reconnect banner visible and a recording open at **1366×768, 1920×1080, and 1024×768**: no document-level scrolling, the map keeps more than 40% of the viewport area, and both **Reconnect now** and **Stop recording** stay reachable at every size.

### 3.13 Test coverage map

| Requirement | Where proven |
|---|---|
| Disconnect classes A/B trigger reconnect; C/D never do | `serialGnssService.test.ts` |
| Bounded retry, no permission prompt, single-port targeting | `serialGnssService.test.ts` — exhaustion + manual-override cases |
| No duplicate reader across repeated cycles | `serialGnssService.test.ts` + `reconnect.spec.ts`'s repeated-cycle case |
| Manual connect/disconnect supersedes a pending automatic attempt | `serialGnssService.test.ts` — the two generation-guard cases |
| Stalled detection and recovery, without touching the port | `serialGnssService.test.ts` |
| Recording continuity, sequence integrity, Stop-while-disconnected | `reconnectRecordingIntegration.test.ts`; `recordingService.test.ts`'s Stage 5B block |
| Interruption messaging distinguishes all four connection states | `recordingService.test.ts` |
| Status bar mapping for reconnecting/reconnect_required/stalled | `useGnssRuntime.test.tsx` |
| Reconnect banner rendering/actions | `GnssReconnectBanner.test.tsx` |
| Stale-fix refusal for both "current position" actions | `Stage3CWorkflow.test.tsx`, `WaterWorkspace.test.tsx` |
| Real-browser: full lifecycle, exhaustion+manual, repeated cycles, recovery+reconnect, viewports | `reconnect.spec.ts` (5 tests) |

### 3.14 Bundle size

| | Raw | Gzip |
|---|---|---|
| End of Stage 5A | 547.66 kB | 163.32 kB |
| End of Stage 5B | 553.35 kB | 164.75 kB |
| Delta | +5.69 kB | +1.43 kB |

### 3.15 Dirty files belonging to other work — do not touch

Concurrent pilot/manual-control/MAVLink work continued throughout this stage — `index.html` itself gained further changes (see §3.12). Everything under `backend/`, `js/pilot/`, `css/pilot.css`, `js/gamepad/`, `tests/unit/pilot-*.test.js`, `tests/unit/gamepad-*.test.js`, `tests/browser/manual-control-helpers.js`, `tests/browser/desktop.spec.js`, `tests/browser/gamepad.spec.js`, `mock-manual-acceptance.html`, `scripts/dev.ps1`, `scripts/run-backend.mjs`, and the pilot/gamepad/MAVLink operator guides in `docs/` belongs to that work. **None of it was modified, reverted, formatted, staged, or debugged as part of Stage 5B.**

### 3.16 Recommended next step — analysis, not a decision

**Stage 5C — Wake Lock / field-session display-sleep prevention**, exactly as the task brief scoped it, is the natural next reliability item and is **deliberately not implemented** here:

- **Wake Lock acquisition and release timing** needs to be tied to the recording lifecycle (acquire on Start, release on Stop/Discard/Finish) without acquiring one merely because the recovery panel is showing an unresolved session — the same "don't conflate adjacent concerns" principle §3.8 applied to recovery vs. reconnect.
- **Visibility-state behavior** (`document.visibilitychange`) needs a policy for re-acquiring a lock after a tab is backgrounded and returns, which the current Wake Lock API makes annoyingly manual, and interacts with whatever this stage's `reconnecting` state is doing if the tab was hidden during a disconnect.
- **Feature detection and graceful degradation** on a Wake Lock–unsupported browser needs to not present as an error — the legacy app already has a precedent for this exact pattern (`#recWakeLockStatus` "非対応") that should be ported rather than reinvented.

A smaller, narrower alternative worth weighing first: nothing — Stage 5A and 5B together have now closed both reliability gaps the Stage 4B recommendation flagged (unrecoverable interrupted session; silent reconnect failure). Wake Lock is a genuine but different concern (device power management, not data safety), so unlike Stages 5A→5B it is not blocking anything else in this migration's sequence. This is analysis for the next authorization, not a decision — do not start it automatically.

## 4. Stage 5A completion checkpoint

### 4.1 What "unfinished" means — derived, not invented

The definition is taken verbatim from the existing store, not authored for this stage. `RecordingStore.listUnfinishedSessions()` (`js/recording/recording-store.js:131`) returns sessions whose `status` is `"recording"` or `"paused"`. React only ever writes `"recording"` and `"stopped"` (it has no pause control), but the query is used unmodified, so a **legacy-created paused session is detected too**.

There is no separate "crashed" flag, no heartbeat, and no timestamp heuristic — a session is unfinished precisely because nothing ever wrote `status: "stopped"` to it. That is the whole signal, and it is exactly the one legacy already relies on.

### 4.2 No schema change — verified, not assumed

`suimon-navi-recording` v1 is untouched: same DB name, same version, same five object stores (`sessions` keyPath `sessionId`; `rawNmeaLines`/`structuredFixes` autoIncrement `id` + `by_sessionId` index; `markedObservations`/`imageBlobs` keyPath `id` + `by_sessionId` index), same record keys, same field names. Recovery reads only fields the legacy controller already writes. The Playwright compatibility test seeds a session shaped exactly as `recording-controller.js`'s `startRecording()` + `sessionCounterPatch()` would have written it and proves React detects and finalizes it; the 14 legacy recording browser tests then still pass unchanged against the same database.

### 4.3 Architecture — one state machine, extended

Stage 3B's `RecordingService` singleton (`frontend/src/services/recording/recordingService.ts`) gained the recovery methods; no new service, store, or global was introduced. Its `RecordingState` union gained `'recovery_available'`, which is **not a new concept** — `js/recording/recording-core.js` already defines it in `RECORDING_STATES` with transitions `recovery_available → {resume, finish, delete}`. React now uses the same vocabulary.

| Method | Behavior | Fails closed by |
|---|---|---|
| `checkForRecovery()` | Lists unfinished sessions and adapts them to typed `RecoverableSession` candidates. **Never mutates anything it finds.** Called once at app-root mount (`useGnssRuntime`) and again after every recovery action, mirroring legacy's `refreshRecoveryList()`. | Reporting a failed scan (`"Could not check for unfinished recordings: …"`) distinctly from "nothing to recover" — those are different facts and are never presented identically. |
| `resumeRecovery(sessionId)` | Continues the session's monotonic `seq` from `store.getMaxSeq(sessionId)`, restores it as active, patches `status: "recording"`. | Setting `recoveryWarning`/`state: 'error'` and returning `false`; on a storage failure the original session record is left exactly as it was. |
| `finalizeRecovery(sessionId)` | A single `{status: 'stopped', endedAt, updatedAt}` patch. Adds no point, no fix, no fabricated endpoint. Works on any unfinished session, not only the active one. | Same — `"Could not finish that recording: …"`, session unchanged. |
| `discardRecovery(sessionId)` | Delegates to `store.deleteSession(sessionId)`. | Same — `"Could not discard that recording: …"`. |

Two state facts worth knowing: `recoveryInProgress` is checked **synchronously before any `await`**, so a double-click cannot race two resumes against one session (legacy has the identical guard). And `recovery_available` is entered only from `idle` and released back to `idle` only when the last candidate is resolved — a recording in progress or an error state is never overwritten by a background scan, and the two states are never combined.

### 4.4 Sequence integrity — the core correctness property

`rawNmeaLines` and `structuredFixes` share **one** monotonic per-session `seq` counter. Resume sets `this.seq = await store.getMaxSeq(sessionId)` — the max across both stores — and never resets to zero. If the pre-crash session ended at seq 7, the first post-resume record is 8.

Deliberately *not* recomputed: `pointCount`/`lineCount` are restored from the session record's own `validFixCount`/`totalReceivedLines` counters rather than by counting stored rows. This mirrors legacy's `resumeSession()` exactly, including its staleness tradeoff (a counter can lag an unflushed batch). Choosing a "more correct" recount here would have made React and legacy disagree about the same session — worse than matching a known, shared imprecision. The recovery *card*, separately, shows a live `countRawLines()` query, because that is what legacy's own `recoveryLineCounts` mechanism displays.

### 4.5 Resume and GNSS are separate concerns

`resumeRecovery()` touches no serial state: no port open, no permission prompt, no reconnect, no wake lock. Resuming restores the recording session; connecting GNSS remains an explicit, separate operator action. Both a Playwright assertion and a unit test pin this — after Resume, the button still reads "Connect GNSS". This matches legacy's own comment that resuming "never touches the serial connection subsystem."

### 4.6 Discard was implemented, not deferred — because cascade safety was proven

Stage 2 deferred destructive field deletion under a fail-closed policy. Discard did **not** need the same treatment: `RecordingStore.deleteSession()` (`recording-store.js:136`) opens one transaction across all five object stores and cascades via `deleteByIndexCursor` on `by_sessionId` for raw lines, structured fixes, marked observations, and image blobs. Nothing can be orphaned. That was read and verified in source before the UI exposed the action — not inferred from the method name.

The UI requires a two-step inline confirmation ("Discard" → "Discard this recording permanently?" → "Confirm Discard"), chosen over a native `window.confirm()` because the panel can list several sessions and a modal gives no indication of *which* one it is about to delete.

### 4.7 Corrupt and partial candidates

`adaptRecoverableSession()` is a pure, exported, never-throwing adapter. A candidate is dropped **only** when it has no usable `sessionId` — without one, no action any UI could offer would be safe to target. Everything else degrades to a safe default rather than vanishing: malformed timestamps become `null`, a non-numeric `validFixCount` becomes `0`, a `lastValidFix` with non-finite coordinates becomes `null`. Dropped candidates are counted and reported ("N unfinished recording(s) could not be read and were not shown"), so a hidden record is never silently hidden. Detection never writes during this process.

Field links follow the same principle: if `fieldId` is set but the field no longer exists, the card shows `Linked field no longer exists (<fieldId>)` — the original identifier is preserved and displayed, never cleared.

### 4.8 UI placement and status

`RecoveryPanel` renders inside the existing Survey inspector, above the recording controls — a compact card list, not a new full-page workflow, and Survey stays map-first. It is deliberately presentational (props in, callbacks out; the only store it reads is `useFields()` to resolve a field name), which is why its rendering and interaction logic is unit-testable in jsdom with no IndexedDB at all. `SurveyInspector` wires the callbacks to the real singleton.

The status bar reuses the existing `recording` slot with a `warning` tone and the message **`RECOVERY REQUIRED`** rather than inventing a new subsystem category — an unresolved recovery is a recording condition needing attention. Critically, the badge does **not** report the recording as actively running merely because an unfinished record exists.

### 4.9 A real bug this stage's tests caught

The Playwright compatibility test failed on first run, and the failure was a genuine product defect, not a test error: after Finish & Save resolved the *only* unfinished session, `Start Recording` stayed permanently disabled. `checkForRecovery()` had an `idle → recovery_available` transition but no inverse, and `finalizeRecovery()`'s own state patch only fires when the finalized session is the *active* one — which it never is for a session inherited from a previous page load or from legacy. The app was stuck refusing all new recordings.

Fixed by making the transition symmetric (`recovery_available → idle` when zero candidates remain) and pinned by both the Playwright case and a new unit test. This is exactly the class of bug that only a real-IndexedDB, real-reload test surfaces.

### 4.10 Explicit non-goals — not started, not stubbed

Automatic serial reconnect, retry loops, WebSerial auto-connect after disconnect, wake locks, Visibility API behavior beyond what recovery needs, Reports, Paddy Intelligence, observation photo support, water-level creation, Stage 2B field editing, gate actuation, pilot/manual-flight changes, MAVLink changes, backend changes, schema convergence, and bundle optimization. None of these were touched.

One nuance worth recording: `recordedSurveyRepository.refresh()` calls `store.listSessions()` with **no status filter**, so unfinished sessions already appeared in the Survey selector before this stage and still do. Stage 5A did not change that behavior; it only added a way to resolve them.

### 4.11 Exact Stage 5A changed files

New:
```text
frontend/src/features/survey/RecoveryPanel.tsx
frontend/src/features/survey/__tests__/RecoveryPanel.test.tsx
frontend/tests/browser/recovery.spec.ts
```

Modified:
```text
docs/HANDOFF.md
docs/FRONTEND_ARCHITECTURE.md
docs/UI_REDESIGN.md
frontend/src/services/recording/recordingService.ts              (recovery types + 4 methods + state)
frontend/src/services/recording/__tests__/recordingService.test.ts  (rewritten: 31 tests)
frontend/src/services/gnss/useGnssRuntime.ts                     (mount-time detection + RECOVERY REQUIRED status)
frontend/src/features/survey/SurveyInspector.tsx                 (mounts RecoveryPanel)
frontend/src/features/survey/SurveyInspector.css                 (recovery-panel/recovery-card styles)
frontend/src/components/map/layers/__tests__/LiveGnssLayers.test.tsx  (+1 resume-continuity test)
```

No legacy `js/` file, no backend file, no pilot/MAVLink file, and no IndexedDB schema definition was modified.

### 4.12 Stage 5A verification results

Counts are **fresh**, not carried over — concurrent pilot work moved several of them since Stage 4B.

| Check | Result |
|---|---|
| `npm test` in `frontend/` | **39 files, 222/222 passed** (baseline at Stage 4B end: 38 files, 182) |
| `npm test` at repository root | **208/208 passed** (Stage 4B end: 206 — the +2 delta is concurrent pilot work; Stage 5A added no root-level test) |
| `node --test tests/unit/field-annotation-core.test.js tests/unit/recording-core.test.js tests/unit/field-report.test.js` | **55/55 passed**, unchanged |
| Legacy recording browser, `npx playwright test tests/browser/recording.spec.js` | **14/14 passed** — including legacy's own recovery-card, resume-never-touches-serial, and monotonic-seq-across-reload cases, against the same untouched database |
| React acceptance, `npx playwright test` in `frontend/` | **9/9 passed** (6 pre-existing + 3 new Stage 5A) |
| `npx tsc -b` | passed (it caught one real type error in a new test fixture: `fixQuality` typed as string) |
| `npx vite build` | passed |
| `npm run lint` | passed with the one pre-existing `routes.tsx` warning; Stage 5A adds none |
| `git diff --check` | clean |
| Backend pytest | **Not run.** Stage 5A changed no backend/API/MAVLink/command file. |

Failure classification: **one genuine product defect found and fixed** (§4.9), **one test-authoring flake found and fixed** (the fake serial stream kept emitting between the pre-crash snapshot and the reload, racing a point count by one — fixed by freezing the stream via a `__fakeSerialStop` hook, the same pattern the legacy spec already uses, not by loosening the assertion). No pre-existing failure and no unrelated failure in any suite.

Viewport acceptance, asserted with **two** unfinished sessions listed at **1366×768, 1920×1080, and 1024×768**: `scrollWidth === clientWidth` and `scrollHeight === clientHeight` at every size (no document-level scrolling), the recovery panel and inspector both stay within viewport bounds, the map keeps more than 40% of the viewport area (Survey stays map-first), and Resume / Finish & Save / Discard are all visible at every size.

### 4.13 Test coverage map

| Requirement | Where proven |
|---|---|
| Detection: none / one / multiple / malformed / failed scan | `recordingService.test.ts` — `recovery detection` block |
| Resume: state restored, monotonic seq across both stores, old+new coexist exactly once, field link preserved, concurrent-click guard | `recordingService.test.ts` — `resumeRecovery` block; end-to-end in `recovery.spec.ts` |
| Finalize: no fabricated point/fix, non-active session, storage failure | `recordingService.test.ts` — `finalizeRecovery` block; `recovery.spec.ts` asserts exact raw/fix counts unchanged after finalize |
| Discard: cascading delete, idle reset only when active, storage failure | `recordingService.test.ts` — `discardRecovery` block |
| Storage errors leave the original session intact | Every `fails closed` case above asserts the stored record is unchanged |
| UI: prompt, metadata, missing-field fallback, two-step discard, disabled-while-busy, error alert | `RecoveryPanel.test.tsx` (12 tests) |
| Map: resume starts a fresh live segment, no duplicate track, no map recreation | `LiveGnssLayers.test.tsx` |
| Real-IndexedDB crash → recover → resume → stop → reload | `recovery.spec.ts` test 1 |
| Legacy-created session detected and finalized by React; still readable after reload | `recovery.spec.ts` test 2 |
| Viewports | `recovery.spec.ts` test 3 |

**Compatibility claim, stated precisely:** legacy-created unfinished session → detected, resumable, and finalizable by React — **tested**. React-finalized session → still readable by the legacy recording readers, and the full legacy recording suite passes against the shared database — **tested**. Bidirectional compatibility beyond these two directions was not exercised and is not claimed.

### 4.14 Bundle size

| | Raw | Gzip |
|---|---|---|
| End of Stage 4B | 541.08 kB | 162.00 kB |
| End of Stage 5A | 547.66 kB | 163.32 kB |
| Delta | +6.58 kB | +1.32 kB |

The pre-existing >500 kB advisory is unchanged in kind; bundle optimization is an explicit non-goal.

### 4.15 Dirty files belonging to other work — do not touch

Concurrent pilot/manual-control/MAVLink work continued throughout this stage. Everything under `backend/`, `js/pilot/`, `css/pilot.css`, `tests/unit/pilot-*.test.js`, `tests/unit/gamepad-*.test.js`, `tests/browser/manual-control-helpers.js`, `mock-manual-acceptance.html`, and the pilot/gamepad/MAVLink operator guides in `docs/` belongs to that work. **None of it was modified, reverted, formatted, staged, or debugged as part of Stage 5A.** The root unit count moving 206 → 208 is entirely attributable to it.

### 4.16 Recommended next step — analysis, not a decision

**Stage 5B — automatic reconnect for a transient WebSerial disconnect** is the natural successor and was scoped during this stage's audit, but is **deliberately not implemented**. Stage 5A closed the "data is unrecoverable after a crash" gap; the remaining Stage 3B reliability gap is that a serial cable knocked loose mid-recording requires a fully manual reconnect, with the session staying open but silently receiving nothing.

What makes it genuinely non-trivial, and why it should not be started automatically:

- WebSerial permission is origin-and-gesture scoped. `navigator.serial.getPorts()` can return a previously granted port without a prompt, but whether a *reopen* succeeds without a user gesture is the crux and needs real-device verification — precisely the hardware validation Stage 5A was forbidden from doing.
- A reconnect loop must be bounded and observable. Silent infinite retry is worse than a visible failure for a farmer in a field, and it interacts with the same fail-closed rules Stage 5A follows.
- It must not re-enter recording state. Reconnecting the transport is not resuming a session; conflating them would undo the separation §4.5 just established.

A smaller alternative worth weighing: surface a **visible stalled-stream warning** during recording (legacy already classifies byte-level vs fix-level stalls in `classifySerialDiagnostics()`) without any automatic reconnect at all. That is read-only, needs no hardware, and delivers most of the operational value. This is analysis for the next authorization, not a decision — do not start either automatically.

## 5. Historical Stage 4B completion checkpoint

### 2.1 What was migrated

`evaluateGate(weather, thresholds)` — the single implementation of the gate open/hold/close recommendation, previously inline-only at `index.html:3672-3710` with no export boundary — is now `frontend/src/domain/water/decision.ts`'s `evaluateGate()`: a **hand-transcribed, byte-faithful port**, not an `@legacy`-alias import (there is nothing to import; it lives inside the monolithic inline `<script>`). It is pinned by tests that reproduce the legacy source's exact branch order, `>=` comparisons, and Japanese strings, since no legacy unit test of this function existed to cross-check against (confirmed: zero references to `evaluateGate` anywhere under `tests/`).

A compact, field-independent `GateDecisionPanel` renders in the Water workspace, above the Stage 4A control-point/measurement sections: three editable weather inputs (prefilled from the real `data/weather.json`), the four thresholds shown read-only (from the real `data/gate_rules.json`), and the resulting verdict + label + reason.

### 2.2 Exact inputs, with provenance

| Input | Type | Source | Persisted? | User-editable in React? | Demo-only? |
|---|---|---|---|---|---|
| `rain24hMm` | number, mm | `data/weather.json` default, then operator edit | No — ephemeral form state, matching legacy | Yes | No |
| `daysSinceRain` | number, whole days | same | No | Yes | No |
| `forecastRainProbPct` | number, percent | same | No | Yes | No |
| `heavyRain24hMm` | number, mm | `data/gate_rules.json` | No (the JSON file is the durable "confirmed value"; legacy's own in-app override is explicitly described as temporary) | **No — read-only display in Stage 4B** | No |
| `lightRain24hMm` | number, mm | same | No | No | No |
| `forecastRainProbPct` (threshold) | number, percent | same | No | No | No |
| `drySpellDays` | number, whole days | same | No | No | No |

**Why thresholds are read-only in React, not ported 1:1 as editable:** legacy itself frames in-UI threshold edits as a temporary "what-if" tool ("ここでの変更は一時的で、確定値はJSONを更新して残します。", `index.html:1788`) layered on top of the authoritative JSON file, not part of the core recommendation path. Reproducing that specific what-if UI was judged out of scope for "smallest safe Stage 4B" (task section 12 asks for a compact panel, not another form); the thresholds that actually drive the algorithm are fully visible and exactly correct. Every boundary-condition test exercises threshold values directly at the domain layer, which needs no UI control to do so. This is a deliberate, documented scope reduction, not an oversight — revisit only if an operator workflow actually needs to test alternate thresholds interactively.

**Units:** mm for both rainfall figures, whole days for the dry-spell count, percent for forecast probability — read directly from the legacy source and never converted.

**Weather auto-fetch (Open-Meteo) was not reproduced.** Legacy's `fetchLiveWeather()` (index.html:3639) is a separate, DOM-coupled function that populates the weather object from a third-party API before `updateDecision()` runs; `evaluateGate` itself never calls it. Building that pipeline would require reproducing `activeGate()`'s position-resolution logic (`surveyedGate`, a QZ1 point tagged as 水門 — a concept Stage 4A's React app has no equivalent of) purely to seed a coordinate for a network call, which is materially more scope than "port the pure decision function." Deferred, not lost — see §2.7.

### 2.3 Exact output

```ts
interface GateDecision {
  verdict: 'open' | 'hold' | 'close'
  label: string   // 開ける / 様子見 / 閉める -- exact legacy text
  reason: string  // exact legacy Japanese sentence, with the triggering value interpolated
}
```

Nothing richer is invented. The verdict badge is never color-only: the label text itself is always the primary, distinguishing signal (color is a left-border accent reusing the existing `--status-connected/warning/disconnected` tokens, reinforcement only).

### 2.4 The four thresholds — exact semantics

All four comparisons are **inclusive** (`>=`), checked in this fixed priority order, first match wins:

1. `rain24hMm >= heavyRain24hMm` (default 20) → **close**
2. `rain24hMm >= lightRain24hMm` (default 5) → **hold**
3. `forecastRainProbPct >= forecastRainProbPct threshold` (default 60) → **hold**
4. `daysSinceRain >= drySpellDays` (default 3) → **open**
5. none match → **hold** (generic "no threshold reached" message)

A value exactly at a threshold already triggers that branch (e.g. `rain24hMm = 20` closes the gate, it does not merely approach closing). Every threshold has a dedicated boundary test at `threshold − ε`, `threshold`, and `threshold + ε`, plus integer-adjacent cases, in `frontend/src/domain/water/__tests__/decision.test.ts`. A priority-order test confirms heavy rain overrides a simultaneously-true dry-spell condition, and light-rain overrides simultaneously-true forecast/dry-spell conditions.

**Real-data integration check:** `data/weather.json` (0mm rain, 4 dry days, 20% forecast) against `data/gate_rules.json`'s defaults today recommends **opening** the gate. This is asserted directly (`AUTHORITATIVE_GATE_THRESHOLDS`/`DEFAULT_GATE_WEATHER` computed from the real imported JSON) — if it ever fails, either JSON file changed, which is a real behavior change to acknowledge explicitly, not a bug in the test.

### 2.5 Explicitly confirmed NOT to affect the decision (Stage 4A/4B traps, verified against source)

- **Measured water level** (Stage 4A's `WaterLevelMeasurement`) — `evaluateGate` has no such parameter, and the panel proves it: a dedicated test renders the same weather/thresholds with `contextualMeasurementCount` at 0 and at 3 and asserts an **identical** verdict. When a field has readings, the panel shows "N water-level reading(s) recorded for this field. Context only — not used by this recommendation." — never implying influence.
- **Water control points** — never referenced by the decision panel at all; no control-point location is displayed as if it were part of the recommendation.
- **判断プロファイル (decision profile)** — confirmed display-only at *two independent* legacy call sites (`renderDecisionFieldSummary`'s label-only read of `decisionProfileSelect`, and a code comment at `index.html:5036-5038` stating it "must never affect" the separate proof/reliability card either). No profile selector was built in React; `evaluateGate.length === 2` is pinned by a test so an accidental future third parameter is caught immediately.
- **`data/field.json`'s `gate` object** — unrelated to `waterControlPoints` (no shared id, no sync); used historically only as a fallback coordinate for the Open-Meteo request, which Stage 4B does not reproduce. Untouched.
- **`targetWaterDepthInput`** (paddy-intelligence demo, `index.html:2261`) — ephemeral, never persisted, only ever multiplies boundary area for a volume estimate. Not read anywhere in Stage 4B.
- **Reports** — `js/reports/field-report.js` and `js/reports/field-report-controller.js` have zero references to `evaluateGate`, confirmed by repo-wide search; nothing there was touched or needed to be.

### 2.6 Architecture

```
data/gate_rules.json  data/weather.json         (build-time imports, @data alias)
        │                     │
   resolveGateThresholds  resolveDefaultWeather   (domain/water/gateRules.ts)
        │                     │
        └────────┬────────────┘
                  │
        evaluateGate(weather, thresholds)         (domain/water/decision.ts, hand-ported)
                  │
           GateDecisionPanel                      (features/water/, local useState only)
                  │
             WaterWorkspace                       (mounted above Stage 4A's sections)
```

- **`@data` alias** (`vite.config.ts`/`tsconfig.app.json`, mirroring the existing `@legacy` alias) imports `data/gate_rules.json` and `data/weather.json` directly. This is a **build-time read**, unlike legacy's runtime `fetch()` of the same files. The only behavioral difference this could cause — the "fetch failed, fall back to a hardcoded default" path — cannot occur for a bundled import (malformed JSON fails the build instead), so it is not reproduced; see the code comments in `gateRules.ts` for the exact per-field fallback semantics this implies (0, not the module constant, matching `populateDecisionInputs()`'s actual fallback literal).
- No persistence was added anywhere. Weather inputs are local `useState` in `GateDecisionPanel`, exactly as ephemeral as legacy's DOM input values.
- `GateDecisionPanel` touches no map, no Leaflet API, and no `MapContext` — it cannot recreate the map by construction. A dedicated test still exercises this end-to-end: typing in the rainfall field while Field/Water map layers are mounted asserts the map DOM node identity and `LayerGroup` construction count are both unchanged.
- No new `SelectedEntity` member, no new repository, no new Zustand store. This is the smallest-footprint stage of the migration so far by file count.

### 2.7 Deferred (explicitly, not overlooked)

- Editable/overridable thresholds (legacy's "what-if" UI on top of the JSON).
- Live Open-Meteo weather auto-fetch and its gate-position resolution (`activeGate()`/`surveyedGate`).
- The legacy decision tab's independent field-selector/proof-card/reliability-check subsystem (`decisionFieldSelect`, sample/demo data sources) — a separate, larger surface tied to `fieldReportController` and Satellite Assurance, out of this stage's "port evaluateGate" scope.
- Any coupling between the decision and Stage 4A's water control points or level readings — confirmed by audit that none should exist.
- Everything already deferred from Stage 4A (§3 below): gate actuation/hardware commands (also explicitly out of scope for Stage 4B — this stage adds no MAVLink/actuator/backend call of any kind), Stage 2B, observation editing, reliability work, Paddy Intelligence, Reports, AI/camera, drone missions.

### 2.8 Exact Stage 4B changed files

New:
```text
frontend/src/domain/water/decision.ts
frontend/src/domain/water/gateRules.ts
frontend/src/domain/water/__tests__/decision.test.ts
frontend/src/features/water/GateDecisionPanel.tsx
frontend/src/features/water/__tests__/GateDecisionPanel.test.tsx
frontend/tests/browser/stage4b-water-decision.spec.ts
```

Modified:
```text
docs/HANDOFF.md
docs/FRONTEND_ARCHITECTURE.md
docs/UI_REDESIGN.md
frontend/vite.config.ts                              (@data alias)
frontend/tsconfig.app.json                            (@data path + resolveJsonModule)
frontend/src/features/water/WaterWorkspace.tsx        (mounts GateDecisionPanel)
frontend/src/features/water/WaterWorkspace.css        (gate-decision/gate-verdict styles)
frontend/src/features/water/__tests__/WaterWorkspace.test.tsx  (+2 tests)
frontend/src/components/map/layers/__tests__/WaterLayers.test.tsx  (+1 map-lifecycle test)
```

### 2.9 Stage 4B verification results

| Check | Result |
|---|---|
| `npm test` in `frontend/` | **38 files, 182/182 passed**, 0 failed (baseline before Stage 4B: 36 files, 149/149) |
| `npm test` at repository root | **206/206 passed** (baseline before this stage: 198/198 — the +8 delta is concurrent pilot work, not Stage 4B; Stage 4B added no root-level test) |
| `node --test tests/unit/field-annotation-core.test.js tests/unit/recording-core.test.js tests/unit/field-report.test.js` | **55/55 passed**, unchanged from Stage 4A |
| Legacy water browser cases, `npx playwright test tests/browser/field-annotation.spec.js --grep "水管理\|water\|水門"` | **10/10 passed**, unchanged |
| React acceptance, `npx playwright test --config frontend/playwright.config.ts` | **6/6 passed** (4 pre-existing Stage 3B/3C/4A + 2 new Stage 4B) |
| `npx tsc -b` | passed |
| `npx vite build` | passed |
| `npm run lint` | passed with the one pre-existing warning; Stage 4B adds none |
| Backend pytest | **Not run.** Stage 4B changed no backend/API/MAVLink/command file. |

Failure classification: **no Stage 4B regression, no pre-existing failure, no unrelated failure in any suite run.** One failure occurred during development and was a bug in my own new Playwright test's expected value (assumed 19mm rainfall would still recommend opening; it actually crosses the light-rain threshold and correctly recommends holding) — a test-authoring mistake caught by the real algorithm behaving correctly, not a product defect. Fixed by correcting the test's expectation, not the code.

Viewport acceptance, asserted with the decision panel visible at **1366×768, 1920×1080, and 1024×768**: `scrollWidth === clientWidth` and `scrollHeight === clientHeight` at every size (no document-level scrolling), the map keeps more than half the viewport width, and the inspector stays within bounds. The Gate recommendation panel and the "Add Water Point" control are both visible without scrolling the document at every size (the inspector may scroll internally, which remains acceptable per Stage 4A's precedent).

### 2.10 Bundle size

| | Raw | Gzip |
|---|---|---|
| End of Stage 4A | 536.98 kB | 160.46 kB |
| End of Stage 4B | 541.08 kB | 162.00 kB |
| Delta | +4.10 kB | +1.54 kB |

The pre-existing >500 kB advisory is unchanged in kind; no code splitting was performed for a 4 kB addition.

### 2.11 Dirty files belonging to other work — do not touch

Concurrent pilot/manual-control/MAVLink work grew further during this stage. In addition to the Stage 4A list, the following were also modified by that concurrent work and were **not** touched by Stage 4B: `backend/app/main.py`, `backend/app/models.py`, `backend/tests/test_api.py`, `backend/tests/test_pilot_service.py`, `js/pilot/pilot-axes.js`, `js/pilot/pilot-client.js`, `js/pilot/pilot-controller.js`, `js/pilot/pilot-panel.js`, `js/pilot/pilot-view.js`, `tests/browser/pilot.spec.js`, `tests/unit/pilot-axes.test.js`, `tests/unit/pilot-controller.test.js`, `docs/GAMEPAD_OPERATOR_GUIDE.md`, `docs/MAVLINK_OPERATOR_GUIDE.md`, `docs/PILOT_CONTROL_GUIDE.md`. Root unit test count grew from 194 (Stage 4A start) to 198 (Stage 4B start) to 206 (Stage 4B end) from this work alone; every run remained 100% passing throughout and none of it was authored, reviewed, or debugged as part of Stage 4B.

### 2.12 Recommended next step — analysis, not a decision

Four candidates were weighed against dependency structure and the actual user workflow (祖父の水田 — one farmer, one field, manual gate operation):

- **Option A, Data/Reports:** `js/reports/field-report.js` already renders water control points and would be a natural next consumer of the now-typed `GateDecision` output (§2.7 leaves this interface exactly where a future Reports stage can pick it up). Read-heavy, low risk, but reports haven't been requested by name yet in this migration's stage sequence.
- **Option B, Paddy Intelligence:** the largest remaining legacy surface (1,929 lines, never modularized) and the *only* place `targetWaterDepthInput`/water-volume estimation lives — but it is demo-only geometry today, not real field data, and migrating it does not depend on anything built in Stage 4A/4B.
- **Option C, water-level recording creation:** would require reproducing the recording session's live-fix-gated creation flow (Stage 3B territory) and touches the same IndexedDB store recording already owns — meaningful, but a recording-pipeline change, not a "water" change per se.
- **Option D, deferred reliability work** (auto-reconnect, unfinished-session recovery, wake locks): improves robustness of already-shipped Stage 3B functionality; no new user-facing capability, but reduces real operational risk for a farmer relying on this app in the field.

No single option is obviously blocked by another. Given the actual workflow this app serves (a single farmer checking one recommendation before manually operating one physical gate), **Option D** has a credible case for priority: Stage 4B's recommendation is only as trustworthy as the GNSS/recording pipeline feeding the rest of the app, and reliability gaps there (silent reconnect failures, an unrecoverable interrupted session) directly undermine confidence in a tool meant to reduce a farmer's guesswork. Option A is the next-best case since it is genuinely small and directly extends what Stage 4B just built. This is an analysis for the next authorization, not a decision — do not start any of these automatically.

## 6. Historical Stage 4A completion checkpoint

### 2.1 The finding that shapes everything else

**"Water" is two unrelated persisted things.** Any future agent that misses this will build the wrong thing.

| | Water control point | Water level reading |
|---|---|---|
| Meaning | A **location**: 水門 gate / 給水口 inlet / 排水口 outlet / 水位センサ sensor / 撮影地点 photo | A **reading**: a number at a position and time |
| Store | `localStorage["suimonNaviFieldAnnotationsV2"]` → `waterControlPoints` | IndexedDB `suimon-navi-recording` v1 → `markedObservations` where `observationType === "water_level"` |
| Built by | `buildWaterControlPoint()` — `js/fields/field-annotation-core.js:323-342` | `buildMarkedObservation()` — `js/recording/recording-core.js:197-225` |
| Coordinates | `coordinates: [lat, lon]` tuple | named `latitude` / `longitude` |
| Field link | **`relatedFieldId`** | `fieldId` |
| Lifecycle | Standalone; **unlinked** (not deleted) when its field is deleted | **Child of a recording session**; cascade-deleted with it |
| Unit | n/a | **None in the schema.** "cm" exists only in a UI label, `index.html:2705` |

Nothing links them. A 水位センサ control point marks where a sensor sits and holds no reading. They are modelled as two domain types, two repositories, two map layers, two selected-entity types.

### 2.2 Migrated functionality

**Water control points (read + create):**
- Load from the annotation store; malformed child records are skipped with a counted warning rather than rendered at NaN.
- Render on the persistent map as their own layer; click selects; the inspector shows type (label + persisted string), `[lat, lon]`, field link, created time, source, and memo.
- Create from **current QZ1 fix** or **one explicit map click**. These are the only two positions legacy supports — there is no phone-GPS path for water, so none was added.
- Naming, ids and record construction delegate to unchanged `nextWaterControlName()`, `makeId('wcp')` and `buildWaterControlPoint()`. Per-(field, type) numbering matches legacy.
- Orphaned points (`relatedFieldId === null`) are listed separately, because legacy keeps drawing them on the map while reports and the decision count silently omit them.

**Water level readings (read-only):**
- Loaded across all sessions via the unchanged `RecordingStore.readAll()`; only `observationType === "water_level"` is adapted.
- Rendered as a visually distinct layer, selectable, with an inspector showing the reading, position, time, field link, raw fix quality/satellites/HDOP/augmentation, source and session.
- **Never created or modified by React.**

### 2.3 Persistence — exact behaviour

- Key `suimonNaviFieldAnnotationsV2`, `schemaVersion` **3** (note the `V2` in the key name despite version 3 — do not rename either).
- Writes emit an **explicit seven-key literal** in this order: `schemaVersion`, `fields`, `boundaryTracks`, `waterControlPoints`, `surveySessions`, `fieldObservations`, `workflowState`. Sibling datasets round-trip untouched.
- **Reads never write.** Verified by asserting stored bytes are unchanged after a read.
- **Fail closed on write** when: storage is unreadable, JSON is malformed, `schemaVersion !== 3`, or **any** of the five arrays is malformed — including arrays water does not own, because writing would persist a silently normalized version of them. The malformed bytes are left exactly as found.
- A persisted record has exactly these keys: `id`, `name`, `type`, `relatedFieldId`, `geometryType`, `coordinates`, `properties{memo, sourceType, createdAt, updatedAt}`. **No `label` key** (field observations have one; water does not).
- `type` persists the **long** exported string: `water_gate` / `water_inlet` / `water_outlet` / `water_level_sensor` / `photo_point`. Short keys (`gate`…) drive labels and styling only. This is the **opposite** of field observations, which persist the short key. An unknown type normalizes to `gate` → `water_gate`.
- Coordinates are `[lat, lon]`, Leaflet order, never GeoJSON.
- `properties.sourceType` is written verbatim; Stage 4A writes only the two legacy values `manual_map_click` and `qz1_current_position`.
- **`properties.updatedAt` is not durable.** Legacy rehydration re-runs each stored point through the builder with `nowIso: properties.createdAt`, resetting `updatedAt` every page load. Do not build UI or tests that expect an edit timestamp to survive a reload.
- IndexedDB is **read-only** in Stage 4A: database version, store names and record shapes are untouched.

### 2.4 Two legacy behaviours worth knowing before you change anything

1. **There is no outside-field check for water.** `isPointInsideBoundary` is called exactly once in the entire 1,928-line legacy controller — inside the *observation* map-click handler (`js/fields/field-annotation-controller.js:967`). Water placement (`createWaterControlPoint`, `:833`) persists unconditionally. Stage 4A therefore shows a **non-blocking** note for an outside position and saves normally. Do not add a Save-Anyway gate for water; that would invent semantics observations have and water does not.
2. **A stored `waterLevel` of `0` usually means "left blank".** The builder's default parameter is `waterLevel = null`, and `Number(null) === 0` passes its finiteness check (`js/recording/recording-core.js:199,218`), so a blank input *and* an omitted argument both persist as `0`. A stored `null` only happens for a non-numeric value. The adapter preserves the raw value; the inspector explains a zero rather than showing it as a measured depth. A test pins this.

### 2.5 Architecture

```
localStorage annotation store          IndexedDB recording store
  waterControlPoints                     markedObservations (water_level)
        │                                        │
  LegacyWaterControlRepository           RecordedWaterMeasurementRepository
  (list/get/create, sync snapshot)       (read-only, async snapshot)
        │                                        │
  useWaterControlSnapshot()              useWaterMeasurementSnapshot()
        │                                        │
        └──────────── WaterWorkspace ────────────┘
                  WaterControlComposer
        │                                        │
  WaterControlLayer  WaterPlacementLayer   WaterMeasurementLayer
        │                                        │
  WaterControlInspector                  WaterMeasurementInspector
```

- Repositories mirror Stage 3C's observation repository: `subscribe`/`getSnapshot` for `useSyncExternalStore`, read error carried **inside** the snapshot (never a second subscription), plain `Error` with operator-facing text ending "…so nothing was saved."
- Map layers each own a long-lived `L.LayerGroup` tied only to the map instance. Data, selection, visibility and route changes never recreate the map or the group.
- Symbols are shape- and glyph-coded, not colour-only: control points are squares with `G`/`I`/`O`/`S`/`P`, readings are diamonds with `L`. Fills reuse the legacy `WATER_CONTROL_STYLES` palette.
- `useWaterPlacementStore` arms **exactly one** map click. Ordinary clicks never create data; Escape and Cancel disarm.
- `SelectedEntity` gained `waterControl` and `waterMeasurement`, **replacing** the never-backed `water`/`sluice` placeholders from Stage 1.
- `MapLayerId` gained `water-measurements` alongside the existing `water-points`.
- Active field remains `useActiveFieldStore`. **No separate "water active field" concept was introduced** — the legacy domain has none. Selecting a water point does not switch the active field; it only changes the inspector. (Selecting a point belonging to another field is possible from the map; the inspector names that field. Revisit only if operators report confusion.)

### 2.6 Compatibility verification (both directions)

- **Legacy → React:** a byte-accurate legacy `water_gate` record (written in the legacy record shape) renders in React with its exact name, memo, `water_gate` type string and `[lat, lon]`; the stored bytes are unchanged afterwards. Covered by unit tests and by the Playwright spec.
- **React → legacy:** a React-created point is fed back through the unchanged `buildWaterControlPoint()` and compared with `toEqual` — byte-identical, same key order, same four `properties` keys, no `label`. The pre-existing legacy record and every sibling dataset survive the write untouched.
- **Legacy browser tests still green:** the 10 existing legacy water cases (`tests/browser/field-annotation.spec.js`) pass unchanged.
- Shared-origin real-data checks still require sequential `npm run dev:new-ui:shared-storage`.

### 2.7 Exact Stage 4A changed files

New:
```text
frontend/src/domain/water/types.ts
frontend/src/domain/water/selectors.ts
frontend/src/domain/water/__tests__/selectors.test.ts
frontend/src/services/water/legacyWaterControlRepository.ts
frontend/src/services/water/recordedWaterMeasurementRepository.ts
frontend/src/services/water/useWaterControlPoints.ts
frontend/src/services/water/useWaterMeasurements.ts
frontend/src/services/water/__tests__/legacyWaterControlRepository.test.ts
frontend/src/services/water/__tests__/recordedWaterMeasurementRepository.test.ts
frontend/src/store/useWaterPlacementStore.ts
frontend/src/components/map/layers/waterSymbols.ts
frontend/src/components/map/layers/WaterControlLayer.tsx
frontend/src/components/map/layers/WaterMeasurementLayer.tsx
frontend/src/components/map/layers/WaterPlacementLayer.tsx
frontend/src/components/map/layers/__tests__/WaterLayers.test.tsx
frontend/src/features/water/WaterWorkspace.tsx
frontend/src/features/water/WaterWorkspace.css
frontend/src/features/water/WaterControlComposer.tsx
frontend/src/features/water/WaterControlInspector.tsx
frontend/src/features/water/WaterMeasurementInspector.tsx
frontend/src/features/water/__tests__/WaterWorkspace.test.tsx
frontend/tests/browser/stage4a-water.spec.ts
```

Modified:
```text
docs/HANDOFF.md
docs/FRONTEND_ARCHITECTURE.md
docs/UI_REDESIGN.md
frontend/src/app/routes.tsx                        (water route -> WaterWorkspace)
frontend/src/app/workspaces.ts                     (recommendedLayers + water-measurements)
frontend/src/components/layout/AppShell.tsx        (mount three water layers)
frontend/src/components/layout/InspectorPanel.tsx  (dispatch both water entity types)
frontend/src/components/map/MapWorkspace.css       (water symbol styles)
frontend/src/store/useMapLayersStore.ts            (water-measurements layer id)
frontend/src/types/selection.ts                    (waterControl/waterMeasurement)
frontend/src/store/__tests__/useSelectedEntityStore.test.ts  (uses waterControl)
```

Deleted:
```text
frontend/src/features/water/WaterInspector.tsx     (Stage 1 placeholder, superseded)
```

### 2.8 Stage 4A verification results

| Check | Result |
|---|---|
| `npm test` in `frontend/` | **36 files, 149/149 passed**, 0 failed, 0 skipped (baseline before Stage 4A: 31 files, 106/106) |
| `npm test` at repository root | **194/194 passed**, 0 failed, 0 skipped |
| `node --test tests/unit/field-annotation-core.test.js tests/unit/recording-core.test.js tests/unit/field-report.test.js` | **55/55 passed** |
| Legacy water browser cases, `npx playwright test tests/browser/field-annotation.spec.js --grep "水管理\|water\|水門"` | **10/10 passed** |
| React acceptance, `npx playwright test --config frontend/playwright.config.ts` | **4/4 passed** (2 pre-existing + 2 new Stage 4A) |
| `npx tsc -b` | passed |
| `npx vite build` | passed |
| `npm run lint` | passed with the one pre-existing warning |
| Backend pytest | **Not run.** Stage 4A changed no backend, API, MAVLink or command file. See §2.10 — the backend worktree is being edited concurrently by unrelated work, so a run would not attribute cleanly. |

Failure classification: **no Stage 4A regression, no pre-existing failure, no unrelated failure observed in any suite that was run.** Two failures occurred *during development* and were both defects in my own new test file, fixed before completion: a `.catch()` on a Playwright locator, and an `addInitScript` that re-seeded localStorage on reload and so masked persistence. Neither was a product defect.

Viewport acceptance, asserted inside the Playwright spec with the water composer open at **1366×768, 1920×1080 and 1024×768**: `scrollWidth === clientWidth === viewport.width` and `scrollHeight === clientHeight === viewport.height` at every size (no document-level scrolling), the map keeps more than half the viewport width, the inspector stays within bounds, and both position buttons stay visible and reachable.

### 2.9 Existing advisories (unchanged in kind, quantified)

- **Vite >500 kB chunk advisory** — pre-existing. Stage 4A moved the bundle from 515.37 kB / 157.05 kB gzip to **536.98 kB / 160.46 kB gzip** (+21.6 kB raw, +3.4 kB gzip, 112→126 modules). Not a build failure; no warning limit was raised to hide it; no speculative code splitting was done.
- **One pre-existing `react-refresh/only-export-components` lint warning** in `frontend/src/app/routes.tsx`. Stage 4A adds none.
- **Backend proxy aborts** (`ws proxy error: write ECONNABORTED`) appear in Playwright output when the optional backend is not running. Expected; Stage 4A has no backend dependency.

### 2.10 Unrelated dirty files that must remain untouched

Concurrent pilot / gamepad / manual-control / MAVLink work is **actively in progress in this worktree**. During this Stage 4A session, `backend/app/mavlink/pilot_limits.py` and `backend/app/mavlink/pilot_service.py` were modified on disk at 12:42 local — after Stage 4A's last source write (12:33) and while its tests were running. Stage 4A did not create, edit, revert, stage or run those files.

Preserve all pre-existing changes under `backend/`, `js/gamepad/`, `js/pilot/`, `css/pilot.css`, pilot/gamepad/MAVLink docs and tests, `index.html`, `scripts/dev.ps1`, `scripts/run-backend.mjs`, `.claude/launch.json`, `docs/CLAUDE_HANDOFF.md`, and the root `package.json`.

### 2.11 Deferred work

- **Stage 4B — water decision logic** (see §3 below for the proposed boundary).
- Water control point **editing and deletion**; water level reading **creation**.
- **Stage 2B** manual field drawing/editing; field deletion.
- Observation editing/deletion/photos.
- Automatic serial reconnect; unfinished-session recovery; wake locks.
- Paddy Intelligence, Reports, AI/camera, drone missions, manual flight, MAVLink changes.
- Schema convergence across the four export formats; concurrent same-origin `/new/` mounting.

## 7. Historical Stage 3C completion checkpoint

Stage 3C is complete at the smallest safe boundary: a saved annotation boundary track or valid recorded GNSS fixes can be previewed and registered through the existing `FieldRepository`; the supported survey/session `fieldId` link is updated; manual note/weed/insect/disease observations can be previewed from current GNSS or an explicit map click, saved into the existing annotation schema, rendered on the persistent map, and inspected.

### Survey to field conversion

- `prepareSurveyBoundary()` is a typed, side-effect-free adapter. An explicit legacy `boundaryTrack.coordinates` is authoritative when present. Otherwise it uses valid (`fixValid !== false`) session/recording fixes. Malformed non-finite coordinates are excluded; no geographic range or accuracy threshold is invented.
- Coordinates remain **`[lat, lon]`**. Duplicate and repeated points remain in their recorded order because the legacy registration path does not silently deduplicate them. At least three usable points are required.
- `evaluateClosure()` and `validateBoundary()` remain authoritative. Fewer than three points is a hard failure. Large closure gaps and self-intersection retain legacy's non-fatal semantics but require an explicit preview acknowledgment before React will save.
- `SurveyBoundaryPreviewLayer` draws a temporary dashed polygon on the existing map. Cancel/unmount removes it without persistence.
- Registration calls `FieldRepository.create()` only. `CreateFieldInput` carries the existing `sourceSessionId`, source filename/type, point count, quality summary, and optional source-track link. The repository still delegates record construction, area, gap, and IDs to the unchanged legacy helpers.
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
- `isPointInsideBoundary()` is the authoritative outside-field check **for observations**. An outside candidate shows a warning and requires the explicit **Save Anyway** action, matching legacy semantics; no auto-snap occurs. (Stage 4A later confirmed this check exists *only* for observations, never for water points.)
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
- React Playwright acceptance: **2/2 passed**.
- Focused legacy observation browser tests: **3/3 passed**.
- `npx.cmd tsc -b`, `npx.cmd vite build`: passed (112 modules; JS 515.37 kB / 157.05 kB gzip, CSS 26.58 kB / 8.62 kB gzip).
- `npm.cmd run lint`: passed with the one pre-existing warning.
- **1366×768, 1920×1080, and 1024×768**: no document scrolling; the inspector scrolls internally.

## 8. Historical Stage 3B completion checkpoint

- `SerialGnssService` is the sole React owner of `navigator.serial`. It requests ports without USB filters (preserving USB and Bluetooth SPP support), reuses a previously granted port when available, opens at 4800/9600/38400/115200 baud (115200 default), frames CR/LF-delimited input with an 8192-character guard, and delegates parsing to the unchanged `js/gnss/nmea-parser.js`.
- Connection state is explicit: unsupported, disconnected, requesting, opening, connected, stalled, disconnecting, or error. A valid current fix is cleared on disconnect; stale state is visible after 10 seconds without input. Clean disconnect closes the reader and port. Reconnect is an explicit operator action; the legacy page's bounded automatic reopen attempts are not copied into React.
- `useLiveGnssStore` owns the low-frequency UI snapshot. Imperative `CurrentGnssLayer` and `LiveSurveyLayer` subscriptions localize high-frequency Leaflet updates instead of re-rendering the application shell.
- `RecordingService` delegates IDs and recording transitions to the unchanged `js/recording/recording-core.js` and writes through the unchanged `js/recording/recording-store.js`. It batches writes at 25 records or one second, assigns one monotonic sequence across raw-line and structured-fix records, and requeues a failed batch without duplicating records.
- Starting is allowed without a fix and records an explicit null field link when no field is active. When a field is active, its id/name are copied into the existing session fields. Stopping flushes pending data before marking the session stopped. Disconnect does not invent points or silently stop the session.
- An existing unfinished IndexedDB session blocks a new React recording; React deliberately does not implement legacy session resume/recovery UI. **(Superseded by Stage 5A, §2 — recovery is now implemented with explicit Resume / Finish & Save / Discard choices. The blocking behavior itself is unchanged.)**
- Persistence authority is IndexedDB **`suimon-navi-recording` version 1**, stores `sessions`, `rawNmeaLines`, `structuredFixes`, `markedObservations`, `imageBlobs`. Stage 3B writes only the first three. (Stage 4A later reads `markedObservations`, still without writing.)
- Live and persisted positions use named `lat`/`lon`. The annotation boundary tuple authority remains **`[lat, lon]`**. No GeoJSON conversion occurs.
- GNSS quality remains raw/authoritative; React introduces no new thresholds.

### Stage 3B verification

- `frontend/` **27 files, 93/93 passed**; root **194/194**; focused node tests **49/49**; React Playwright **1/1**; legacy browser cases **4/4**; `tsc -b` and `vite build` passed (101 modules; JS 497.66 kB / 152.82 kB gzip); lint passed with the one pre-existing warning.
- Automated checks at **1366×768, 1920×1080, 1024×768**: no document-level scroll.

## 9. Historical Stage 3A completion checkpoint

- Persistence authority remains `localStorage["suimonNaviFieldAnnotationsV2"]`, schema version `3`. Stage 3A reads only `surveySessions` and `boundaryTracks`; no writes, no schema change.
- `surveySessions[].rawPoints` persist positions as named `{ lat, lon }`. `boundaryTracks[].coordinates` persist tuples as **`[lat, lon]`**. `SurveyLayer` converts only at its Leaflet view boundary.
- `LegacySurveyRepository` validates the store version, adapts valid records, surfaces malformed child records as warnings, reports unreadable/malformed/unsupported storage as an error, and never rewrites source bytes.
- A display record is a saved session optionally joined through `boundaryTracks[].sourceSessionId`. Orphan boundary tracks remain visible as `boundary-track:<id>`.
- `SurveyLayer` and `FieldLayer` own separate persistent `LayerGroup`s on the one map.
- `parseSurveyNmeaPreview()` is a typed ephemeral wrapper over the unchanged parser; there is no import UI.

### Stage 3A verification

- `frontend/` **22 files, 79/79**; root **194/194**; focused node tests **40/40**; one legacy browser case **1/1**; `tsc -b` and `vite build` passed (91 modules; JS 469.62 kB / 144.66 kB gzip); lint exit 0 with the one pre-existing warning.
- **1366×768, 1920×1080, 1024×768**: no document-level scrolling.

## 10. Historical Stage 2 checkpoint

- A typed `FieldRepository` adapter over `localStorage["suimonNaviFieldAnnotationsV2"]`, schema v3.
- The persisted flat `field.coordinates` annotation record is authoritative. The assurance-only in-memory `FieldRegistry` is not used as storage.
- Exact legacy `[lat, lon]` order, field shape, area function, normalization, and seven-key write payload are preserved.
- Representative legacy-v3 reads do not rewrite storage. Malformed/inaccessible/non-v3 bytes fail closed on mutation; read failures are visibly different from an empty store.
- `useActiveFieldStore` stores only `activeFieldId`; the record is derived from the live repository. Reconciliation clears a stale ID and its matching inspector selection.
- `FieldLayer` owns persisted polygons on one long-lived `LayerGroup`. Selector and polygon clicks update the same active-field and selected-entity state.
- New Field, Edit Boundary, and Delete remain visible but disabled; deletion is not part of `FieldRepository`, because the annotation store's cascade does not cover recording IndexedDB `fieldId` values, vegetation field references, or assurance copies.
- Name/memo are the only editable fields.
- `npm run dev:new-ui:shared-storage` provides a sequential same-origin compatibility mode on `localhost:4173`.

### Stage 2 verification

| Check | Result |
|---|---|
| `npm.cmd --prefix frontend test` | 18 files, **65 passed** |
| `npm.cmd --prefix frontend run build` | TypeScript + Vite build passed |
| `npm.cmd --prefix frontend run lint` | Exit 0; one existing warning |
| `npm.cmd test` | **194 passed** |
| `npm.cmd run test:backend` | **273 passed** |
| focused legacy field/assurance browser tests | **51 passed** |

### Stage 2 unresolved questions (still open)

- Where should the built React app be mounted for concurrent same-origin operation: `/new/` beside legacy, or eventually at `/`?
- For each non-annotation reference to a removed field, should deletion cascade, unlink, retain a tombstone, or remain prohibited?
- Should Stage 2B manual map clicks be modeled as explicit polygon vertices rather than reusing walked-track closure-gap semantics?
- When should field-ID rename and import/export schema compatibility be exposed in React?
