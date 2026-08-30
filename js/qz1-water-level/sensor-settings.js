// A water-level sensor's configuration: what it is, how it gets its data, how
// it is calibrated, and what quality it demands.
//
// SEPARATE FROM MEASUREMENT, ON PURPOSE
// -------------------------------------
// Settings are what a person decided. Measurements are what the hardware
// reported. Keeping them in different modules — and, in the UI, on different
// screens — is what stops the sensor card from becoming a wall of numbers in
// which a configured threshold and an observed value look identical.
//
// DEVICE MODEL IS DATA, NOT A BRANCH
// ----------------------------------
// `deviceModel` is a string on the record and a lookup in DEVICE_MODELS. It
// is deliberately NOT `if (isQz1le)` scattered through the UI: this milestone
// supports QZ1 and QZ1LE, and the next water sensor to arrive should need a
// table entry rather than an audit of every render function.
//
// EVERY DEFAULT IS STATED, NONE IS SILENT
// ---------------------------------------
// A quality gate that rejects half the fixes without saying so is the same
// class of problem as a filter chain that is applied invisibly — see
// altitude-filters.js, which this module reuses rather than reinvents.
// `describeSettings()` exists so the UI can always show what is actually in
// force.

import { PRESET_FILTER_CHAINS } from "./altitude-filters.js";
import {
  TRANSPORT_PREFERENCE_AUTO,
  normalizeTransportPreference
} from "./sensor-transport.js";

/**
 * Device models this build knows about.
 *
 * `transports` lists what the hardware can physically do — not what the
 * current browser can do. The intersection of the two is what the UI offers.
 */
export const DEVICE_MODELS = {
  QZ1: {
    id: "QZ1",
    labelJa: "QZ1",
    labelEn: "QZ1",
    // The repository's own recorded log (data/samples/qz1-dorm-walk-20260706.txt)
    // is a QZ1 streaming NMEA over a Bluetooth SPP virtual serial port.
    transports: ["serial", "file-import", "cloud"],
    notesJa: "NMEA出力。USB／Bluetooth SPP（仮想シリアルポート）で接続します。"
  },
  QZ1LE: {
    id: "QZ1LE",
    labelJa: "QZ1LE",
    labelEn: "QZ1LE",
    // Bluetooth is listed as a hardware capability. Whether the BROWSER can
    // reach it is a separate question answered by platform-capabilities.js,
    // and on iOS the answer is no. Listing it here is not a promise that it
    // works everywhere.
    transports: ["serial", "bluetooth", "file-import", "cloud"],
    notesJa: "NMEA出力。接続方式は端末・ブラウザの対応状況によります。"
  }
};

export const DEFAULT_DEVICE_MODEL = "QZ1";

/** Calibration lifecycle. Distinct from assignment and from connection. */
export const CALIBRATION_STATES = {
  /** No calibration has ever been taken. Absolute depth is not derivable. */
  UNCALIBRATED: "uncalibrated",
  /** A calibration exists and is within its age limit. */
  CALIBRATED: "calibrated",
  /** A calibration exists but is older than the configured limit. */
  EXPIRED: "expired",
  /** A calibration exists but cannot be used (no validating experiment). */
  INVALID: "invalid"
};

/** Whether one arriving measurement may be used. Not a connection state. */
export const MEASUREMENT_QUALITY = {
  VALID: "valid",
  /** Usable data, but not enough of it to conclude anything yet. */
  INSUFFICIENT: "insufficient",
  /** Failed the configured quality gate. */
  REJECTED: "rejected"
};

/**
 * Quality a fix must clear before it feeds the water-level reading.
 *
 * The defaults are permissive on purpose. This project has NOT established
 * what quality GNSS water-level sensing needs — that is the open experiment —
 * so shipping a strict gate would silently discard data the experiment is
 * supposed to examine. `minSatellites: 4` and `maxHdop: 5` reject fixes that
 * are unusable by definition rather than fixes someone might disagree about.
 *
 * `requireFix: [1, 2, 4, 5]` mirrors the fix qualities the existing parser
 * already treats as valid (js/gnss/nmea-parser.js VALID_FIX_QUALITIES).
 */
export const DEFAULT_QUALITY_SETTINGS = {
  requireFix: [1, 2, 4, 5],
  minSatellites: 4,
  maxHdop: 5,
  /** Named chain from altitude-filters.js. "none" is the honest default. */
  filterProfile: "none"
};

export const DEFAULT_ACQUISITION_SETTINGS = {
  transportPreference: TRANSPORT_PREFERENCE_AUTO,
  /**
   * A fix older than this stops the sensor counting as online.
   *
   * 15 s at a nominal 1 Hz: long enough to survive a few dropped sentences on
   * a Bluetooth link, short enough that a farmer is not shown a stale reading
   * as if it were live.
   */
  onlineTimeoutMs: 15000
};

