// The water-depth MEASUREMENT record: value + where it came from + when.
//
// Why this is a record and not a bare number: today the farmer types the depth
// into the 水管理 card, but the same slot is meant to be filled by an Intel
// RealSense depth-camera reading, a water-level sensor at a 水位センサ point, or
// a drone observation. Those writers must be able to replace `source: "manual"`
// with `source: "realsense"` and change nothing else -- so the recommendation
// engine only ever sees { valueMm, source, measuredAt }, never "the number in
// the input box".
//
// (The project brief names the camera a "D345". Intel's shipping RealSense
// depth line is D4xx -- D405/D415/D435/D435i/D455 -- so no model number is
// hard-coded anywhere here; edge/perception/camera/realsense.py likewise reads
// the model from the device at runtime. Confirm the exact unit before quoting
// a model in a demo.)
//
// UNITS. `valueMm` is the canonical value, in millimetres, because the
// physical conversion the engine performs is defined in mm (1mm over 1m² = 1L).
// cm is carried alongside for display and for backward compatibility, and is
// always derived, never independently entered.
//
// BACKWARD COMPATIBILITY. Before this module, index.html persisted
// `suimonNaviCurrentWaterLevelV1` as { [fieldId]: { valueCm, recordedAt } }
// (cm, epoch ms) and js/water/water-need.js still reads exactly that shape.
// So:
//   - normalizeWaterMeasurement() accepts BOTH the legacy cm entry and the new
//     record, so already-saved fields keep working with no migration step and
//     no data loss;
//   - toPersistedEntry() writes BOTH shapes into one object, so an older code
//     path (and the existing 今日の水門判断 hero) reads valueCm/recordedAt while
//     new code reads valueMm/source/measuredAt.
// Neither direction ever fabricates a value: a field with no reading at all
// stays null rather than becoming 0mm.

// WATER-LEVEL DATUM AND SIGN CONVENTION
//
// A water level is meaningless without saying what it is measured FROM, so
// every record names its datum explicitly in `reference`.
//
//   reference: "soil-surface"   (the only datum this app currently uses)
//
//     valueMm  >  0   water surface ABOVE the soil surface (standing water)
//     valueMm === 0   water surface exactly AT the soil surface
//     valueMm  <  0   water level BELOW the soil surface (sub-surface water table)
//
//   +50 mm  =  5 cm of standing water
//     0 mm  =  water exactly at the soil surface
//  -150 mm  =  water table 15 cm below the soil surface
//
// The negative half of that range is not an edge case: it is where IRRI's
// safe-AWD (Alternate Wetting and Drying) threshold lives -- "when the water
// level has dropped to about 15 cm below the surface of the soil, irrigation
// should be applied" -- i.e. exactly -150 mm. Rejecting negatives made safe AWD
// unrepresentable, so signed values are preserved here.
//
// +150 and -150 are opposite field states about 30 cm apart. Never compare
// depths with Math.abs(), and never clamp a negative to 0 before arithmetic.
//
// Supporting the MEASUREMENT is not the same as supporting the AGRONOMY: this
// module lets a farmer record an AWD reading truthfully; it does not make the
// growth-stage recommendation model AWD-aware. See docs/PADDY_WATER_MANAGEMENT.md.

/** Datums a measurement can be expressed against. */
export const WATER_LEVEL_REFERENCES = {
  soilSurface: {
    id: "soil-surface",
    labelJa: "田面（地表面）基準",
    labelEn: "Relative to soil surface"
  }
};

/**
 * The datum assumed when none is recorded.
 *
 * Legacy entries carry no `reference`, but the input that produced them was
 * labelled 水位 (cm) and always meant depth of water standing on the field, so
 * "soil-surface" is a statement of what those readings already meant -- not a
 * guess. Normalisation applies it in memory only; stored rows are never
 * rewritten to migrate them.
 */
export const DEFAULT_WATER_LEVEL_REFERENCE = WATER_LEVEL_REFERENCES.soilSurface.id;

/** True for a datum this build understands. */
export function isKnownReference(reference) {
  return typeof reference === "string"
    && Object.values(WATER_LEVEL_REFERENCES).some((entry) => entry.id === reference);
}

