# QZ1 / QZ1LE Connectivity

How SuiSuiNavi acquires NMEA-0183 data from a QZ1 or QZ1LE receiver, on each
platform, and exactly what is (and is not yet) verified for QZ1LE.

## QZ1 vs QZ1LE

| | QZ1 (blue receiver) | QZ1LE |
|---|---|---|
| Field-tested in this repo | Yes (see [README.md](../README.md)) | No |
| Output | NMEA-0183 | NMEA-0183 |
| Transports | USB serial; Bluetooth **Classic** (SPP virtual serial port) | Bluetooth **Low Energy** 4.0 only |
| App transport | Web Serial (USB and Bluetooth Classic SPP both appear as the same kind of serial port) | Web Bluetooth (GATT) |
| GATT profile known? | N/A (not BLE) | **No — see below** |

QZ1 and QZ1LE are different receivers with different Bluetooth stacks. A
Bluetooth Classic SPP virtual port (what QZ1 uses) and Bluetooth Low Energy
GATT (what QZ1LE uses) are unrelated at the OS/browser level: Web Serial only
ever sees the former, Web Bluetooth only ever sees the latter. That is why
QZ1LE needs its own transport (`js/recording/qz1le-bluetooth.js`) rather than
reusing the Web Serial code path.

## The one thing every workflow below feeds

Every acquisition method -- Web Serial, Web Bluetooth, or a plain file --
ends up at the same place: `handleSerialLine()` in `index.html` (live
transports) or the shared NMEA session parser (`js/gnss/nmea-parser.js`, file
import). None of the code described in this document parses NMEA itself; it
only gets a complete raw line to that shared pipeline. See
[FIELD_RECORDER.md](FIELD_RECORDER.md) for that pipeline's own details
(diagnostics, recording state machine, storage).

```
QZ1LE ↘ Web Bluetooth (GATT) ─┐
                               ├─→ handleSerialLine() → parser → session/observations → map / field boundary
QZ1   ↗ Web Serial (USB/SPP) ─┘

QZ1 / QZ1LE (via any app,          NMEA file import
including GNSS Analyzer) ────────→ (js/gnss/nmea-parser.js) → same session/observations
```

## By device

| Device | Route |
|---|---|
| Windows PC | QZ1LE → Chrome / Edge → Bluetooth → SuiSuiNavi |
| Android | QZ1LE → Chrome → Bluetooth → SuiSuiNavi |
| iPhone / iPad | QZ1LE → GNSS Analyzer → NMEAログ → SuiSuiNavi |
| USB対応PC | QZ1 / QZ1LE → USB → Web Serial → SuiSuiNavi |

