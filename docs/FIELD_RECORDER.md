# QZ1 Field Recorder

Android/desktop field-recording layer built on top of the shared Web Serial
pipeline. Connection state (is QZ1's serial link open?) and recording state
(is a session actively capturing to IndexedDB?) are independent state
machines — connecting to QZ1 never implicitly starts a recording session.

## Architecture

| File | Role |
|---|---|
| `js/recording/recording-core.js` | Pure logic: state machines, NMEA checksum verification, 4-tier stall diagnostics, observation validation, CSV builders. Unit-tested with `node --test`. |
| `js/recording/recording-store.js` | IndexedDB wrapper: `sessions`, `rawNmeaLines`, `structuredFixes`, `markedObservations`, `imageBlobs`. |
| `js/recording/recording-controller.js` | Browser controller: recording lifecycle, batched flush, wake lock, recovery workflow, camera capture, exports. |
| `css/recording.css` | Panel styles, including the mobile "field mode" layout. |
| `index.html` | フィールド記録 card in the QZ1測量 workspace + `setConnectionState`/ingestion hooks layered onto the existing shared serial pipeline. |

## Diagnostics: four tiers, not one generic stall

Byte reception, complete-line reception, checksum-valid reception, and
valid-fix reception are tracked as four separate timestamps
(`diagTimes.lastByteMs/lastLineMs/lastChecksumMs/lastFixMs`). The banner
shows the single most fundamental problem:

1. **`not-connected`** — no successful connection yet this page session (neutral).
2. **`no-data`** — connected, but not one byte has arrived yet (neutral).
3. **`byte`** — bytes were previously received and have now gone silent past
   the threshold (genuine stall — the *only* tier styled as an alert here).
4. **`line`** — bytes flowing, no complete NMEA sentence forms (alert).
5. **`no-fix`** — sentences arriving, no fix acquired yet (neutral — GPS cold
   starts can take a while).
6. **`stale-fix`** — a fix was acquired before but is now old (alert).

Tiers 1–2 and 5 are neutral by design: nothing has gone wrong, the session
simply hasn't reached that milestone yet. The stalled/alert tiers only ever
fire once the corresponding signal has been observed at least once and then
goes quiet past its threshold — see `classifySerialDiagnostics()` in
`recording-core.js`.

## Raw NMEA integrity

- Each `rawNmeaLines` record stores exactly one complete NMEA sentence per
  incoming line (`ingestSerialLine` pushes one record per call while
  recording — verified by a test that streams N sentences and checks the
  persisted count equals N exactly).
- The stored sentence is **terminator-stripped by construction** (CRLF/CR/LF
  cannot survive index.html's line-splitting) and has already passed through
  that pipeline's mid-line `$G` recovery for logger-prefixed input — it is
  the same complete sentence actually used for parsing and checksum
  verification, not raw pre-split wire bytes with an original prefix intact.
- `exportRawNmea()` reconstructs a standards-conformant NMEA-0183 file by
  joining stored sentences with CRLF, so the exported `.nmea` file has
  exactly one complete sentence per line.

## Recording state machine

`idle --start--> recording --pause--> paused --resume--> recording --stop--> stopped --start--> recording (new session)`,
plus `recovery_available --resume/finish/delete-->`. `nextRecordingState()`
returns `null` for invalid transitions.

`pauseRecording()`/`stopRecording()` flip `recordingState` **before**
awaiting the flush, not after — `ingestSerialLine` only counts/queues a
sentence while `recordingState === "recording"`, so a sentence arriving
during the flush's own `await` is cleanly rejected instead of being counted
in session metadata but never actually persisted.

## Resumed-session uniqueness

- `resumeSession()` only changes recording state; it never touches the
  serial connection subsystem, so it cannot start a second serial read loop.
  The user must separately reconnect QZ1 after a reload.
- `sessionSeq` (one monotonic counter shared by `rawNmeaLines` and
  `structuredFixes` per session) is restored via `store.getMaxSeq(sessionId)`
  on resume — **not** reset to 0 — so newly ingested records after a
  reload+resume continue the existing sequence rather than colliding with
  what was already persisted before the crash/refresh.
- A `recoveryInProgress` re-entrancy guard makes `resumeSession()` a no-op
  while a resume is already in flight, so a double-tap on "再開する" cannot
  fire two overlapping resumes; the recovery card's action buttons are also
  disabled for the duration.

## Image storage safeguards

- Photos are resized (configurable max long edge, default 1920px) and
  re-encoded as JPEG (configurable quality, default 0.8) before ever
  touching IndexedDB.
- If the result still exceeds a configurable max size (default 2MB), quality
  is stepped down and, if that's not enough, the target dimension is shrunk
  further — a bounded handful of attempts, never an unbounded loop.
- If compression still can't meet the cap (or fails outright), the failure
  is caught and reported; **the observation can still be recorded without a
  photo** — a missing/oversized image never blocks recording a position.
- Estimated image-storage usage for the active session is displayed
  separately from the browser-wide storage estimate.

## Recommended workflow

1. Connect QZ1 (USB or Bluetooth SPP) — this only opens the serial link.
2. Explicitly press 記録開始 to start a session (separate action).
3. Use 一時停止/記録再開 as needed; 現在地を記録 marks the latest valid fix
   as an observation (refuses when the fix is missing or stale).
4. 記録終了 ends the session; if the page crashes/reloads mid-recording, the
   recovery card on next load offers Resume / Export / Finish / Delete
   without discarding the unfinished session.
5. Export raw `.nmea`, structured fixes `.csv`, the complete session
   `.json`, or marked observations `.csv`/`.json` — all read from IndexedDB,
   never only from the in-memory queue.

## Known limitations

- True Android background suspension (screen lock, Chrome backgrounded) and
  physical QZ1 Bluetooth reconnect behavior cannot be verified without a
  real device — the Wake Lock is requested but is not a background-execution
  guarantee, and the app says so in the UI.
- `beforeunload` shows the browser's own generic confirmation only; modern
  browsers do not allow a custom message.

## Hardware-validation checklist

Automated tests use a fake `navigator.serial` port and cannot exercise real
hardware, real Android power management, or real Bluetooth Classic SPP
behavior. Before relying on this feature in the field, validate manually:

- [ ] **Device/OS**: record the Android model and Android version used.
- [ ] **Browser**: record the Chrome version (`chrome://version`).
- [ ] **Pairing**: QZ1 pairs successfully over Bluetooth Classic SPP in
      Android's Bluetooth settings.
- [ ] **Chooser**: QZ1's paired virtual serial port appears in the Web
      Serial port chooser when pressing 接続 (confirms it isn't filtered out
      as BLE-only or hidden by the OS).
- [ ] **10-minute stability**: connect and record continuously for at least
      10 minutes with the screen on; confirm no unexpected disconnects and
      that `recByteAge`/`recLineAge`/`recFixAgeDetail` stay low throughout.
- [ ] **Screen-lock behavior**: lock the screen while recording for 1–2
      minutes, then unlock; note whether reception actually paused (check
      `recByteAge` for a gap) despite the Wake Lock, and record the observed
      Android/Chrome combination's behavior.
- [ ] **Reconnect behavior**: physically disconnect QZ1 (power off, walk out
      of Bluetooth range, or unplug USB) mid-recording; confirm the app
      surfaces a genuine `byte`-tier stall (not silence) and that manual or
      automatic reconnect resumes reception without restarting the session.
- [ ] **Recovery after reload**: force-quit or reload the browser tab
      mid-recording (not via 記録終了); confirm the recovery card appears on
      next load with accurate stored-line/fix counts and that Resume
      continues the same session without seq collisions.
- [ ] **Export validation**: after a real recording, export all five formats
      and open them in an external tool (e.g. a text editor for `.nmea`, a
      spreadsheet for the `.csv` files) to confirm the data is readable and
      matches what was actually captured.
