import { parseNmeaSession } from '@legacy/gnss/nmea-parser.js'
import type { GnssPoint, PersistedLatLon, SurveyRecord, SurveySession, SurveyTrack } from './types'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function finiteOrNull(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(number) ? number : null
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export function adaptGnssPoint(value: unknown, fallbackId: string): GnssPoint | null {
  if (!isRecord(value)) return null
  const lat = finiteOrNull(value.lat)
  const lon = finiteOrNull(value.lon)
  if (lat === null || lon === null) return null

  return {
    id: stringOrNull(value.id) ?? fallbackId,
    lat,
    lon,
    timestamp: stringOrNull(value.timestamp),
    timestampUtcMs: finiteOrNull(value.timestampUtcMs),
    fixQuality: finiteOrNull(value.fixQuality),
    fixValid: booleanOrNull(value.fixValid),
    satellites: finiteOrNull(value.satellites) ?? finiteOrNull(value.satelliteCount),
    hdop: finiteOrNull(value.hdop),
    altitudeMsl: finiteOrNull(value.altitudeMsl) ?? finiteOrNull(value.altitude),
    augmented: booleanOrNull(value.augmented),
  }
}

export function adaptPersistedLatLon(value: unknown): PersistedLatLon | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const lat = finiteOrNull(value[0])
  const lon = finiteOrNull(value[1])
  return lat === null || lon === null ? null : [lat, lon]
}

export function adaptSurveySession(value: unknown, warnings: string[]): SurveySession | null {
  if (!isRecord(value) || !stringOrNull(value.id)) {
    warnings.push('A saved survey session was ignored because it has no valid id.')
    return null
  }
  const id = String(value.id)
  const sourcePoints = Array.isArray(value.rawPoints) ? value.rawPoints : []
  const points = sourcePoints
    .map((point, index) => adaptGnssPoint(point, `${id}-point-${index}`))
    .filter((point): point is GnssPoint => point !== null)
  if (points.length !== sourcePoints.length) {
    warnings.push(`${sourcePoints.length - points.length} malformed point(s) in ${stringOrNull(value.name) ?? id} were ignored.`)
  }
  return {
    id,
    name: stringOrNull(value.name) ?? id,
    fieldId: stringOrNull(value.fieldId),
    sourceFileName: stringOrNull(value.sourceFileName),
    measurementType: stringOrNull(value.measurementType),
    createdAt: stringOrNull(value.createdAt),
    uploadedAt: stringOrNull(value.uploadedAt),
    rawNmeaStored: booleanOrNull(value.rawNmeaStored),
    rawNmeaLineCount: finiteOrNull(value.rawNmeaLineCount),
    points,
  }
}

export function adaptSurveyTrack(value: unknown, warnings: string[]): SurveyTrack | null {
  if (!isRecord(value) || !stringOrNull(value.id)) {
    warnings.push('A saved boundary track was ignored because it has no valid id.')
    return null
  }
  const id = String(value.id)
  const sourceCoordinates = Array.isArray(value.coordinates) ? value.coordinates : []
  const coordinates = sourceCoordinates
    .map(adaptPersistedLatLon)
    .filter((coordinate): coordinate is PersistedLatLon => coordinate !== null)
  if (coordinates.length !== sourceCoordinates.length) {
    warnings.push(`${sourceCoordinates.length - coordinates.length} malformed coordinate(s) in ${stringOrNull(value.name) ?? id} were ignored.`)
  }
  const properties = isRecord(value.properties) ? value.properties : {}
  const fixQualitySummary = isRecord(properties.fixQualitySummary)
    ? Object.fromEntries(
        Object.entries(properties.fixQualitySummary).filter((entry): entry is [string, number] => finiteOrNull(entry[1]) !== null),
      )
    : null
  return {
    id,
    name: stringOrNull(value.name) ?? id,
    fieldId: stringOrNull(value.fieldId),
    sourceSessionId: stringOrNull(value.sourceSessionId),
    coordinates,
    createdAt: stringOrNull(properties.createdAt),
    fixQualitySummary,
  }
}

/** Joins legacy sessions/tracks without changing or manufacturing persisted data. */
export function joinSurveyRecords(sessions: SurveySession[], tracks: SurveyTrack[]): SurveyRecord[] {
  const tracksBySession = new Map(tracks.filter((track) => track.sourceSessionId).map((track) => [track.sourceSessionId!, track]))
  const joinedTrackIds = new Set<string>()
  const records = sessions.map((session): SurveyRecord => {
    const track = tracksBySession.get(session.id) ?? null
    if (track) joinedTrackIds.add(track.id)
    return {
      id: session.id,
      name: session.name,
      fieldId: session.fieldId ?? track?.fieldId ?? null,
      session,
      track,
      displayCoordinates:
        session.points.length >= 2 ? session.points.map((point) => [point.lat, point.lon]) : (track?.coordinates ?? []),
    }
  })
  for (const track of tracks) {
    if (joinedTrackIds.has(track.id)) continue
    records.push({
      id: `boundary-track:${track.id}`,
      name: track.name,
      fieldId: track.fieldId,
      session: null,
      track,
      displayCoordinates: track.coordinates,
    })
  }
  return records
}

/**
 * Typed, ephemeral wrapper over the existing tested parser. It never writes
 * imported text or points, and intentionally does not duplicate NMEA logic.
 */
export function parseSurveyNmeaPreview(text: string): GnssPoint[] {
  const parsed = parseNmeaSession(text)
  return parsed.observations
    .map((point: unknown, index: number) => adaptGnssPoint(point, `nmea-preview-${index}`))
    .filter((point: GnssPoint | null): point is GnssPoint => point !== null)
}
