// How a measurement reaches the application, described so the sensor domain
// never has to know.
//
// THE POINT OF THIS LAYER
// -----------------------
// A QZ1 reading is the same reading whether it arrived over a USB cable in an
// office, was imported from a log a farmer recorded on a phone in a paddy, or
// was pushed in by a future gateway through Cloudflare. Everything downstream
// — field detection, assignment, calibration, the water-management decision —
// consumes the SAME normalized measurement and is deliberately incapable of
// telling the difference.
//
//     serial ─┐
//  bluetooth ─┤
//       file ─┼──▶ normalized measurement ──▶ registry ──▶ detection ──▶ 水管理
//      cloud ─┘
//
// That is what makes "universal" true without pretending Web Serial exists on
// an iPhone. One sensor model, one field model, one measurement format, one
// analysis; the acquisition route is the only thing that varies by platform.
//
// WHAT THIS MODULE IS NOT
// -----------------------
// It does not open ports. index.html already owns the one Web Serial pipeline
// on the page and there must not be a second one. This module describes the
// routes, says which are usable here and why, and normalizes a measurement
// once it arrives. Connecting stays with whoever owns the connection.

import {
  TRANSPORT_KINDS,
  UNAVAILABLE_REASONS,
  capabilityFor
} from "./platform-capabilities.js";

export { TRANSPORT_KINDS };

/**
 * "auto" means "use the best route this platform offers", which is what a
 * farmer wants and what keeps one sensor record portable between a laptop and
 * a phone. A specific kind pins the choice.
 */
export const TRANSPORT_PREFERENCE_AUTO = "auto";

/**
 * Routes that this build can ACTUALLY carry a measurement over today.
 *
 * Separate from browser capability on purpose. A Chromium desktop reports
 * `navigator.bluetooth` as present, but SuisuiNavi has no GATT client and no
 * cloud ingestion endpoint — so offering either would be exactly the dead
 * button this whole capability layer exists to prevent. They stay in the
 * model (the sensor domain is transport-independent, and a gateway can be
 * added without touching field logic) but they are reported as 未実装 until
 * the code behind them exists.
 *
 * Serial: the existing Web Serial pipeline in index.html.
 * File import: the existing NMEA uploader.
 */
export const IMPLEMENTED_TRANSPORTS = new Set([
  TRANSPORT_KINDS.SERIAL,
  TRANSPORT_KINDS.FILE_IMPORT
]);

/** Presentation for each route. Japanese first, matching the rest of the app. */
export const TRANSPORT_DESCRIPTORS = {
  [TRANSPORT_KINDS.SERIAL]: {
    kind: TRANSPORT_KINDS.SERIAL,
    labelJa: "USB / シリアル接続",
    labelEn: "USB / Serial",
    // Bluetooth SPP surfaces as a virtual COM port, so it arrives here rather
    // than through the Web Bluetooth entry below. Saying so prevents "my QZ1
    // is Bluetooth, why is this called USB".
    descriptionJa: "QZ1をUSBケーブル、またはBluetooth SPPの仮想シリアルポートで直接つなぎます。",
    requiresSecureContext: true
  },
  [TRANSPORT_KINDS.BLUETOOTH]: {
    kind: TRANSPORT_KINDS.BLUETOOTH,
    labelJa: "Bluetooth (GATT)",
    labelEn: "Bluetooth (GATT)",
    descriptionJa: "Web Bluetooth に対応したブラウザでQZ1LEに直接つなぎます。",
    requiresSecureContext: true
  },
  [TRANSPORT_KINDS.FILE_IMPORT]: {
    kind: TRANSPORT_KINDS.FILE_IMPORT,
    labelJa: "NMEAファイル読込",
    labelEn: "NMEA file import",
    descriptionJa: "スマホ等で記録したNMEAログを読み込みます。どの端末・どのブラウザでも使えます。",
    requiresSecureContext: false
  },
  [TRANSPORT_KINDS.CLOUD]: {
    kind: TRANSPORT_KINDS.CLOUD,
    labelJa: "クラウド / ゲートウェイ",
    labelEn: "Cloud / gateway",
    descriptionJa: "ゲートウェイが送信した測定値を受け取ります。",
    requiresSecureContext: false
  }
};