export const DEFAULT_DISPLAY_SETTINGS = {
  /**
   * Whether the card may show an absolute depth at all.
   *
   * Even `true` does not produce one without a valid calibration —
   * calibration.js refuses independently. This is a second, human-controlled
   * gate for an operator who wants relative displacement only.
   */
  showAbsoluteDepth: true
};

/** A complete settings object with every default applied. */
export function defaultSensorSettings() {
  return {
    acquisition: { ...DEFAULT_ACQUISITION_SETTINGS },
    quality: { ...DEFAULT_QUALITY_SETTINGS, requireFix: [...DEFAULT_QUALITY_SETTINGS.requireFix] },
    display: { ...DEFAULT_DISPLAY_SETTINGS }
  };
}

/**
 * Repairs whatever came out of storage into a usable settings object.
 *
 * Never throws and never rejects a whole record for one bad field: a sensor
 * whose `maxHdop` got corrupted must keep its identity, its assignment and its
 * calibration. Each field independently falls back to its default.
 */
export function normalizeSensorSettings(raw) {
  const defaults = defaultSensorSettings();
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  return {
    acquisition: {
      transportPreference: normalizeTransportPreference(raw.acquisition?.transportPreference),
      onlineTimeoutMs: positiveIntOr(raw.acquisition?.onlineTimeoutMs, DEFAULT_ACQUISITION_SETTINGS.onlineTimeoutMs)
    },
    quality: {
      requireFix: normalizeFixList(raw.quality?.requireFix),
      minSatellites: nonNegativeIntOr(raw.quality?.minSatellites, DEFAULT_QUALITY_SETTINGS.minSatellites),
      maxHdop: positiveNumberOr(raw.quality?.maxHdop, DEFAULT_QUALITY_SETTINGS.maxHdop),
      filterProfile: Object.hasOwn(PRESET_FILTER_CHAINS, raw.quality?.filterProfile)
        ? raw.quality.filterProfile
        : DEFAULT_QUALITY_SETTINGS.filterProfile
    },
    display: {
      showAbsoluteDepth: typeof raw.display?.showAbsoluteDepth === "boolean"
        ? raw.display.showAbsoluteDepth
        : DEFAULT_DISPLAY_SETTINGS.showAbsoluteDepth
    }
  };
}

/**
 * Validates a settings PATCH from the UI.
 *
 * Returns `{ settings, errors }` with `settings: null` when anything is
 * invalid — unlike `normalizeSensorSettings`, which repairs. The difference
 * matters: repairing storage silently is right (the farmer cannot act on it),
 * repairing a form silently is wrong (they typed it and deserve to know it
 * was not accepted).
 */
export function validateSettingsPatch(current, patch) {
  const errors = [];
  const base = normalizeSensorSettings(current);
  const next = {
    acquisition: { ...base.acquisition },
    quality: { ...base.quality, requireFix: [...base.quality.requireFix] },
    display: { ...base.display }
  };

  if (patch?.acquisition?.transportPreference !== undefined) {
    const value = patch.acquisition.transportPreference;
    if (normalizeTransportPreference(value) !== value) {
      errors.push(`接続方法が不正です: ${JSON.stringify(value)} / invalid transport preference`);
    } else {
      next.acquisition.transportPreference = value;
    }
  }
  if (patch?.acquisition?.onlineTimeoutMs !== undefined) {
    const value = Number(patch.acquisition.onlineTimeoutMs);
    if (!Number.isFinite(value) || value <= 0) {
      errors.push("オンライン判定時間は正の数値が必要です / online timeout must be positive");
    } else {
      next.acquisition.onlineTimeoutMs = Math.round(value);
    }
  }
  if (patch?.quality?.minSatellites !== undefined) {
    // `Number(null)` and `Number("")` are both 0, and 0 IS a legitimate value
    // here ("no minimum") -- so unlike maxHdop/onlineTimeoutMs, whose own
    // `> 0` check rejects a coerced 0 on its own, this field has to refuse
    // null/"" explicitly or a cleared form field silently becomes "no
    // minimum" instead of an error the farmer can see and correct.
    const raw = patch.quality.minSatellites;
    const value = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      errors.push("最小衛星数は0以上の整数が必要です / minSatellites must be a non-negative integer");
    } else {
      next.quality.minSatellites = value;
    }
  }
  if (patch?.quality?.maxHdop !== undefined) {
    const value = Number(patch.quality.maxHdop);
    if (!Number.isFinite(value) || value <= 0) {
      errors.push("HDOP上限は正の数値が必要です / maxHdop must be positive");
    } else {
      next.quality.maxHdop = value;
    }
  }
  if (patch?.quality?.filterProfile !== undefined) {
    if (!Object.hasOwn(PRESET_FILTER_CHAINS, patch.quality.filterProfile)) {
      errors.push(`フィルタ種別が不正です: ${JSON.stringify(patch.quality.filterProfile)} / unknown filter profile`);
    } else {
      next.quality.filterProfile = patch.quality.filterProfile;
    }
  }
  if (patch?.display?.showAbsoluteDepth !== undefined) {
    if (typeof patch.display.showAbsoluteDepth !== "boolean") {
      errors.push("水深表示の設定が不正です / showAbsoluteDepth must be a boolean");
    } else {
      next.display.showAbsoluteDepth = patch.display.showAbsoluteDepth;
    }
  }

  return errors.length > 0 ? { settings: null, errors } : { settings: next, errors: [] };
}