/** Unknown/missing datums resolve to the default rather than to `undefined`. */
export function normalizeReference(reference) {
  return isKnownReference(reference) ? reference : DEFAULT_WATER_LEVEL_REFERENCE;
}

/**
 * True when a stored entry names a datum this build cannot interpret.
 *
 * An ABSENT reference is fine -- that is every legacy record, and it means
 * soil-surface (see DEFAULT_WATER_LEVEL_REFERENCE). But a record that
 * explicitly names some OTHER datum must not be silently re-read as
 * soil-surface: reinterpreting a reading against the wrong datum is precisely
 * the confusion the sign convention exists to prevent, and it would be
 * invisible to the farmer. Such an entry is reported as unreadable instead.
 */
export function hasUnknownReference(raw) {
  return Boolean(raw)
    && typeof raw === "object"
    && typeof raw.reference === "string"
    && raw.reference !== ""
    && !isKnownReference(raw.reference);
}

/** Japanese label for a datum, for the UI's sign hint. */
export function referenceLabel(reference) {
  const id = normalizeReference(reference);
  const entry = Object.values(WATER_LEVEL_REFERENCES).find((candidate) => candidate.id === id);
  return entry ? entry.labelJa : WATER_LEVEL_REFERENCES.soilSurface.labelJa;
}

export const MEASUREMENT_SOURCES = {
  manual: { id: "manual", labelJa: "手入力", labelEn: "Manual entry" },
  realsense: { id: "realsense", labelJa: "RealSense計測", labelEn: "RealSense depth camera" },
  sensor: { id: "sensor", labelJa: "水位センサ", labelEn: "Water-level sensor" },
  drone: { id: "drone", labelJa: "ドローン観測", labelEn: "Drone observation" }
};

/** A reading older than this is shown with a "confirm on site" warning. */
export const STALE_MEASUREMENT_DAYS = 3;

