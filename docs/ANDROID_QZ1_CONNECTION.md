# Android Chrome: blue QZ1 connection

This guide is for the blue QZ1 (L1S/SLAS) paired to an Android phone over
Bluetooth Classic SPP/RFCOMM. It is not the QZ1LE BLE procedure. The bridge,
browser routing, and Pixel 6a hardware have not been validated together on a
physical phone in this change.

## Decision tree

1. Open the deployed HTTPS app and expand **Android接続診断 / Connection
   diagnostics** in the QZ1測量 card. Copy the output and send it back when
   asking for help.
2. Press **QZ1に接続**. If `navigator.serial` exists, Chrome's Web Serial
   picker is tried first. Pick the paired QZ1 if it appears.
3. If Web Serial is absent, or the picker returns without a selected port,
   the app tries the local bridge at `ws://127.0.0.1:8765`.
4. If Chrome cannot connect to the bridge, start **SuiSui QZ1 Bridge**, select
   the paired QZ1, then retry. Chrome reconnects to the bridge with backoff.
   If the bridge is connected but the QZ1 is not, the screen says that the
   QZ1 is disconnected and the Android app retries RFCOMM automatically.
5. The **BLE探索** panel is for a device that exposes BLE GATT. Classic SPP
   and BLE are different radios/protocols at the browser API level. If the
   blue QZ1 is not available in the BLE picker or no accessible services are
   shown, BLE is not a path for that receiver; use Web Serial or the bridge.

The file upload workaround remains available throughout. See
[QZ1/QZ1LE connectivity](QZ1LE_CONNECTIVITY.md) for browser and profile
details.

## What current browser sources say

- The current [MDN compatibility data for `Serial`](https://github.com/mdn/browser-compat-data/blob/main/api/Serial.json)
  lists Chrome for Android support. Its implementation notes say the initial
  Android implementation was limited to ports exposed through Bluetooth
  RFCOMM serial-port emulation. Chrome's [RFCOMM Web Serial article](https://developer.chrome.com/blog/bluetooth-rfcomm-updates-web-serial)
  describes the shipped RFCOMM feature as desktop Chrome support. Therefore
  the app checks the API at runtime and the phone's own picker must confirm
  that the QZ1 is actually available.
- Chrome's [147 release notes](https://developer.chrome.com/release-notes/147)
  say WebSocket connections to local addresses trigger Local Network Access
  permission prompts. Chrome's [154 release notes](https://developer.chrome.com/release-notes/154)
  document the WebSocket `targetAddressSpace` option, including loopback
  routing from a secure site to a local server.
- This app uses that loopback hint and the numeric host `127.0.0.1`. The
  bridge binds only to that address. On the first connection, allow Chrome's
  local-network prompt. If it was denied, open the deployed site's Chrome
  site settings, change **Local network** to **Allow**, and reload. No token
  is placed in the WebSocket URL.

Chrome feature availability changes over time. The diagnostic output records
the exact user agent and `navigator.serial`/`navigator.bluetooth` availability
from your own phone.

## Bridge app

The minimal Android project is in `android-bridge/`. It lists devices already
paired in Android settings, requests `BLUETOOTH_CONNECT` on Android 12+, and
starts a foreground service using the Android `connectedDevice` service type.
It connects with the standard SPP UUID
`00001101-0000-1000-8000-00805F9B34FB`, retries after disconnects, and serves
raw complete lines plus a small JSON connection-status frame on port 8765.
The listener binds to IPv4 loopback only; it does not accept LAN connections.

Build a debug APK on a computer with Android Studio/SDK installed:

```sh
cd android-bridge
./gradlew assembleDebug
```

The APK output is `android-bridge/app/build/outputs/apk/debug/app-debug.apk`.
Install it on the Pixel, open it, allow **Nearby devices / Bluetooth connect**
permission, and select the already-paired QZ1. Keep its foreground-service
notification visible during the survey. This source is a minimal prototype;
the debug APK has not been built or installed in this environment.

## What is and is not confirmed

| Item | Status |
|---|---|
| Blue QZ1 is Classic SPP/RFCOMM, not QZ1LE BLE | Stated in the repository's hardware brief and README |
| Existing Web Serial, BLE, and bridge lines use `handleSerialLine()` | Implemented; browser/unit tested with fakes and a local WebSocket test server |
| Android Web Serial may be exposed by current Chrome | Supported by current compatibility data; QZ1 picker availability is not known until tried on the phone |
| `ws://127.0.0.1` from the deployed HTTPS origin | Based on Chrome's current mixed-content/LNA documentation; not tested on the Pixel |
| RFCOMM SPP, Android permissions, foreground service, lock-screen behavior | Not tested on hardware |
| Receiver accuracy | No accuracy claim is made by this implementation |

## Pixel 6a manual validation checklist

1. Pair and power on the blue QZ1 in Android **Settings → Connected devices →
   Pair new device**. Confirm the QZ1 appears as paired.
2. Open the deployed HTTPS app in current Chrome, open the QZ1測量 card, and
   expand **Android接続診断 / Connection diagnostics**. Tap **診断結果を
   コピー** and send that text back before troubleshooting other paths.
3. Press **QZ1に接続**. If Chrome offers the QZ1 in its serial chooser, select
   it and confirm live NMEA and map updates. Record whether `navigator.serial`
   was available and whether the picker listed the QZ1.
4. If that picker path is absent or does not list the QZ1, build/install
   `app-debug.apk` from `android-bridge/` (or install the APK built by your
   developer machine). Grant **Nearby devices** / Bluetooth-connect access.
5. In SuiSui QZ1 Bridge, choose the paired QZ1 and confirm the persistent
   foreground-service notification. Return to Chrome and press
   **QZ1に接続**. Allow the site's **Local network** permission prompt. Check
   for the QZ1 connected/receiving status and GGA fix data.
6. Confirm RMC sentences arrive. Confirm `$L1BAT` and `$L1MAG` lines do not
   create parser errors or false positions. Do not infer a precision result
   from this connection check.
7. Leave the survey receiving for **10 minutes**. Note any gaps, status
   changes, battery impact, and whether map/recording continues.
8. Lock the screen and leave Chrome and the bridge running for several
   minutes. Record whether Android pauses either app or drops RFCOMM; repeat
   with Chrome backgrounded if practical. Screen-lock/background behavior is
   device- and battery-policy-dependent and is not guaranteed here.
9. Power the QZ1 off/on or move out of range briefly. Confirm the bridge
   reports disconnected, retries, then resumes data without restarting the
   browser page. Also test recovery after closing/reopening Chrome.
10. Press **切断**, stop the bridge service from its app, and confirm the UI
    reports that the bridge is unavailable. Confirm NMEA file import still
    works independently.

Report the Chrome version, copied diagnostics, which route succeeded, time
to first data, any permission wording, and results of steps 7–9. Only then can
the connection be marked as confirmed on that physical device; passing the
automated tests does not verify hardware behavior.
