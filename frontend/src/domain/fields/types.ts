import type { LatLon } from './geometry'

/**
 * Mirrors exactly what js/fields/field-annotation-core.js's buildField()
 * produces and what is persisted under localStorage key
 * suimonNaviFieldAnnotationsV2 (see docs/UI_REDESIGN.md Stage 2 section /
 * docs/FRONTEND_ARCHITECTURE.md). Every property is either persisted as-is or
 * computed once at creation time by the legacy builder -- nothing here is
 * renamed or restructured, per the task's data-compatibility rule.
 */
export interface FieldProperties {
  /** Persisted. Free-text note. */
  memo: string
  /** Persisted. Free-form provenance string (for example "QZ1_NMEA") -- not an enum and never validated against a fixed list. */
  sourceType: string
  /** Persisted. Original upload filename, when the field came from an NMEA log; null otherwise. */
  sourceFileName: string | null
  /** Persisted. ISO 8601. */
  createdAt: string
  /** Persisted. ISO 8601. */
  updatedAt: string
  /** Persisted. Computed once at creation by the legacy polygonAreaSquareMeters() -- see domain/fields/geometry.ts. Not recomputed on read. */
  areaM2: number
  /** Persisted. Gap between the boundary's first/last point at creation time, or null. */
  closureGapM: number | null
  /** Persisted. Whether the operator explicitly confirmed closing a non-trivial gap. */
  closedManually: boolean
  /** Persisted. Vertex count at creation time. */
  sourcePointCount: number
  /** Persisted when sourced from an NMEA log (legacy summarizeFixQuality() shape); otherwise null. Opaque here -- Stage 2 does not display it. */
  fixQualitySummary: unknown | null
}

export interface Field {
  /** Persisted. Stable identity; also a foreign key from boundaryTracks/surveySessions/waterControlPoints/fieldObservations (see js/fields/field-annotation-controller.js deleteSelectedFeature()). */
  id: string
  /** Persisted. */
  name: string
  /** Persisted. Always "field" in the current schema. */
  type: 'field'
  /** Persisted. Always "Polygon" in the current schema. */
  geometryType: 'Polygon'
  /** Persisted. [lat, lon] pairs, an open ring -- the first point is not repeated at the end (matches Leaflet's own polygon convention). */
  coordinates: LatLon[]
  /** Persisted. Links back to the survey session this field was registered from, or null for another source. */
  sourceSessionId: string | null
  properties: FieldProperties
}

export interface CreateFieldInput {
  name: string
  coordinates: LatLon[]
  memo?: string
  /** Whether the caller already confirmed closing a non-trivial start/end gap. See services/fields/legacyFieldRepository.ts. */
  closedManually?: boolean
  /** Existing schema provenance used when a saved survey is the source. */
  sourceSessionId?: string | null
  sourceTrackId?: string | null
  /** False only for an operator-confirmed duplicate sourced from an already-linked survey. */
  linkSourceToField?: boolean
  sourceType?: string
  sourceFileName?: string | null
  sourcePointCount?: number
  fixQualitySummary?: unknown | null
}

/**
 * Deliberately narrow (docs/UI_REDESIGN.md Stage 2 section): only name/memo
 * are patchable in Stage 2. Legacy also allows renaming a field's `id`, with
 * a cascading foreign-key rename across boundaryTracks/surveySessions/
 * waterControlPoints/fieldObservations
 * (js/fields/field-annotation-controller.js saveSelectedFeature()) -- that is
 * not reproduced here rather than guessed at; see the docs for why.
 */
export interface FieldPatch {
  name?: string
  memo?: string
}