export function measurementSourceLabel(source) {
  return MEASUREMENT_SOURCES[source]?.labelJa || "不明な取得元";
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** mm -> cm, rounded to 1 decimal (the precision the cm inputs use). */
export function mmToCm(valueMm) {
  return isFiniteNumber(valueMm) ? Math.round(valueMm) / 10 : null;
}

/** cm -> mm. Kept as a named function so the factor never appears inline. */
export function cmToMm(valueCm) {
  return isFiniteNumber(valueCm) ? valueCm * 10 : null;
}

/**
 * Accepts epoch ms or an ISO string; anything else is null rather than a
 * silently-wrong `new Date(undefined)`.
 */
function toEpochMs(value) {
  if (isFiniteNumber(value)) {
    return value;
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * @param {object} input
 * @param {number} input.valueMm    water level in mm, SIGNED, relative to `reference`
 * @param {string} [input.source]   "manual" (default) | "realsense" | "sensor" | "drone" | any future writer id
 * @param {number|string} [input.measuredAt] epoch ms or ISO string; defaults to now
 * @param {string} [input.reference] datum; defaults to "soil-surface"
 * @returns {{valueMm:number, valueCm:number, reference:string, source:string, measuredAt:number}|null}
 *
 * Any finite number is a valid reading, negative included -- see the sign
 * convention above. Only NON-FINITE input is rejected, and it is rejected
 * strictly: `isFiniteNumber` tests `typeof value === "number"` first, so
 * null, undefined, "", "18", NaN and Infinity all return null rather than
 * being coerced. That strictness is the point -- `Number(null)` and
 * `Number("")` are both 0, and a missing reading silently becoming "0 mm"
 * would be a fabricated measurement at the soil surface.
 */
export function buildWaterMeasurement({
  valueMm,
  source = "manual",
  measuredAt = Date.now(),
  reference = DEFAULT_WATER_LEVEL_REFERENCE
} = {}) {
  if (!isFiniteNumber(valueMm)) {
    return null;
  }
  const stamp = toEpochMs(measuredAt);
  return {
    valueMm,
    valueCm: mmToCm(valueMm),
    reference: normalizeReference(reference),
    source: typeof source === "string" && source ? source : "manual",
    measuredAt: isFiniteNumber(stamp) ? stamp : Date.now()
  };
}

/**
 * Reads either shape out of storage:
 *   new    { valueMm, source, measuredAt, ... }
 *   legacy { valueCm, recordedAt }            <- everything saved before this feature
 * Returns null for a missing/corrupt entry so callers must handle "no
 * measurement" explicitly instead of receiving a plausible zero.
 */
export function normalizeWaterMeasurement(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  // A datum this build does not know -> unreadable, never silently re-read as
  // soil-surface. hasStoredDepthValue() still reports that a value IS stored,
  // so the caller says "cannot interpret", not "nothing recorded".
  if (hasUnknownReference(raw)) {
    return null;
  }
  if (isFiniteNumber(raw.valueMm)) {
    return buildWaterMeasurement({
      valueMm: raw.valueMm,
      source: raw.source,
      measuredAt: raw.measuredAt ?? raw.recordedAt,
      // Absent on every record written before the datum existed -> normalized
      // to soil-surface in memory. Storage is not rewritten.
      reference: raw.reference
    });
  }
  if (isFiniteNumber(raw.valueCm)) {
    // Legacy cm entry: the provenance was always a farmer typing into
    // 水位 (cm・任意), so "manual" is a statement of fact here, not a guess.
    // That input meant "water standing on the field", which IS the
    // soil-surface datum -- so -15 cm here and -150 mm written by the mm
    // writer normalize to the same physical measurement.
    return buildWaterMeasurement({
      valueMm: cmToMm(raw.valueCm),
      source: "manual",
      measuredAt: raw.recordedAt ?? raw.measuredAt,
      reference: raw.reference
    });
  }
  return null;
}

/**
 * The object to persist for one field: the new record PLUS the legacy
 * valueCm/recordedAt pair, so js/water/water-need.js and the existing
 * 今日の水門判断 hero keep reading the same field they always did.
 */
export function toPersistedEntry(measurement) {
  if (!measurement) {
    return null;
  }
  return {
    valueCm: measurement.valueCm,
    recordedAt: measurement.measuredAt,
    valueMm: measurement.valueMm,
    reference: measurement.reference,
    source: measurement.source,
    measuredAt: measurement.measuredAt
  };
}

/**
 * True when a stored entry CARRIES a depth value, whether or not this model can
 * interpret it.
 *
 * The distinction exists because `normalizeWaterMeasurement()` returns null for
 * two very different situations, and a caller that cannot tell them apart will
 * tell the farmer something false:
 *
 *   nothing was ever recorded          -> "水位未記録"  (correct)
 *   a value IS stored, but unreadable  -> "水位未記録"  (WRONG: it exists)
 *
 * A negative depth USED TO BE the live case for this predicate. It no longer is:
 * with an explicit datum and sign convention, -150 mm is a valid safe-AWD
 * reading that normalizes like any other, so it flows through the normal path.
 *
 * The predicate is deliberately KEPT rather than deleted, because it answers a
 * question that outlives that one bug: is a value stored that this model cannot
 * turn into a measurement? Future candidates are a corrupt entry, an
 * out-of-range sensor reading, or a record written against a datum this build
 * does not know (`reference` naming something other than soil-surface). Callers
 * that cannot distinguish "nothing recorded" from "something recorded that I
 * cannot read" will tell the farmer something false about their own data.
 */
export function hasStoredDepthValue(raw) {
  if (!raw || typeof raw !== "object") {
    return false;
  }
  return isFiniteNumber(raw.valueMm) || isFiniteNumber(raw.valueCm);
}

/** The stored depth in mm exactly as persisted -- uninterpreted, sign included. */
export function storedDepthMm(raw) {
  if (!hasStoredDepthValue(raw)) {
    return null;
  }
  return isFiniteNumber(raw.valueMm) ? raw.valueMm : cmToMm(raw.valueCm);
}

/**
 * Age of a reading in whole days, and whether it is stale.
 * `ageDays` is null when there is no usable timestamp -- never 0, which would
 * read as "measured today".
 */
export function measurementAge(measurement, now = Date.now()) {
  const stamp = measurement ? toEpochMs(measurement.measuredAt) : null;
  if (!isFiniteNumber(stamp)) {
    return { ageDays: null, isStale: false };
  }
  const ageDays = Math.max(0, Math.floor((now - stamp) / 86400000));
  return { ageDays, isStale: ageDays >= STALE_MEASUREMENT_DAYS };
}
