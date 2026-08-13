import { evaluateClosure, validateBoundary, type LatLon } from '../fields/geometry'
import type { SurveyRecord } from './types'

export interface SurveyBoundaryPreview {
  coordinates: LatLon[]
  source: 'boundary_track' | 'recording_fixes' | 'survey_points'
  warnings: string[]
  closureGapM: number | null
  autoClose: boolean
  requiresConfirmation: boolean
}

export class SurveyBoundaryError extends Error {}

/**
 * Boundary tracks are an explicit legacy boundary and therefore take
 * precedence. Otherwise only valid session fixes are eligible. Coordinates
 * remain [lat, lon]; repeated points are intentionally preserved because the
 * legacy registration flow does not silently deduplicate a walked path.
 */
export function prepareSurveyBoundary(survey: SurveyRecord): SurveyBoundaryPreview {
  const source = survey.track
    ? 'boundary_track'
    : survey.session?.measurementType === 'live_recording'
      ? 'recording_fixes'
      : 'survey_points'
  const raw = survey.track
    ? survey.track.coordinates
    : (survey.session?.points ?? [])
        .filter((point) => point.fixValid !== false)
        .map((point) => [point.lat, point.lon] as const)
  const coordinates = raw
    .filter((coordinate) => Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]))
    .map(([lat, lon]) => [lat, lon] as LatLon)

  const closure = evaluateClosure(coordinates)
  if (!closure.canClose) {
    throw new SurveyBoundaryError(`This survey cannot be registered as a field. Only ${coordinates.length} usable boundary points were found.`)
  }
  const validation = validateBoundary(coordinates)
  const warnings = [...new Set([...validation.warnings, ...closure.warnings])]
  return {
    coordinates,
    source,
    warnings,
    closureGapM: closure.gapM,
    autoClose: closure.autoClose,
    requiresConfirmation: !validation.valid || !closure.autoClose,
  }
}