/**
 * Judges one measurement against a sensor's quality gate.
 *
 * A DOP the receiver never sent does NOT fail the gate. QZ1's GGA carries no
 * VDOP at all, so rejecting on a missing one would discard every fix from a
 * perfectly healthy device — the same reasoning altitude-filters.js applies
 * to its own DOP stages. Missing is missing; it is not "infinitely bad".
 */
export function judgeMeasurementQuality(measurement, settings) {
  const quality = normalizeSensorSettings(settings).quality;
  const reasons = [];

  if (!Number.isFinite(measurement?.latitude) || !Number.isFinite(measurement?.longitude)) {
    reasons.push("測位がありません / no position");
    return { quality: MEASUREMENT_QUALITY.REJECTED, reasons };
  }
  if (!Number.isFinite(measurement.fixQuality) || !quality.requireFix.includes(measurement.fixQuality)) {
    reasons.push(`fix品質 ${measurement.fixQuality ?? "—"} は許可されていません / fix quality not allowed`);
  }
  if (Number.isFinite(measurement.satellites) && measurement.satellites < quality.minSatellites) {
    reasons.push(`衛星数 ${measurement.satellites} < ${quality.minSatellites} / too few satellites`);
  }
  if (Number.isFinite(measurement.hdop) && measurement.hdop > quality.maxHdop) {
    reasons.push(`HDOP ${measurement.hdop} > ${quality.maxHdop} / HDOP too high`);
  }

  if (reasons.length > 0) {
    return { quality: MEASUREMENT_QUALITY.REJECTED, reasons };
  }
  return { quality: MEASUREMENT_QUALITY.VALID, reasons: [] };
}

/**
 * Calibration state for a sensor, given its stored calibration record.
 *
 * Mirrors what `calibration.js` will actually permit rather than second-
 * guessing it: a record with no validating experiment is INVALID here because
 * `canDeriveWaterDepth()` refuses it there. Two places must not disagree
 * about whether a depth may be shown.
 */
export function calibrationState(calibration, { nowMs = Date.now(), maxAgeMs = null } = {}) {
  if (!calibration) {
    return CALIBRATION_STATES.UNCALIBRATED;
  }
  if (!calibration.validation) {
    return CALIBRATION_STATES.INVALID;
  }
  if (!Number.isFinite(calibration.calibratedAt)) {
    return CALIBRATION_STATES.INVALID;
  }
  if (Number.isFinite(maxAgeMs) && nowMs - calibration.calibratedAt > maxAgeMs) {
    return CALIBRATION_STATES.EXPIRED;
  }
  return CALIBRATION_STATES.CALIBRATED;
}

/** A human-readable summary of what is actually in force, for the UI. */
export function describeSettings(settings) {
  const normalized = normalizeSensorSettings(settings);
  return {
    transportPreference: normalized.acquisition.transportPreference,
    onlineTimeoutSeconds: Math.round(normalized.acquisition.onlineTimeoutMs / 1000),
    requireFixText: normalized.quality.requireFix.join(", "),
    minSatellites: normalized.quality.minSatellites,
    maxHdop: normalized.quality.maxHdop,
    filterProfile: normalized.quality.filterProfile,
    filterStageCount: PRESET_FILTER_CHAINS[normalized.quality.filterProfile]?.length ?? 0,
    showAbsoluteDepth: normalized.display.showAbsoluteDepth
  };
}

/** A device model entry, falling back to the default rather than throwing. */
export function deviceModelFor(id) {
  return DEVICE_MODELS[id] ?? DEVICE_MODELS[DEFAULT_DEVICE_MODEL];
}

/** Trimmed model id, or the default. Never invents a model. */
export function normalizeDeviceModel(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return Object.hasOwn(DEVICE_MODELS, id) ? id : DEFAULT_DEVICE_MODEL;
}

function normalizeFixList(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_QUALITY_SETTINGS.requireFix];
  }
  const values = raw.map(Number).filter((value) => Number.isInteger(value) && value >= 0);
  return values.length > 0 ? values : [...DEFAULT_QUALITY_SETTINGS.requireFix];
}

function positiveIntOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function nonNegativeIntOr(value, fallback) {
  // `Number(null)` and `Number("")` are both 0, and 0 IS a legitimate
  // minSatellites value ("no minimum"). Unlike positiveIntOr/positiveNumberOr
  // below -- where a coerced 0 always fails their own `> 0` check and falls
  // through to `fallback` on its own -- this one has to reject null/""
  // explicitly before Number() ever sees them, or a corrupted/missing stored
  // value silently becomes "no minimum" instead of the documented default.
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function positiveNumberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
