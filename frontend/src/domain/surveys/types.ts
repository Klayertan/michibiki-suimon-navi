/**
 * Persisted GNSS observations use named `lat`/`lon` properties. Persisted
 * boundary-track coordinates use tuples in `[lat, lon]` order. Neither is
 * GeoJSON `[lon, lat]`; conversion is only performed by the map view.
 */
export type PersistedLatLon = readonly [lat: number, lon: number]

export interface GnssPoint {
  id: string
  lat: number
  lon: number
  timestamp: string | null
  timestampUtcMs: number | null
  fixQuality: number | null
  fixValid: boolean | null
  satellites: number | null
  hdop: number | null
  altitudeMsl: number | null
  augmented: boolean | null
}

export interface SurveyTrack {
  id: string
  name: string
  fieldId: string | null
  sourceSessionId: string | null
  coordinates: PersistedLatLon[]
  createdAt: string | null
  fixQualitySummary: Record<string, number> | null
}

export interface SurveySession {
  id: string
  name: string
  fieldId: string | null
  sourceFileName: string | null
  measurementType: string | null
  createdAt: string | null
  uploadedAt: string | null
  rawNmeaStored: boolean | null
  rawNmeaLineCount: number | null
  points: GnssPoint[]
}

export interface SurveyRecord {
  /** Session id, or `boundary-track:<id>` for a track with no saved session. */
  id: string
  name: string
  fieldId: string | null
  session: SurveySession | null
  track: SurveyTrack | null
  /** Authoritative display path, still `[lat, lon]` until the Leaflet view. */
  displayCoordinates: PersistedLatLon[]
}

export interface SurveyRepositorySnapshot {
  surveys: SurveyRecord[]
  warnings: string[]
  error: string | null
  loading: boolean
}
