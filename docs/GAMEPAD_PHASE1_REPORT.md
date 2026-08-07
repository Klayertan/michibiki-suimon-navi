# Gamepad Phase 1 implementation report

## Summary and architecture

The original application was a static ES-module frontend with independent feature controllers/stores and a separate FastAPI MAVLink backend. Phase 1 adds a frontend-only pipeline:

`Browser Gamepad API or MockGamepadProvider → shared sample model → calibration/normalization → preview-only UI`

`BrowserGamepadProvider` listens for connect/disconnect, polls `navigator.getGamepads()` with `requestAnimationFrame`, and does not depend on controller names. “DualSense”, “Wireless Controller”, and Sony names are hints only. Browsers normally do not reliably expose USB versus Bluetooth transport, so the UI makes no transport claim. `MockGamepadProvider` emits the same sample shape and identifies itself as `provider: mock`, `Simulated DualSense Controller`, standard mapping, four axes, and 18 buttons. This does not prove a physical DualSense mapping.

The simulator is available only with `?gamepadMock=1`, never activates automatically, is prominently marked SIMULATION, resets when closed, and has no network transport. Browser and mock samples share calibration, normalization, gating, and rendering.

## Calibration and normalization

The eight-step workflow records neutral state, stick ranges, trigger travel, dead-man use, review, and save. Records that lack required arrays or have an axis range below 0.5 are rejected. The UI reports incomplete calibration instead of activating preview output. Axis samples track min/max/centre; the pure core supports asymmetric `(raw-centre)/(max-centre)` or `(raw-centre)/(centre-min)`, inversion, axial and radial deadzones with post-deadzone rescaling, cubic blend expo, trigger rest/full normalization, noise suppression, neutral/drift/noise detection, and safety gating.

IndexedDB database `suisuinavi-gamepad`, store `calibrations`, uses controller ID keys. Schema v1 stores controller/mapping/counts/timestamps, centres/minima/maxima/inversions/deadzones/expo, trigger ranges, dead-man index, warnings, and validation state. Unknown schemas and malformed records are rejected. Save/load/delete/default-reset and per-controller records are supported.

## Safety design

Mode 2 is preview-only: left X = yaw, left Y = vertical input preview, right X = roll, right Y = pitch. Final gated values are zero unless the controller is connected, the document is focused and visible, the sample is fresh, calibration is valid, and the configured dead-man (simulation default L1) is held. Losing any condition zeros the preview immediately and displays the reason. Dead-man is never Arm.

A spring-centred DualSense left stick cannot automatically be treated as traditional RC throttle. Future choices include centred climb/descent rate in ALT_HOLD/GUIDED, full-down-to-zero mapping, QGroundControl-style joystick behavior, or speed-limited vertical velocity. Phase 1 selects none.

The gamepad directory has no API client, `fetch`, XHR, WebSocket, backend dependency, MAVLink unit conversion, or aircraft command sender. Automated source assertions prohibit manual control, RC override, attitude/position target, arm/takeoff/land/motor-test tokens and network transports in gamepad modules. Existing MAVLink restrictions remain unchanged.

## Files

Added: `js/gamepad/gamepad-provider.js`, `browser-gamepad-provider.js`, `mock-gamepad-provider.js`, `gamepad-normalization.js`, `gamepad-calibration.js`, `gamepad-storage.js`, `gamepad-controller.js`, `css/gamepad.css`, three gamepad unit test files, `tests/browser/gamepad.spec.js`, this report, and `docs/GAMEPAD_OPERATOR_GUIDE.md`. Modified: `index.html` only, to load the stylesheet, host the panel, and mount the controller.

## Test record and limitations

Baseline: Node unit 127/127 passed; backend pytest 218/218 passed. The baseline Playwright suite initially could not launch because Chromium headless shell revision 1228 was not installed; all 143 cases failed before page execution. Chromium was then installed and the focused mocked-gamepad Playwright suite passed 5/5. A subsequent full browser run exceeded the command time limit after approximately 704 seconds and produced no final result, so it is not claimed as passing. `npm.cmd` was unavailable in the provided shell, so equivalent scripts were invoked with the bundled Node executable. Final exact results are recorded at handoff.

No physical DualSense test was executed because no controller is available. USB/Bluetooth IDs, mapping, touchpad, haptics, and real-device browser behavior remain unvalidated. Calibration inversion is represented in the schema/core but physical mapping must be reviewed after hardware purchase. Phase 1 deliberately implements no flight behavior.

## Rollback and next phase

Rollback without history rewriting: remove the added gamepad files and revert only the three `index.html` gamepad insertions. Do not alter MAVLink files.

Recommended Phase 2: run the same normalized/gated stream against ArduPilot SITL only, add a separate opt-in command adapter guarded by backend allowlists and vehicle state, define vertical-control semantics, implement watchdog/limits, and validate failure injection before any powered aircraft test.

Final `git status` and `git diff --stat` are captured in the handoff rather than frozen here because they change while this report is written.
