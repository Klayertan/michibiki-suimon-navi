// Display-unit derivation and area availability for boundary polygons. This
// file computes NOTHING geometric itself -- area always comes from
// polygonAreaSquareMeters and polygon validity always comes from
// evaluateClosure, both re-exported unmodified from ./geometry (which in turn
// forwards to js/fields/field-annotation-core.js / field-registry.js). See
// docs/UI_REDESIGN.md "field area" task: one authoritative area value, only
// display units derived from it, nothing persisted here.
import type { LatLon } from './geometry'
import { evaluateClosure, polygonAreaSquareMeters } from './geometry'

export interface AreaUnits {
  m2: number
  a: number
  ha: number
}

/** Presentation-only conversions (task section 3) -- never persist these, only areaM2. */
export function deriveAreaUnits(areaM2: number): AreaUnits {
  return { m2: areaM2, a: areaM2 / 100, ha: areaM2 / 10000 }
}

/** 2 decimal places, per the task's display-precision rule for 畝 (a). */
export function formatAreaA(areaM2: number): string {
  return `${(areaM2 / 100).toFixed(2)} a`
}

/** 3 decimal places, per the task's display-precision rule for ha. */
export function formatAreaHa(areaM2: number): string {
  return `${(areaM2 / 10000).toFixed(3)} ha`
}

/**
 * Traditional Japanese agricultural units -- secondary/optional (task section
 * 4), never authoritative and never persisted. Exposed for future UI use;
 * current UI surfaces only show m²/a/ha per the task's own worked examples.
 */
export interface TraditionalAreaUnits {
  se: number /** 畝 */
  tan: number /** 反 */
  cho: number /** 町 */
}

const SQUARE_METERS_PER_SE = 99.17
const SQUARE_METERS_PER_TAN = 991.74
const SQUARE_METERS_PER_CHO = 9917.36

export function deriveTraditionalAreaUnits(areaM2: number): TraditionalAreaUnits {
  return {
    se: areaM2 / SQUARE_METERS_PER_SE,
    tan: areaM2 / SQUARE_METERS_PER_TAN,
    cho: areaM2 / SQUARE_METERS_PER_CHO,
  }
}

/** e.g. "約 4.32反" -- always carries the approximation marker (task section 4). */
export function formatApproxTan(areaM2: number): string {
  return `約 ${(areaM2 / SQUARE_METERS_PER_TAN).toFixed(2)}反`
}

export type AreaUnavailableReason = 'no-points' | 'too-few-points' | 'invalid-polygon'

export type AreaAvailability = { status: 'unavailable'; reason: AreaUnavailableReason } | { status: 'ok'; areaM2: number }

function isFiniteCoordinate(point: LatLon): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1])
}

/**
 * For boundary coordinates that are not yet (or not only) a persisted field
 * -- a survey-to-field preview, or a future in-progress drawn boundary (task
 * sections 6/7/9). Reuses evaluateClosure's self-intersection check rather
 * than re-deriving polygon validity, and the same polygonAreaSquareMeters a
 * saved field's own properties.areaM2 is computed with, so a preview and the
 * field it produces always agree (task section 10). Never repairs invalid
 * geometry -- an unavailable result stays unavailable.
 */
export function getBoundaryAreaAvailability(coordinates: LatLon[]): AreaAvailability {
  if (!coordinates || coordinates.length === 0) return { status: 'unavailable', reason: 'no-points' }
  if (coordinates.length < 3) return { status: 'unavailable', reason: 'too-few-points' }
  if (!coordinates.every(isFiniteCoordinate)) return { status: 'unavailable', reason: 'invalid-polygon' }
  if (evaluateClosure(coordinates).selfIntersects) return { status: 'unavailable', reason: 'invalid-polygon' }
  return { status: 'ok', areaM2: polygonAreaSquareMeters(coordinates) }
}
