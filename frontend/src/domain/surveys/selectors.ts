import type { GnssPoint, SurveyRecord } from './types'

export function findSurveyById(surveys: SurveyRecord[], id: string | null): SurveyRecord | null {
  return id ? (surveys.find((survey) => survey.id === id) ?? null) : null
}

export function surveyPointCount(survey: SurveyRecord): number {
  return survey.session?.points.length ?? survey.displayCoordinates.length
}

export function surveyTimeRange(points: GnssPoint[]): string | null {
  const absolute = points.map((point) => point.timestampUtcMs).filter((value): value is number => value !== null)
  if (absolute.length > 0) {
    const first = new Date(Math.min(...absolute)).toLocaleString()
    const last = new Date(Math.max(...absolute)).toLocaleString()
    return first === last ? first : `${first} – ${last}`
  }
  const reported = points.map((point) => point.timestamp).filter((value): value is string => value !== null)
  if (reported.length > 0) return reported[0] === reported.at(-1) ? reported[0] : `${reported[0]} – ${reported.at(-1)}`
  return null
}

function numericRange(values: Array<number | null>): string | null {
  const valid = values.filter((value): value is number => value !== null)
  if (valid.length === 0) return null
  const minimum = Math.min(...valid)
  const maximum = Math.max(...valid)
  return minimum === maximum ? String(minimum) : `${minimum} – ${maximum}`
}

export function surveyHdopRange(survey: SurveyRecord): string | null {
  return numericRange(survey.session?.points.map((point) => point.hdop) ?? [])
}

export function surveySatelliteRange(survey: SurveyRecord): string | null {
  return numericRange(survey.session?.points.map((point) => point.satellites) ?? [])
}
