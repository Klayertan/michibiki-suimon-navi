// Pure formatting helpers for the drone / MAVLink panel.
//
// No DOM access and no imports, so these run under `node --test` as well as in
// the browser. Every function accepts null/undefined and returns the same
// em-dash placeholder the rest of the app uses — the backend deliberately
// sends null for telemetry it has not received, and "—" must never be confused
// with a real zero.
//
// Anything that carries a warning meaning returns a `tone` alongside its text.
// The view turns a tone into both a CSS class and a written word, so state is
// never communicated by colour alone.

export const EMPTY = "—";

/** Battery thresholds mirroring the failsafe values configured on the aircraft. */
export const BATTERY_LOW_VOLTS = 14.0;
export const BATTERY_CRITICAL_VOLTS = 13.6;

const CONNECTION_LABELS = {
  disconnected: { label: "未接続", en: "Disconnected", tone: "idle" },
  connecting: { label: "接続中", en: "Connecting", tone: "pending" },
  connected: { label: "接続済み", en: "Connected", tone: "ok" },
  telemetry_stale: { label: "テレメトリ途絶", en: "Telemetry stale", tone: "warn" },
  link_lost: { label: "リンク喪失", en: "Link lost", tone: "danger" },
  reconnecting: { label: "再接続中", en: "Reconnecting", tone: "pending" },
  error: { label: "エラー", en: "Error", tone: "danger" }
};

const FIX_LABELS = {
  NO_GPS: "GPS未接続",
  NO_FIX: "測位なし",
  "2D_FIX": "2D測位",
  "3D_FIX": "3D測位",
  DGPS: "DGNSS",
  RTK_FLOAT: "RTK Float",
  RTK_FIXED: "RTK Fixed",
  STATIC: "静止",
  PPP: "PPP"
};

const SEVERITY_LABELS = {
  EMERGENCY: { label: "緊急", tone: "danger" },
  ALERT: { label: "警報", tone: "danger" },
  CRITICAL: { label: "重大", tone: "danger" },
  ERROR: { label: "エラー", tone: "danger" },
  WARNING: { label: "警告", tone: "warn" },
  NOTICE: { label: "通知", tone: "info" },
  INFO: { label: "情報", tone: "info" },
  DEBUG: { label: "デバッグ", tone: "muted" }
};

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Format a number with fixed decimals and an optional unit suffix. */
export function formatNumber(value, { digits = 1, unit = "" } = {}) {
  if (!isNumber(value)) return EMPTY;
  const text = value.toFixed(digits);
  return unit ? `${text} ${unit}` : text;
}

export function formatVoltage(volts) {
  return formatNumber(volts, { digits: 2, unit: "V" });
}

export function formatCurrent(amps) {
  return formatNumber(amps, { digits: 2, unit: "A" });
}

export function formatPercent(percent) {
  if (!isNumber(percent)) return EMPTY;
  return `${Math.round(percent)}%`;
}

export function formatDegrees(degrees) {
  return formatNumber(degrees, { digits: 1, unit: "°" });
}

export function formatHeading(degrees) {
  if (!isNumber(degrees)) return EMPTY;
  // Round before wrapping: rounding first would turn 359.6 into 360°, which is
  // not a heading anyone writes.
  return `${(Math.round(degrees) % 360 + 360) % 360}°`;
}

export function formatSpeed(metersPerSecond) {
  return formatNumber(metersPerSecond, { digits: 2, unit: "m/s" });
}

export function formatAltitude(meters) {
  return formatNumber(meters, { digits: 1, unit: "m" });
}

/** Coordinates get 7 decimals — roughly 1 cm, matching the GNSS work elsewhere. */
export function formatCoordinate(value) {
  return isNumber(value) ? value.toFixed(7) : EMPTY;
}

export function formatSatellites(count) {
  return isNumber(count) ? String(Math.round(count)) : EMPTY;
}

