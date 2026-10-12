# QZ1 (Classic SPP) and QZ1LE (BLE) Connectivity

This document separates the blue QZ1 receiver from QZ1LE and records what
the software can do, what current browser documentation says, and what still
needs a real receiver. No BLE UUID or hardware result is inferred.

## The receivers are different

| | Blue QZ1 | QZ1LE |
|---|---|---|
| Hardware described in this repository | L1S / SLAS, Bluetooth Classic SPP; paired with Pixel 6a in the project brief | Separate BLE receiver |
| Browser transport | Web Serial when Chrome exposes a Bluetooth RFCOMM serial port; otherwise the Android RFCOMM bridge | Web Bluetooth GATT, only after a real profile is discovered |
| UUID profile | Not applicable to Classic SPP | Not known or committed |
| Hardware status for this implementation | Not tested by this change | Not tested |

Web Bluetooth is a BLE/GATT API; it cannot connect to the blue QZ1's Classic
SPP/RFCOMM link. Web Serial is the relevant web API for RFCOMM. Chrome's
documentation describes Bluetooth RFCOMM SPP on desktop beginning with Chrome
117. Current MDN compatibility data also lists Web Serial on Chrome for
Android, with Android's support initially limited to RFCOMM serial-port
emulation. This makes a direct connection a runtime possibility, not a
promise that a particular QZ1 will appear in the picker's list. The app tests
`navigator.serial` and `requestPort()` is the definitive device check.

Sources: [MDN Serial compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/Serial.json),
[Chrome RFCOMM/Web Serial notes](https://developer.chrome.com/blog/bluetooth-rfcomm-updates-web-serial),
[Chrome serial over Bluetooth guide](https://developer.chrome.com/blog/serial-over-bluetooth).

## Every live transport has one parser

Web Serial, BLE notifications, and the local bridge all send complete lines
to `handleSerialLine()` in `index.html`. That function feeds the existing
NMEA parser, map, field boundary and recording pipeline. The bridge and BLE
transports split lines only; they do not add another NMEA parser. Proprietary
lines such as `$L1BAT` and `$L1MAG` continue through the shared handler and are
ignored by the existing position parser without being treated as fixes.

```text
QZ1 Classic SPP -> Chrome Web Serial (if available) ------┐
               -> Android RFCOMM bridge -> localhost WS --+--> handleSerialLine()
QZ1LE BLE GATT -> BLE explorer/profile transport --------┘       -> parser/map/recording
NMEA file -------------------------------------------------------> existing file-import parser
```

## Android route selection

For the blue QZ1, Android uses this order:

1. **Web Serial** if `navigator.serial` is exposed. Choose the paired QZ1 in
   Chrome's serial picker. If it is not offered or no port is selected, the
   app then tries the local bridge.
2. **Android RFCOMM bridge** at `ws://127.0.0.1:8765` if Web Serial is absent
   or the picker yields no port. Install/run the bridge app, select the paired
   QZ1, and grant Chrome local-network access when prompted.
3. **BLE explorer** is a diagnostic option for devices that actually expose
   GATT. It does not make Classic SPP available. If the QZ1 is not visible in
   the BLE chooser, or has no accessible GATT service, BLE is not an option
   for that device on this path.

The first action remains **QZ1に接続**. The source selector's QZ1LE option
uses the BLE path separately. See [ANDROID_QZ1_CONNECTION.md](ANDROID_QZ1_CONNECTION.md)
for the Pixel 6a procedure and the bridge app.

## Chrome Android and the local WebSocket

The app uses a numeric loopback host, `127.0.0.1`, so the bridge listens only
inside the phone and is not exposed to Wi-Fi or the internet. Current Chrome
documentation says Local Network Access permission prompts apply to
WebSockets from Chrome 147. Chrome 154 documents the WebSocket
`targetAddressSpace` option; this transport requests `loopback`. Chrome's
Local Network Access documentation says permission-gated local requests can
be exempt from mixed-content blocking when their local destination is known
up front. This is the documented HTTPS-to-plain-WebSocket route used here.

On first connection, allow the prompt to let SuiSuiNavi look for/connect to
devices on the local network. If permission was denied, open the deployed
site's Chrome site settings, set **Local network** to **Allow**, then reload
the page. The prompt and setting labels can differ by Chrome build. The
diagnostics panel records browser version, secure-context status, and API
availability; the real Pixel prompt and connection still require manual
validation.

Sources: [Chrome 147 release notes: WebSocket LNA](https://developer.chrome.com/release-notes/147),
[Chrome 154 release notes: WebSocket `targetAddressSpace`](https://developer.chrome.com/release-notes/154),
[Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access).

## BLE discovery and profile honesty

`config/qz1le-ble-profile.js` remains unset. Its optional-service UUID list
in the explorer exists only to request permission to enumerate well-known
UART-like services; those UUIDs are not attributed to QZ1 or QZ1LE. The user
can inspect accessible services, characteristics and properties, subscribe
to Notify/Indicate, and inspect ASCII/hex notification data.

A characteristic is a **NMEA候補** only after at least two complete
sentences on that characteristic have valid NMEA checksums. “この端末でNMEA
受信を確認” is stored only in that browser's local storage, tied to that
BLE device. A saved runtime profile is also local to that browser; a complete
committed configuration takes precedence. Committed UUIDs must only be added
after reading them from the relevant physical receiver. If the explorer finds
no matching NMEA characteristic on the blue QZ1, use Classic SPP instead.

BLE notifications can split a sentence across 20-byte chunks; the shared
line splitter buffers partial lines. An unsolicited `gattserverdisconnected`
is handled. When the browser provides `getDevices()`, reconnect uses the
remembered device without opening a new chooser. The app still requires a
user gesture for initial discovery/connection.

## iPhone / iPad and desktop

- Desktop Chrome/Edge continues to use Web Serial for QZ1 USB/SPP, and the
  optional Web Bluetooth GATT route for QZ1LE after profile setup.
- iPhone/iPad keeps the existing GNSS Analyzer → NMEA file-import path. This
  change does not add a direct Web Bluetooth or Web Serial route on iOS.
- NMEA file import remains available on every platform.

No connection in this document asserts centimeter accuracy. This code change
has not been tested with a physical QZ1, QZ1LE, Pixel 6a, Android bridge app,
or receiver RF signal.