/** Reason text. Explains what to do, not merely that something failed. */
const REASON_TEXT = {
  [UNAVAILABLE_REASONS.API_MISSING]: {
    ja: "このブラウザは対応していません",
    en: "not supported by this browser"
  },
  [UNAVAILABLE_REASONS.INSECURE_CONTEXT]: {
    ja: "HTTPS接続が必要です",
    en: "requires HTTPS"
  },
  [UNAVAILABLE_REASONS.HARDWARE_UNAVAILABLE]: {
    ja: "本体の機能が無効です",
    en: "hardware unavailable"
  },
  [UNAVAILABLE_REASONS.NOT_CONFIGURED]: {
    ja: "未設定です",
    en: "not configured"
  },
  [UNAVAILABLE_REASONS.NOT_IMPLEMENTED]: {
    ja: "このアプリで未実装です",
    en: "not implemented in this build"
  }
};

/**
 * Every route with its availability here — including the unavailable ones.
 *
 * Unavailable routes are RETURNED, not filtered out, so the UI can show them
 * greyed with a reason instead of silently omitting them. A farmer whose
 * iPhone shows no Bluetooth option at all is left wondering whether the app is
 * broken; one who sees "Bluetooth — このブラウザは対応していません" knows
 * where they stand and what the alternatives are.
 */
export function describeTransports(capabilities) {
  return Object.values(TRANSPORT_KINDS).map((kind) => {
    const descriptor = TRANSPORT_DESCRIPTORS[kind];
    const capability = capabilityFor(capabilities, kind);
    const implemented = IMPLEMENTED_TRANSPORTS.has(kind);
    // Both gates. A route the browser supports but this build cannot drive is
    // unavailable, and says so for that reason rather than pretending the
    // browser is at fault.
    const available = implemented && capability?.available === true;
    const reason = implemented
      ? (capability?.reason ?? UNAVAILABLE_REASONS.API_MISSING)
      : UNAVAILABLE_REASONS.NOT_IMPLEMENTED;
    return {
      ...descriptor,
      implemented,
      browserSupported: capability?.available === true,
      available,
      reason: available ? null : reason,
      reasonTextJa: available ? null : reasonTextFor(reason, "ja"),
      reasonTextEn: available ? null : reasonTextFor(reason, "en")
    };
  });
}

function reasonTextFor(reason, language) {
  return REASON_TEXT[reason]?.[language] ?? REASON_TEXT[UNAVAILABLE_REASONS.API_MISSING][language];
}

/**
 * Which route a sensor should actually use here.
 *
 * A stored preference that this platform cannot honour does NOT fail: the
 * same sensor record has to work on the laptop it was configured on and on
 * the phone carried to the paddy. `resolved` is what will be used, and
 * `fellBack` records that it is not what was asked for, so the UI can say so
 * rather than pretending the preference was honoured.
 */
export function resolveTransport(preference, capabilities) {
  const usable = Object.values(TRANSPORT_KINDS)
    .filter((kind) => IMPLEMENTED_TRANSPORTS.has(kind) && capabilityFor(capabilities, kind)?.available === true);

  if (usable.length === 0) {
    return { resolved: null, fellBack: false, requested: preference ?? TRANSPORT_PREFERENCE_AUTO, usable };
  }
  const requested = preference ?? TRANSPORT_PREFERENCE_AUTO;
  if (requested !== TRANSPORT_PREFERENCE_AUTO && usable.includes(requested)) {
    return { resolved: requested, fellBack: false, requested, usable };
  }
  // Preference order for "auto": a live link beats a file, and a direct link
  // beats a gateway that may be minutes stale.
  const preferenceOrder = [
    TRANSPORT_KINDS.SERIAL,
    TRANSPORT_KINDS.BLUETOOTH,
    TRANSPORT_KINDS.CLOUD,
    TRANSPORT_KINDS.FILE_IMPORT
  ];
  const resolved = preferenceOrder.find((kind) => usable.includes(kind)) ?? usable[0];
  return { resolved, fellBack: requested !== TRANSPORT_PREFERENCE_AUTO, requested, usable };
}

