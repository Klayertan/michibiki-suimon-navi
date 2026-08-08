# Gamepad operator guide

The gamepad panel described here is **input preview only**: it visualizes
calibration and normalization and transmits nothing. Its modules contain no
network transport at all, and an automated test keeps it that way.

Low-speed flight control is a separate, opt-in feature that lives in
`js/pilot/` and a distinct backend service. It reuses the same input providers
but nothing else. See **[PILOT_CONTROL_GUIDE.md](PILOT_CONTROL_GUIDE.md)** —
read it before enabling anything that can move an aircraft.

## A. Test now without hardware

1. Start SuisuiNavi in development mode and open `http://127.0.0.1:8000/?gamepadMock=1#survey`.
2. Open **PS5コントローラー / Gamepad**.
3. Expand **シミュレーション / Simulated Gamepad** and select **接続**.
4. Complete all eight calibration steps, moving both stick sliders to their extremes and exercising triggers/dead-man, then save.
5. Move the simulated sticks and compare raw, normalized, and Mode 2 preview values.
6. Hold and release L1 (or configure R1); release must immediately show zero gated outputs.
7. Use sudden disconnect, sample staleness, and focus-loss simulation.
8. Confirm every gated output returns to zero and the inactive reason is shown.
9. Confirm the network inspector shows no aircraft command request. Closing the simulator panel resets it to neutral.

Without `?gamepadMock=1`, simulator controls are absent. Simulation data is calibration/input state only and is never aircraft telemetry.

## B. Test later after buying a controller

1. Connect DualSense using USB-C.
2. Verify it in Windows using `joy.cpl`.
3. Open SuisuiNavi (the simulator query parameter is unnecessary).
4. Confirm controller ID, mapping, axes, and buttons in the raw monitor.
5. Perform and save a fresh calibration for that controller ID.
6. Compare every physical input against the visual monitor; do not infer correctness from the “DualSense hint”.
7. Test dead-man press and release.
8. Test cable disconnect and confirm all gated values become zero.
9. Do not connect or power the aircraft during the first physical-controller validation.

Physical DualSense validation is **NOT EXECUTED** in Phase 1.

## C. Keyboard input source

The keyboard is selectable as an input source in the same panel, and drives the
same axes as a stick. Capture is explicit: nothing is intercepted until
**キーボードをキャプチャ / Capture keyboard** is pressed, and keys are ignored
while a text field, textarea, select or editable region has focus.

| Key | Axis (preview) | Meaning when flying |
|---|---|---|
| ↑ / ↓ | pitch | forward / backward |
| ← / → | roll | left / right |
| W / S | vertical | climb / descend |
| A / D | yaw | yaw left / yaw right |
| Space | all axes to zero | movement neutral — **not** a motor kill |
| Left Shift (hold) | dead-man (preview gate) | — |
| Esc | zero + stop capture | — |

In the *preview* panel the dead-man gate applies, so released Shift shows zero
gated output. The pilot panel does not use the dead-man; its equivalents are
Space, focus loss, and the backend's 0.5 s input timeout.

Space and the mapping above are shared with the pilot panel deliberately: an
operator practises the same keys in preview that they will use in flight.

## D. Bluetooth test later

1. Pair DualSense through Windows Bluetooth settings.
2. Verify it appears in `joy.cpl`.
3. Repeat calibration and save the record for the reported controller ID.
4. Compare mapping with USB calibration.
5. Record axis/button/ID differences.
6. Do not assume USB and Bluetooth IDs or mappings are identical.
