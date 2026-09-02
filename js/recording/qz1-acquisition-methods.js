// Deciding which QZ1/QZ1LE acquisition method(s) to offer on this device:
// pure logic (no DOM, no navigator, no Bluetooth) so the decision matrix is
// unit-testable without a browser. index.html reads navigator/window itself
// and passes the plain signals in; this module never touches them directly.
//
// Why this exists as its own module (not just inline in index.html):
// Web Serial and Web Bluetooth support vary by platform in ways that are NOT
// simply "feature present / absent" -- iPhone/iPad and a random unsupported
// desktop browser can both report `hasBluetooth: false`, but they need
// completely different messages (a working alternative workflow for iOS vs.
// "use a different browser" for the other). Getting that distinction right
// needs an explicit platform signal, not feature detection alone.

/** Device compatibility panel content, item-for-item what the app promises -- never more. */
export const DEVICE_COMPATIBILITY_GUIDE = [
  { device: "Windows PC", route: "QZ1LE → Chrome / Edge → Bluetooth → SuiSuiNavi" },
  { device: "Android", route: "QZ1LE → Chrome → Bluetooth → SuiSuiNavi" },
  { device: "iPhone / iPad", route: "QZ1LE → GNSS Analyzer → NMEAログ → SuiSuiNavi" },
  { device: "USB対応PC", route: "QZ1 / QZ1LE → USB → Web Serial → SuiSuiNavi" }
];

export const IOS_FALLBACK_INTRO = "iPhone / iPadではSafariからQZ1LEへ直接Bluetooth接続できません。";

export const IOS_FALLBACK_STEPS = [
  "GNSS AnalyzerでQZ1LEへ接続",
  "NMEAログを記録",
  "ログを保存 / 共有",
  "SuiSuiNaviでNMEAファイルを読み込む"
];

export const UNSUPPORTED_BROWSER_MESSAGE =
  "このブラウザではWeb Bluetoothを利用できません。対応するChromiumブラウザ（デスクトップのChrome / Edge、AndroidのChrome）をお使いいただくか、NMEAファイルを読み込んでください。";

/** Keyed by decideQz1AcquisitionUx()'s `bluetoothState`. */
export const QZ1LE_BLUETOOTH_STATE_MESSAGES = {
  "not-applicable": "",
  "insecure-context": "Web Bluetooth はHTTPSまたはlocalhostでのみ利用できます。このページを https:// または http://localhost で開き直してください。",
  "not-configured": "QZ1LEのBluetooth LEプロファイル（GATTサービス/通知キャラクタリスティック）がまだ特定されていません。実機での調査が必要です。動作しない場合はQZ1（USB / Bluetooth SPP）またはNMEAファイルの読み込みをお使いください。",
  "configured-unverified": "QZ1LE（Bluetooth LE）接続は試験的な実装です。実機QZ1LEでの動作は確認されていません。動作しない場合はQZ1（USB / Bluetooth SPP）をお試しください。"
};

/**
 * Classifies the current device from the two signals that actually
 * distinguish "iPhone/iPad, no working Bluetooth path" from "some other
 * browser, no working Bluetooth path" -- feature detection alone cannot,
 * since both report `hasBluetooth: false` identically.
 *
 * @param userAgent navigator.userAgent
 * @param platform navigator.platform
 * @param maxTouchPoints navigator.maxTouchPoints -- iPadOS 13+ reports a
 *   desktop Mac's userAgent/platform, but a real Mac never has touch points,
 *   so `platform === "MacIntel" && maxTouchPoints > 1` is the standard
 *   feature-detection trick for "this is actually an iPad".
 * @returns {"ios"|"android"|"desktop"}
 */
export function detectPlatformKind({ userAgent = "", platform = "", maxTouchPoints = 0 } = {}) {
  const ua = String(userAgent || "");
  const plat = String(platform || "");
  const isClassicIOS = /iPhone|iPad|iPod/i.test(ua);
  const isDesktopClassIPad = plat === "MacIntel" && Number(maxTouchPoints) > 1;
  if (isClassicIOS || isDesktopClassIPad) {
    return "ios";
  }
  if (/Android/i.test(ua)) {
    return "android";
  }
  return "desktop";
}

/**
 * Decides which acquisition controls/messages to show. Every input is a
 * plain signal (never `navigator`/`window` themselves), so this has no
 * environment dependency and no side effects.
 *
 * @param isSecureContext window.isSecureContext
 * @param hasSerial "serial" in navigator
 * @param hasBluetooth "bluetooth" in navigator
 * @param platformKind detectPlatformKind()'s result
 * @param bleProfile readQz1LeBleProfile()'s result ({ configured, reason, ... })
 */
export function decideQz1AcquisitionUx({
  isSecureContext = true,
  hasSerial = false,
  hasBluetooth = false,
  platformKind = "desktop",
  bleProfile = { configured: false, reason: "missing" }
} = {}) {
  const isIOS = platformKind === "ios";
  const showSerialOption = Boolean(hasSerial) && !isIOS;
  const showBluetoothOption = Boolean(hasBluetooth) && !isIOS;
  const showIosFallback = isIOS;
  const showUnsupportedBrowserNotice = !isIOS && !showSerialOption && !showBluetoothOption;

  let bluetoothState = "not-applicable";
  if (showBluetoothOption) {
    if (isSecureContext === false) {
      bluetoothState = "insecure-context";
    } else if (!bleProfile?.configured) {
      bluetoothState = "not-configured";
    } else {
      bluetoothState = "configured-unverified";
    }
  }

  return {
    platformKind,
    showSerialOption,
    showBluetoothOption,
    showIosFallback,
    showUnsupportedBrowserNotice,
    // NMEA file import is the one path that always works (item 8): flagged
    // here so the UI can point to it whenever neither live transport does.
    showFileImportReminder: showIosFallback || showUnsupportedBrowserNotice,
    bluetoothState,
    bluetoothConnectEnabled: showBluetoothOption && bluetoothState === "configured-unverified",
    bluetoothMessage: QZ1LE_BLUETOOTH_STATE_MESSAGES[bluetoothState] || ""
  };
}