/** A stored preference value this module understands, or "auto". */
export function normalizeTransportPreference(value) {
  if (value === TRANSPORT_PREFERENCE_AUTO) {
    return TRANSPORT_PREFERENCE_AUTO;
  }
  return Object.values(TRANSPORT_KINDS).includes(value) ? value : TRANSPORT_PREFERENCE_AUTO;
}

/**
 * One measurement, in the shape the whole downstream pipeline consumes.
 *
 * MISSING STAYS MISSING. `Number(null)` and `Number("")` are both 0, and 0 is
 * a valid latitude, a valid longitude, a valid altitude and a valid satellite
 * count. Coercing here would manufacture a confident fix at 0°N 0°E with the
 * receiver at sea level — a bug this project has already had twice, in the
 * live-fix adapter and again in the sensor controller. Every numeric field
 * goes through `finiteOrNull`, which rejects null/undefined/"" BEFORE
 * `Number()` ever sees them.
 *
 * @param source which transport this arrived on, recorded so a reading can
 *        later be traced to how it got here (a file import replayed at 100x
 *        is not a live link, and the record should say so).
 */
export function normalizeMeasurement({
  sensorId = null,
  latitude, longitude, altitudeM,
  fixQuality, satellites, hdop, vdop, pdop,
  receivedAtMs = null,
  gnssTimeOfDay = null,
  source = null,
  raw = null
} = {}) {
  return {
    sensorId: sensorId === null || sensorId === undefined ? null : String(sensorId),
    latitude: finiteOrNull(latitude),
    longitude: finiteOrNull(longitude),
    altitudeM: finiteOrNull(altitudeM),
    fixQuality: finiteOrNull(fixQuality),
    satellites: finiteOrNull(satellites),
    hdop: finiteOrNull(hdop),
    vdop: finiteOrNull(vdop),
    pdop: finiteOrNull(pdop),
    receivedAtMs: finiteOrNull(receivedAtMs),
    gnssTimeOfDay: gnssTimeOfDay === null || gnssTimeOfDay === undefined ? null : String(gnssTimeOfDay),
    source: source === null || source === undefined ? null : String(source),
    raw: typeof raw === "string" ? raw : null
  };
}

/**
 * Adapts the live pipeline's point (index.html `parseNmea`) to a normalized
 * measurement. One parse, many consumers — there is no second NMEA reader.
 */
export function measurementFromLivePoint(point, {
  sensorId = null, receivedAtMs = Date.now(), source = TRANSPORT_KINDS.SERIAL, raw = null
} = {}) {
  if (!point) {
    return null;
  }
  return normalizeMeasurement({
    sensorId,
    latitude: point.lat,
    longitude: point.lon,
    altitudeM: point.altitude,
    fixQuality: point.fixQuality,
    satellites: point.satellites,
    hdop: point.hdop,
    // The live GGA-only path genuinely has no VDOP/PDOP. Absent, not zero.
    vdop: null,
    pdop: null,
    receivedAtMs,
    gnssTimeOfDay: point.timestamp ?? null,
    source,
    raw
  });
}

/**
 * Adapts one observation from the shared parser (`parseNmeaSession`) — the
 * file-import and offline route.
 */
export function measurementFromObservation(observation, {
  sensorId = null, source = TRANSPORT_KINDS.FILE_IMPORT
} = {}) {
  if (!observation) {
    return null;
  }
  return normalizeMeasurement({
    sensorId,
    latitude: observation.lat,
    longitude: observation.lon,
    altitudeM: observation.altitudeMsl,
    fixQuality: observation.fixQuality,
    satellites: observation.satellites,
    hdop: observation.hdop,
    vdop: observation.vdop,
    pdop: observation.pdop,
    receivedAtMs: observation.timestampUtcMs,
    gnssTimeOfDay: observation.timeOfDay ?? null,
    source
  });
}

/**
 * True when a measurement carries a position worth acting on.
 *
 * Deliberately separate from "has a fix": a measurement with a fix but no
 * coordinates is still unusable for field detection, and one with coordinates
 * but no altitude is still perfectly usable for it.
 */
export function hasUsablePosition(measurement) {
  return Number.isFinite(measurement?.latitude) && Number.isFinite(measurement?.longitude);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