/** Seconds-since-event as a short relative string. */
export function formatAge(seconds) {
  if (!isNumber(seconds) || seconds < 0) return EMPTY;
  if (seconds < 1) return "1秒未満";
  if (seconds < 60) return `${seconds.toFixed(1)}秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  return `${Math.floor(seconds / 3600)}時間前`;
}

/** Epoch seconds (as sent by the backend) as a local wall-clock time. */
export function formatClockTime(epochSeconds) {
  if (!isNumber(epochSeconds)) return EMPTY;
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return EMPTY;
  return date.toLocaleTimeString("ja-JP", { hour12: false });
}

export function formatConnectionState(state) {
  return CONNECTION_LABELS[state] || { label: "不明", en: "Unknown", tone: "idle" };
}

export function formatFixType(fixTypeName) {
  if (!fixTypeName) return EMPTY;
  return FIX_LABELS[fixTypeName] || fixTypeName;
}

export function formatSeverity(severityName) {
  return SEVERITY_LABELS[severityName] || { label: severityName || "不明", tone: "muted" };
}

/**
 * Armed state as a display object.
 * Unknown is reported as unknown — never softened into "disarmed", because the
 * whole UI gates on this value.
 */
export function formatArmedState(armed) {
  if (armed === true) return { label: "ARMED（アーム中）", tone: "danger", armed: true };
  if (armed === false) return { label: "DISARMED（解除）", tone: "ok", armed: false };
  return { label: "不明", tone: "warn", armed: null };
}

/**
 * Battery warning tier from voltage and remaining percentage.
 * Voltage decides the tier because that is what the aircraft's own failsafes
 * use; the percentage is only a tie-breaker when no voltage is available.
 */
export function batteryWarning({ voltage, remaining } = {}) {
  if (isNumber(voltage)) {
    if (voltage <= BATTERY_CRITICAL_VOLTS) {
      return { tone: "danger", label: `重大（${BATTERY_CRITICAL_VOLTS}V以下）` };
    }
    if (voltage <= BATTERY_LOW_VOLTS) {
      return { tone: "warn", label: `低下（${BATTERY_LOW_VOLTS}V以下）` };
    }
    return { tone: "ok", label: "正常" };
  }
  if (isNumber(remaining)) {
    if (remaining <= 15) return { tone: "danger", label: "重大（残量15%以下）" };
    if (remaining <= 30) return { tone: "warn", label: "低下（残量30%以下）" };
    return { tone: "ok", label: "正常" };
  }
  return { tone: "unknown", label: EMPTY };
}

/** Link freshness as a display object, derived from the backend's own flag. */
export function formatFreshness({ stale, lastMessageAge } = {}) {
  if (stale === undefined || stale === null) return { label: EMPTY, tone: "unknown" };
  if (stale) return { label: `途絶（${formatAge(lastMessageAge)}）`, tone: "warn" };
  return { label: `正常（${formatAge(lastMessageAge)}）`, tone: "ok" };
}

/** Human explanation for a command rejection reason from the backend. */
const REASON_MESSAGES = {
  commands_disabled: "バックエンドが読み取り専用モードです（コマンド無効）。",
  not_connected: "MAVLinkリンクが接続されていません。",
  link_stale: "テレメトリが途絶しています。回復するまでコマンドは送信できません。",
  armed: "機体がARMED（アーム中）を報告しています。アーム中はすべてのコマンドを拒否します。",
  arm_state_unknown: "機体のアーム状態が未確認です。確認できるまでコマンドは送信できません。",
  mode_not_allowed: "許可されていないフライトモードです。",
  mode_forbidden: "この統合では禁止されているフライトモードです。",
  stream_not_allowed: "許可されていないテレメトリストリームです。",
  rejected_by_vehicle: "機体がコマンドを拒否しました。",
  ack_timeout: "COMMAND_ACKがタイムアウトしました。",
  verify_timeout: "モード変更が機体のハートビートで確認できませんでした。",
  transmit_failed: "コマンドを送信できませんでした。",
  not_implemented: "この操作は安全上の理由で実装されていません。",
  props_not_confirmed: "プロペラ取り外しの確認が必要です。",
  confirmation_required: "実機モードのモード変更には明示的な確認が必要です。",
  port_busy: "シリアルポートが他のプログラムに使用されています（QGroundControlを閉じてください）。",
  port_not_found: "シリアルポートが見つかりません。",
  already_connected: "すでに接続されています。",
  payload_too_large: "リクエストが大きすぎます。",
  backend_unreachable: "バックエンドに接続できません。起動しているか確認してください。"
};

export function describeReason(reason, fallback = "") {
  return REASON_MESSAGES[reason] || fallback || "不明なエラーです。";
}
