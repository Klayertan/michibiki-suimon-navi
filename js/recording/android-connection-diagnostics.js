// Pure formatting and injected browser probes for Android connection diagnostics.

export function parseChromeVersion(userAgent = "") {
  return String(userAgent).match(/(?:Chrome|CriOS)\/(\d+(?:\.\d+){0,3})/i)?.[1] || "不明";
}

export async function collectAndroidConnectionDiagnostics({
  navigatorLike = typeof navigator === "undefined" ? {} : navigator,
  isSecureContext = typeof window === "undefined" ? false : window.isSecureContext,
  decision = null
} = {}) {
  let bluetoothAvailability = "利用不可";
  try {
    if (navigatorLike.bluetooth?.getAvailability) {
      bluetoothAvailability = String(await navigatorLike.bluetooth.getAvailability());
    }
  } catch (error) {
    bluetoothAvailability = `取得エラー: ${error?.name || error?.message || "不明"}`;
  }
  let serialPortCount = "取得不可";
  try {
    if (navigatorLike.serial?.getPorts) serialPortCount = (await navigatorLike.serial.getPorts()).length;
  } catch (error) {
    serialPortCount = `取得エラー: ${error?.name || error?.message || "不明"}`;
  }
  return {
    userAgent: String(navigatorLike.userAgent || "不明"),
    chromeVersion: parseChromeVersion(navigatorLike.userAgent),
    isSecureContext: Boolean(isSecureContext),
    hasSerial: "serial" in navigatorLike,
    hasBluetooth: "bluetooth" in navigatorLike,
    bluetoothAvailability,
    serialPortCount,
    acquisitionDecision: decision?.case || "未判定",
    acquisitionState: decision?.androidSerialAvailable ? "Web Serial利用可能（選択画面でQZ1の表示を確認）" : (decision?.androidSerialUnavailableReason || "未判定")
  };
}

export function formatAndroidConnectionDiagnostics(data = {}) {
  return [
    "SuiSuiNavi Android接続診断",
    `userAgent: ${data.userAgent || "不明"}`,
    `Chrome version: ${data.chromeVersion || "不明"}`,
    `isSecureContext: ${Boolean(data.isSecureContext)}`,
    `'serial' in navigator: ${Boolean(data.hasSerial)}`,
    `'bluetooth' in navigator: ${Boolean(data.hasBluetooth)}`,
    `navigator.bluetooth.getAvailability(): ${data.bluetoothAvailability || "不明"}`,
    `navigator.serial.getPorts() count: ${data.serialPortCount ?? "取得不可"}`,
    `acquisition decision: ${data.acquisitionDecision || "未判定"}`,
    `state: ${data.acquisitionState || "未判定"}`
  ].join("\n");
}
