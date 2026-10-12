// Facing direction for the blue "you are here" marker. Pure helpers only:
// the DOM / sensor wiring lives in index.html.
//
// Same rule as Google Maps: while moving, the direction of travel is the
// most trustworthy facing (GNSS course over ground); standing still, fall back
// to the phone's compass. With neither, show no direction cone rather than a
// made-up one.

// Below roughly walking pace the course reported by a GNSS receiver is noise.
export const MIN_COURSE_SPEED_MS = 0.7;
const KNOTS_TO_MS = 0.514444;

export function normalizeHeading(degrees) {
  if (!Number.isFinite(degrees)) return null;
  return ((degrees % 360) + 360) % 360;
}

export function knotsToMs(knots) {
  return Number.isFinite(knots) ? knots * KNOTS_TO_MS : null;
}

/**
 * @param {{ courseDegrees?: number|null, speedMs?: number|null, compassDegrees?: number|null }} inputs
 * @returns {{ degrees: number, source: "course"|"compass" }|null}
 */
export function resolveHeading({ courseDegrees = null, speedMs = null, compassDegrees = null } = {}) {
  const course = normalizeHeading(courseDegrees);
  if (course !== null && Number.isFinite(speedMs) && speedMs >= MIN_COURSE_SPEED_MS) {
    return { degrees: course, source: "course" };
  }
  const compass = normalizeHeading(compassDegrees);
  if (compass !== null) return { degrees: compass, source: "compass" };
  return null;
}

/**
 * Compass heading (degrees clockwise from north) from a deviceorientation
 * event, or null when the event does not carry a trustworthy absolute heading.
 *
 * - iOS Safari: `webkitCompassHeading` is already clockwise-from-north.
 * - Android Chrome: `deviceorientationabsolute` gives `alpha` counter-clockwise
 *   from north, so heading = 360 - alpha. A relative `deviceorientation` event
 *   (absolute === false) is rejected: its zero is arbitrary, not north.
 *
 * `screenAngle` (screen.orientation.angle) compensates for a rotated screen.
 */
export function compassHeadingFromEvent(event, screenAngle = 0) {
  if (!event) return null;
  if (Number.isFinite(event.webkitCompassHeading)) {
    return normalizeHeading(event.webkitCompassHeading + (Number.isFinite(screenAngle) ? screenAngle : 0));
  }
  if (event.absolute === true && Number.isFinite(event.alpha)) {
    return normalizeHeading(360 - event.alpha + (Number.isFinite(screenAngle) ? screenAngle : 0));
  }
  return null;
}

/** Smooths compass jitter along the shortest arc so the cone does not spin 359 -> 1. */
export function smoothHeading(previous, next, factor = 0.25) {
  const target = normalizeHeading(next);
  if (target === null) return normalizeHeading(previous);
  const start = normalizeHeading(previous);
  if (start === null) return target;
  const delta = ((target - start + 540) % 360) - 180;
  return normalizeHeading(start + delta * factor);
}

export function formatHeadingLabel(heading) {
  if (!heading) return "方位不明";
  const names = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
  const name = names[Math.round(heading.degrees / 45) % 8];
  return `${name} ${Math.round(heading.degrees)}°（${heading.source === "course" ? "進行方向" : "コンパス"}）`;
}
