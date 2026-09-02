// QZ1LE Bluetooth LE GATT profile resolution.
//
// Mirrors js/cloud/cloud-config.js: configuration arrives as a plain
// committed file (config/qz1le-ble-profile.js) that assigns
// window.SUISUI_QZ1LE_BLE_PROFILE, because this is a static site with no
// build step and no server to inject environment variables.
//
// Pure module: no DOM, no Bluetooth, no side effects. Everything here is a
// function of the object it is handed, so it is unit-testable and cannot
// depend on load order.
//
// See config/qz1le-ble-profile.js and docs/QZ1LE_CONNECTIVITY.md for why the
// shipped profile is unset and how to fill it in from real hardware.

const EMPTY_PROFILE = Object.freeze({
  serviceUuid: null,
  notifyCharacteristicUuid: null,
  deviceNamePrefix: "QZ1LE",
  configured: false,
  reason: "missing"
});

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalizes whatever `window.SUISUI_QZ1LE_BLE_PROFILE` happens to contain
 * into a predictable shape. Never throws: a malformed or half-filled profile
 * degrades to `configured: false`, which the app treats as "the QZ1LE BLE
 * profile has not been identified yet" -- the option stays visible but a
 * connection attempt is refused instead of guessing UUIDs.
 *
 * `reason` explains an unconfigured result so the UI can say something more
 * useful than "off":
 *   - "missing"       no profile object at all
 *   - "service"       serviceUuid unset
 *   - "characteristic" notifyCharacteristicUuid unset (serviceUuid is set)
 */
export function normalizeQz1LeBleProfile(raw) {
  if (!raw || typeof raw !== "object") {
    return EMPTY_PROFILE;
  }
  const serviceUuid = text(raw.serviceUuid) || null;
  const notifyCharacteristicUuid = text(raw.notifyCharacteristicUuid) || null;
  const deviceNamePrefix = text(raw.deviceNamePrefix) || "QZ1LE";

  if (!serviceUuid) {
    return { serviceUuid: null, notifyCharacteristicUuid, deviceNamePrefix, configured: false, reason: "service" };
  }
  if (!notifyCharacteristicUuid) {
    return { serviceUuid, notifyCharacteristicUuid: null, deviceNamePrefix, configured: false, reason: "characteristic" };
  }
  return { serviceUuid, notifyCharacteristicUuid, deviceNamePrefix, configured: true, reason: null };
}

/** Reads and normalizes the profile off a global scope (defaults to `window`). */
export function readQz1LeBleProfile(globalScope = typeof window !== "undefined" ? window : {}) {
  return normalizeQz1LeBleProfile(globalScope?.SUISUI_QZ1LE_BLE_PROFILE);
}

/** Japanese one-liner for why direct QZ1LE Bluetooth connection is unavailable. */
export function unconfiguredQz1LeReasonText(reason) {
  switch (reason) {
    case "service":
    case "characteristic":
      return "QZ1LEのBluetooth LEプロファイル（GATTサービス/通知キャラクタリスティック）がまだ特定されていません。実機での調査が必要です。";
    default:
      return "QZ1LEのBluetooth LE設定が見つかりません。";
  }
}
