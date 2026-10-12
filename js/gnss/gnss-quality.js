// Pure fix-quality classification shared by the map markers and the live
// signal badge, so "green" means the same thing everywhere.
//
// This grades what the receiver REPORTS (GGA fix quality, HDOP, satellites
// used). It is not an accuracy claim: fix quality 2 proves the receiver was in
// a differential state, not that SLAS/CLAS was used or how far off the position
// is. See README ("センチメートル精度は主張しません").

export const QUALITY_LEVELS = Object.freeze({
  good: { level: "good", color: "#15803d", label: "良好", labelEn: "Good" },
  fair: { level: "fair", color: "#d97706", label: "普通", labelEn: "Fair" },
  poor: { level: "poor", color: "#b91c1c", label: "不良", labelEn: "Poor" },
  none: { level: "none", color: "#64748b", label: "測位なし", labelEn: "No fix" }
});

// Thresholds are deliberately plain and documented here rather than tuned to
// look good: HDOP <= 2 is the usual "good geometry" line, > 5 is the usual
// "do not trust" line.
export const GOOD_MAX_HDOP = 2;
export const POOR_MIN_HDOP = 5;
export const GOOD_MIN_SATELLITES = 6;
export const POOR_MAX_SATELLITES = 3;

const AUGMENTED_FIX_QUALITIES = new Set([2, 4, 5]);
const VALID_FIX_QUALITIES = new Set([1, 2, 4, 5]);

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * @param {{ fixQuality?: number|null, hdop?: number|null, satellites?: number|null }} fix
 * @returns {{ level: "good"|"fair"|"poor"|"none", color: string, label: string, labelEn: string, augmented: boolean }}
 */
export function classifyFix(fix) {
  const fixQuality = finiteOrNull(fix?.fixQuality);
  if (fixQuality === null || !VALID_FIX_QUALITIES.has(fixQuality)) {
    return { ...QUALITY_LEVELS.none, augmented: false };
  }
  const hdop = finiteOrNull(fix?.hdop);
  const satellites = finiteOrNull(fix?.satellites);
  const augmented = AUGMENTED_FIX_QUALITIES.has(fixQuality);

  const poor = (hdop !== null && hdop > POOR_MIN_HDOP) || (satellites !== null && satellites <= POOR_MAX_SATELLITES);
  if (poor) return { ...QUALITY_LEVELS.poor, augmented };

  // Unknown HDOP / satellite count never blocks "good" for an augmented fix
  // (older logs and some receivers omit them); a known-bad value does.
  const geometryOk = (hdop === null || hdop <= GOOD_MAX_HDOP) && (satellites === null || satellites >= GOOD_MIN_SATELLITES);
  if (augmented && geometryOk) return { ...QUALITY_LEVELS.good, augmented };

  return { ...QUALITY_LEVELS.fair, augmented };
}
