/* スイスイナビ — QZ1LE (Bluetooth Low Energy) GATT プロファイル設定
 * SuisuiNavi QZ1LE (Bluetooth Low Energy) GATT profile configuration
 *
 * This file is loaded by index.html before the app boots, the same way
 * config/cloud-config.js is. A GitHub Pages / さくらインターネット static
 * site has no build step and no server, so there is nowhere else for a
 * frontend configuration value to live.
 *
 * WHY THIS IS EMPTY BY DEFAULT
 * -----------------------------
 * QZ1LE is a Bluetooth Low Energy 4.0 receiver that outputs NMEA-0183, but
 * its actual GATT service UUID and NMEA-notification characteristic UUID
 * have NOT been confirmed against real hardware. Earlier work in this repo
 * guessed the Nordic UART Service (NUS) UUIDs as a placeholder -- that was a
 * mistake: NUS is a common pattern for BLE-to-serial bridge modules, but it
 * is not a verified fact about QZ1LE, and shipping a guessed UUID risks the
 * app *looking* like it connects (requestDevice() may still return a device
 * if it happens to advertise a matching service) while silently reading
 * nothing, or misleading a future maintainer into thinking the profile is
 * known when it is not.
 *
 * So: while serviceUuid / notifyCharacteristicUuid are null, the app is
 * honest about it. The QZ1LE Bluetooth option stays visible in the UI (so
 * people know it exists and is planned), but selecting it explains that the
 * BLE profile still needs to be identified, and does not attempt a
 * connection with invented UUIDs pretending to be real ones.
 *
 * HOW TO FILL THIS IN (once you have a physical QZ1LE)
 * ------------------------------------------------------
 * Use a generic BLE inspection app -- nRF Connect (Android/iOS) or LightBlue
 * (iOS/macOS) both work -- to read the real profile off the device:
 *
 *   1. Power on the QZ1LE and open the inspection app's device scanner.
 *   2. Find the QZ1LE in the scan list (note its advertised name -- this is
 *      what deviceNamePrefix below should match).
 *   3. Connect to it and open "Client" / GATT services view.
 *   4. Walk the list of services; for each one, look at its characteristics.
 *   5. Find the characteristic whose properties include "Notify" (sometimes
 *      also "Indicate") -- this is very likely the one that streams NMEA
 *      text once you subscribe to it (tap "Enable notifications" / the
 *      down-arrow icon and watch for changing byte values while the
 *      receiver has a fix).
 *   6. Confirm the notified bytes decode as ASCII NMEA-0183 text (sentences
 *      starting with "$", e.g. "$GNGGA,...") -- some bridge chips expose
 *      more than one Notify characteristic (e.g. a status/battery one), so
 *      don't assume the first Notify characteristic you find is the right
 *      one without checking the actual bytes.
 *   7. Copy the exact service UUID (the one that *contains* the Notify
 *      characteristic from step 5) into serviceUuid below.
 *   8. Copy the exact characteristic UUID into notifyCharacteristicUuid.
 *   9. Reload the app and try "QZ1LE Bluetooth接続" again. It will now
 *      attempt a real connection -- but it is still unverified until it has
 *      actually been tested end-to-end against the physical receiver (see
 *      docs/QZ1LE_CONNECTIVITY.md's hardware-validation checklist).
 *
 * Full walkthrough: docs/QZ1LE_CONNECTIVITY.md
 *
 * WHILE THIS FILE IS LEFT UNSET (the shipped state) the QZ1 (USB / Bluetooth
 * Classic SPP) transport and NMEA file import are completely unaffected --
 * only the QZ1LE direct-Bluetooth-LE path is gated on this configuration.
 */

/* `??=` rather than `=` so anything that has already assigned this global
 * wins: the browser test suite injects a profile before the page loads (to
 * exercise the "configured" code paths without real hardware), and a
 * deployment that prefers to inject configuration another way (a wrapper
 * page, a desktop shell) can do the same without editing this file. In every
 * normal load nothing has assigned it, so the object below is what the app
 * reads. */
window.SUISUI_QZ1LE_BLE_PROFILE ??= {
  // The GATT primary service UUID that contains the NMEA notify
  // characteristic. Full 128-bit UUID string (e.g.
  // "0000180d-0000-1000-8000-00805f9b34fb") or a registered 16-bit alias.
  // NEVER guess this -- leave it null until read off real hardware.
  serviceUuid: null,

  // The GATT characteristic UUID (within serviceUuid above) that emits
  // NMEA-0183 text via Notify. NEVER guess this -- leave it null until read
  // off real hardware.
  notifyCharacteristicUuid: null,

  // Advertised BLE device name (or a distinctive prefix of it), used as a
  // `namePrefix` filter in navigator.bluetooth.requestDevice() so the OS
  // device picker highlights the right device. Informational only when
  // serviceUuid/notifyCharacteristicUuid are unset.
  deviceNamePrefix: "QZ1LE"
};