This table is also rendered in the app itself (端末別の接続方法, in the
QZ1測量 card's デバイス section) and backed by
`DEVICE_COMPATIBILITY_GUIDE` in `js/recording/qz1-acquisition-methods.js` --
keep both in sync if either changes.

### Desktop Chromium (Windows / macOS / Linux, Chrome or Edge)

Both transports are available:

- **QZ1（USB / Bluetooth SPP）** via Web Serial -- unchanged, field-tested.
  See [FIELD_RECORDER.md](FIELD_RECORDER.md).
- **QZ1LE（Bluetooth LE）** via Web Bluetooth -- gated on
  `config/qz1le-ble-profile.js` being filled in (see below). Until then the
  option is visible but disabled, with an explanation, not a broken connect
  attempt.

### Android + Chrome

Web Serial is not implemented on Android at all, so only the Bluetooth LE
option (plus NMEA file import) is offered:

- **QZ1LE（Bluetooth LE）** via Web Bluetooth, same gating as desktop.
- QZ1 (classic Bluetooth SPP) has a documented workaround already in the app
  (Serial Bluetooth Terminal → save log → upload) for when Web Serial itself
  is unavailable -- see the fallback steps in the QZ1測量 card and
  [FIELD_RECORDER.md](FIELD_RECORDER.md). That workaround is unrelated to
  QZ1LE and is unaffected by anything in this document.

### iPhone / iPad

Safari has no Web Bluetooth, and **Chrome on iOS is not a workaround** --
every browser on iOS/iPadOS is WebKit underneath, so it has no Web Bluetooth
either, regardless of which browser app is installed. Direct QZ1LE
connection from this app is therefore not possible on iOS/iPadOS, and the
app does not pretend otherwise: instead of a non-functional Bluetooth
button, it shows

> iPhone / iPadではSafariからQZ1LEへ直接Bluetooth接続できません。
>
> 1. GNSS AnalyzerでQZ1LEへ接続
> 2. NMEAログを記録
> 3. ログを保存 / 共有
> 4. SuiSuiNaviでNMEAファイルを読み込む

[GNSS Analyzer](https://apps.apple.com/app/gnss-analyzer) (NEC/QSS) is a
third-party app that connects to compatible QZSS receivers over BLE, and can
record/export an NMEA log. Step 4 uses the same "NMEAをアップロード" /
header "NMEA" button that every other NMEA file already goes through --
nothing QZ1LE-specific was added to file import.

### USB-capable PC

QZ1 or QZ1LE over a USB-to-serial adapter, through Web Serial, same as the
existing QZ1 workflow. (QZ1LE's USB port, where present, is a wired
alternative to its BLE radio -- once it enumerates as a serial port, it is
indistinguishable from QZ1's own USB path to this app.)

## NMEA file import is always available

Regardless of anything above, "NMEAをアップロード" (基本モード, and the
header "NMEA" button on phones) always works, on every platform. This is not
new -- it existed before QZ1LE support and is unaffected by it -- but it is
worth stating plainly: **no combination of unsupported browser, unconfigured
BLE profile, or missing hardware ever blocks NMEA file import.** It is the
one workflow that the iOS/GNSS Analyzer path, and any "browser doesn't
support this" case, always falls back to.

## The unknown QZ1LE GATT UUID problem

QZ1LE speaks NMEA-0183 over Bluetooth Low Energy, but its GATT **service**
UUID and **notify characteristic** UUID -- the two identifiers a BLE client
needs to find the right stream of bytes on the device -- have not been
confirmed against real hardware. `config/qz1le-ble-profile.js` ships with
both set to `null`.

This matters because a wrong guess is worse than an honest "unknown": an
earlier version of this scaffold guessed the Nordic UART Service (NUS)
UUIDs, a common pattern for BLE-to-serial bridge chips, as a placeholder.
That was a mistake to build on, for two reasons:

1. `requestDevice()`'s `services` filter only matches services a device
   actually advertises. If QZ1LE does not advertise NUS (or advertises
   nothing at all, common for GATT-only peripherals), the device picker
   would simply never show it -- indistinguishable from "not connectable"
   even though the receiver is right there, powered on, in range.
2. If QZ1LE *did* happen to expose a matching service for some unrelated
   reason, the app could connect while reading nothing, or garbage --
   *looking* functional while silently not working.

So `config/qz1le-ble-profile.js` ships unset instead, and
`Qz1LeBluetoothTransport.connect()`
(`js/recording/qz1le-bluetooth.js`) refuses outright -- before ever calling
`requestDevice()` -- whenever the profile is not configured. The UI (the
QZ1LE option in デバイス → ソース) stays visible, so people know the feature
exists and is planned, but selecting it explains that the profile still
needs to be identified rather than attempting a connection with invented
UUIDs. This is enforced by unit tests
(`tests/unit/qz1le-bluetooth.test.js`, `tests/unit/qz1le-ble-config.test.js`)
that assert `requestDevice()` is never called when the profile is
unconfigured.

### How to identify the real UUIDs

Requires a physical QZ1LE and a generic BLE inspection app -- **nRF Connect**
(Android/iOS, Nordic Semiconductor) or **LightBlue** (iOS/macOS, Punch
Through) both work; neither is QZ1LE-specific.

1. Power on the QZ1LE and open the inspection app's device scanner.
2. Find the QZ1LE in the scan list. Note its advertised name -- this is what
   `deviceNamePrefix` in `config/qz1le-ble-profile.js` should match.
3. Connect to it and open the "Client" / GATT services view.
4. Walk the list of services; for each one, look at its characteristics.
5. Find the characteristic whose properties include **Notify** (sometimes
   also **Indicate**) -- subscribe to it (the down-arrow / "enable
   notifications" icon) and watch for changing byte values while the
   receiver has a fix.
6. Confirm the notified bytes decode as ASCII NMEA-0183 text (sentences
   starting with `$`, e.g. `$GNGGA,...`). Some bridge chips expose more than
   one Notify characteristic (e.g. a battery/status one) -- do not assume
   the first Notify characteristic found is the right one without checking
   the actual bytes.
7. Copy the exact **service** UUID (the one containing the Notify
   characteristic from step 5) into `serviceUuid` in
   `config/qz1le-ble-profile.js`.
8. Copy the exact **characteristic** UUID into `notifyCharacteristicUuid`.
9. Reload the app and try "QZ1LEに接続" again with `qz1-bluetooth` selected.
   It will now attempt a real connection -- but it is still *unverified*
   until it has actually been tested end-to-end against the physical
   receiver. See the checklist below.

### Configuring it

`config/qz1le-ble-profile.js` is committed, loaded before the app boots
(same pattern as `config/cloud-config.js`), and assigns
`window.SUISUI_QZ1LE_BLE_PROFILE`:

```js
window.SUISUI_QZ1LE_BLE_PROFILE ??= {
  serviceUuid: null,               // fill in from step 7 above
  notifyCharacteristicUuid: null,  // fill in from step 8 above
  deviceNamePrefix: "QZ1LE"
};
```

`js/recording/qz1le-ble-config.js` normalizes and validates this (pure,
unit-tested, mirrors `js/cloud/cloud-config.js`). Never commit values you
have not personally read off a real QZ1LE via steps 1–8; do not copy a UUID
from documentation for a *different* receiver or bridge chip.

## Architecture

| File | Role |
|---|---|
| `config/qz1le-ble-profile.js` | Committed, ships unset. The real GATT service/notify-characteristic UUIDs, once known. |
| `js/recording/qz1le-ble-config.js` | Pure: normalizes/validates the profile. Unit-tested. |
| `js/recording/qz1le-bluetooth.js` | `NmeaLineSplitter` (decode + line-split, byte-chunk-boundary safe) and `Qz1LeBluetoothTransport` (GATT connect/disconnect lifecycle, injectable `bluetooth` for tests). Never parses NMEA. Unit-tested with a fake GATT stack -- no physical hardware, no real browser. |
| `js/recording/qz1-acquisition-methods.js` | Pure: platform detection (`detectPlatformKind`) and the acquisition-method decision matrix (`decideQz1AcquisitionUx`). Unit-tested for every documented case (A/B/C/D below). |
| `index.html` | Wires the above into the QZ1測量 card's デバイス section: `initQz1leBluetooth()`, `syncQz1AcquisitionUi()`, `handleQz1leStateChange()`. Every complete line reaches the same `handleSerialLine()` the Web Serial transport already used. |
| `css/recording.css` | `.rec-compat-list` (端末別の接続方法) and reused `.rec-connection-note` / `.fallback-steps` (iOS fallback). |

## The acquisition-UX decision matrix

`decideQz1AcquisitionUx()` in `js/recording/qz1-acquisition-methods.js`
takes `{ isSecureContext, hasSerial, hasBluetooth, platformKind, bleProfile
}` and decides what to show. `platformKind` comes from `detectPlatformKind()`
(userAgent + platform + maxTouchPoints, so iPadOS 13+'s Mac-like user agent
is still correctly detected as iOS).

| Case | Platform | hasSerial | hasBluetooth | Result |
|---|---|---|---|---|
| A | Desktop Chromium | true | true | Both options shown |
| B | Android + Chrome | false | true | Bluetooth + file only, no Serial |
| C | iPhone / iPad | (irrelevant) | (irrelevant) | GNSS Analyzer fallback; no Bluetooth button at all, regardless of feature flags |
| D | Any other browser | false | false | Generic "no Web Bluetooth" notice, distinct from C's iOS-specific one |

Case C ignoring `hasBluetooth` is deliberate and tested
(`tests/unit/qz1-acquisition-methods.test.js`): iOS and "unsupported
browser" can report *identical* feature flags (`hasSerial: false,
hasBluetooth: false`) while needing completely different messages, so an
explicit platform signal -- not feature detection alone -- decides between
them.

Independently of A–D, the Bluetooth option (when shown) carries one of these
states:

| `bluetoothState` | Meaning | Connect enabled? |
|---|---|---|
| `insecure-context` | Not HTTPS/localhost | No |
| `not-configured` | `config/qz1le-ble-profile.js` still unset | No |
| `configured-unverified` | Real UUIDs configured, but never confirmed against hardware | Yes |

There is no `verified` state in this codebase. Reaching one requires the
manual hardware validation below and, at that point, updating this document
(and the in-app note) to say so explicitly -- never inferred from a
connection merely succeeding once.

## Security / HTTPS requirement

Both Web Bluetooth and Web Serial require a secure context (HTTPS, or
`http://localhost`/`http://127.0.0.1` for local development) -- this is a
browser platform requirement, not something this app can opt out of. Serving
this app over plain HTTP on a LAN address will show `window.isSecureContext
=== false`, and both the QZ1LE Bluetooth option and the QZ1 Serial option
report themselves unsupported, with a message naming the requirement.

## Browser support caveats

- **Safari (macOS or iOS/iPadOS):** no Web Bluetooth, no Web Serial, at all.
  NMEA file import is the only path.
- **Firefox:** no Web Bluetooth, no Web Serial, at all. Same as Safari.
- **Chrome on iOS:** WebKit underneath, same limitations as Safari on iOS.
  Not a workaround -- do not suggest it as one.
- **Android:** Web Bluetooth yes, Web Serial no (any browser). This is why
  case B above has no Serial option at all on Android, not just a
  disabled one.
- **Desktop Chrome / Edge:** both supported, subject to the secure-context
  requirement above.

## Manual hardware-validation procedure

Automated tests use a fake `navigator.bluetooth` (see
`tests/browser/qz1le-bluetooth.spec.js`,
`tests/unit/qz1le-bluetooth.test.js`) and cannot exercise a real QZ1LE, real
BLE radio behavior, or real Android/iOS power management. Before relying on
QZ1LE Bluetooth in the field:

- [ ] **Identify the profile**: complete "How to identify the real UUIDs"
      above and fill in `config/qz1le-ble-profile.js`.
- [ ] **Device/OS**: record the device model, OS version, and browser
      version (`chrome://version` on Chrome/Edge) used.
- [ ] **Pairing/discovery**: QZ1LE appears in the `navigator.bluetooth`
      device picker when pressing 接続 with `QZ1LE（Bluetooth LE）`
      selected (confirms the `namePrefix`/`services` filter actually
      matches the real advertisement).
- [ ] **Connect**: the picker's selection reaches `connected` state
      (`#serialStatus` shows 接続中（未検証）) without an error.
- [ ] **Data validity**: confirm decoded NMEA sentences are genuine (not
      truncated, not garbled) by comparing a few against the same
      receiver's known-good QZ1-style output, or against GNSS Analyzer's own
      log for the same session.
- [ ] **10-minute stability**: connect and receive continuously for at
      least 10 minutes; confirm no unexpected `gattserverdisconnected` and
      that `#recByteAge`/`#recLineAge` (診断, in the QZ1測量 card) stay low
      throughout.
- [ ] **Reconnect behavior**: physically disconnect QZ1LE (power off, walk
      out of BLE range); confirm the app surfaces the disconnect (not
      silence) and that a manual reconnect resumes reception.
- [ ] **Android backgrounding**: lock the screen or background Chrome while
      connected; note whether the BLE link survives (Web Bluetooth has no
      background guarantee on Android either).
- [ ] **Export validation**: after a real recording, export the raw `.nmea`
      log and confirm it is readable and matches what was actually
      received.

Once every item above is checked against a real QZ1LE, update this
document's decision-matrix table (remove the `configured-unverified` /
"never claims verified" caveat for that specific hardware revision) and the
in-app note in `js/recording/qz1-acquisition-methods.js`
(`QZ1LE_BLUETOOTH_STATE_MESSAGES["configured-unverified"]`) accordingly --
do not remove the caution language preemptively.
