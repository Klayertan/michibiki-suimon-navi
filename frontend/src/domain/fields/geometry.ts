// Typed wrappers around the existing, already-tested pure geometry/validation
// functions in js/fields/field-registry.js and js/fields/field-annotation-core.js
// (imported via the @legacy alias -- see ../../../vite.config.ts). No geometry
// or validation logic is reimplemented here: this file only adds the type
// signatures TypeScript needs at the boundary of a plain JS module, per the
// task's "use the existing authoritative field-area implementation" /
// "do not recreate validation logic" rules (docs/UI_REDESIGN.md Stage 2).
import { validateBoundary as legacyValidateBoundary } from '@legacy/fields/field-registry.js'
import {
  evaluateClosure as legacyEvaluateClosure,
  polygonAreaSquareMeters as legacyPolygonAreaSquareMeters,
  DEFAULT_AUTO_CLOSE_THRESHOLD_M,
} from '@legacy/fields/field-annotation-core.js'

/** [lat, lon], matching this codebase's coordinate order everywhere (see field-annotation-core.js's header comment). */
export type LatLon = [number, number]

export interface BoundaryValidation {
  valid: boolean
  warnings: string[]
  closureGapM: number | null
}

export interface ClosureEvaluation {
  canClose: boolean
  autoClose: boolean
  gapM: number | null
  selfIntersects: boolean
  warnings: string[]
}

/** Self-intersection and closure-gap checks -- from js/fields/field-registry.js. */
export function validateBoundary(coordinates: LatLon[]): BoundaryValidation {
  return legacyValidateBoundary(coordinates) as BoundaryValidation
}

/**
 * Decides whether a drawn/walked ring can auto-close or has a non-trivial gap
 * -- from js/fields/field-annotation-core.js. The repository preserves the
 * legacy hard floor (at least three points); creation UI is deferred to 2B.
 */
export function evaluateClosure(coordinates: LatLon[], thresholdM: number = DEFAULT_AUTO_CLOSE_THRESHOLD_M): ClosureEvaluation {
  return legacyEvaluateClosure(coordinates, thresholdM) as ClosureEvaluation
}

/**
 * Area in square meters -- from js/fields/field-annotation-core.js. Uses
 * Turf.js when `globalThis.turf` is loaded (this app's index.html loads the
 * same Turf build the legacy app uses), otherwise the same local-planar
 * fallback the legacy app itself falls back to when Turf fails to load.
 */
export function polygonAreaSquareMeters(coordinates: LatLon[]): number {
  return legacyPolygonAreaSquareMeters(coordinates)
}

export { DEFAULT_AUTO_CLOSE_THRESHOLD_M }
