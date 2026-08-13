import type { LatLon } from '../fields/geometry'

/**
 * Water in this repository is **two unrelated persisted things**, in two
 * different databases. Stage 4A models both, and deliberately does not merge
 * them (see docs/HANDOFF.md Stage 4A):
 *
 * 1. `WaterControlPoint` -- a *location* (gate/inlet/outlet/sensor/photo) in
 *    localStorage `suimonNaviFieldAnnotationsV2`.`waterControlPoints`, built by
 *    the unchanged `buildWaterControlPoint()`.
 * 2. `WaterLevelMeasurement` -- a *reading* carried on a recording marked
 *    observation in IndexedDB `suimon-navi-recording`.`markedObservations`,
 *    built by the unchanged `buildMarkedObservation()`.
 *
 * A "水位センサ" control point is a pin marking where a sensor sits; it holds no
 * reading. Nothing in the legacy schema links the two. Stage 4A keeps them
 * separate entity types for exactly that reason.
 */

// ---------------------------------------------------------------------------
// Water control points -- localStorage annotation store
// ---------------------------------------------------------------------------

/**
 * The five short internal keys. These drive labels and styling only; they are
 * **never** the persisted value of `WaterControlPoint.type` -- see
 * `PersistedWaterControlType` (js/fields/field-annotation-core.js:33-39, :331).
 */
export type WaterControlType = 'gate' | 'inlet' | 'outlet' | 'sensor' | 'photo'

/**
 * What actually lands in `record.type`: the long exported string
 * (js/fields/field-annotation-core.js:54-60). Note the asymmetry with field
 * observations, which persist their *short* internal key plus a `label` --
 * do not copy observation handling onto water.
 */
export type PersistedWaterControlType =
  | 'water_gate'
  | 'water_inlet'
  | 'water_outlet'
  | 'water_level_sensor'
  | 'photo_point'

/**
 * The only two provenance values the legacy controller ever writes for a water
 * control point (js/fields/field-annotation-controller.js:705, :801). Widened
 * with `string` because `properties.sourceType` is stored verbatim and is
 * never validated on read.
 */
export type WaterControlSourceType = 'manual_map_click' | 'qz1_current_position' | string

/**
 * Mirrors `buildWaterControlPoint()` exactly -- 6 root keys and a 4-key
 * `properties` bag, nothing else (js/fields/field-annotation-core.js:323-342).
 * Every property here is **persisted**; none is computed or derived on read.
 * There is deliberately no `label` key (observations have one, water does not);
 * the Japanese label is derived at render time from the type.
 */
export interface WaterControlPoint {
  /** Persisted. Legacy ids are `wcp-<uuid>` via `makeId('wcp')`. */
  id: string
  /** Persisted. May legitimately be an empty string; legacy never trims or validates it. */
  name: string
  /** Persisted. The long exported string, not the short internal key. */
  type: PersistedWaterControlType
  /**
   * Persisted. The field link. **Named `relatedFieldId`, not `fieldId`** --
   * every sibling collection (observations, boundaryTracks, surveySessions)
   * uses `fieldId`; water alone does not. A falsy value collapses to null, and
   * deleting a field unlinks its points to null rather than deleting them.
   */
  relatedFieldId: string | null
  /** Persisted. Always the literal "Point". */
  geometryType: 'Point'
  /** Persisted. `[lat, lon]`, Leaflet order -- never GeoJSON `[lon, lat]`. */
  coordinates: LatLon
  properties: {
    /** Persisted. Free text. */
    memo: string
    /** Persisted verbatim, never validated and with no legacy label map. */
    sourceType: WaterControlSourceType
    /** Persisted. ISO 8601. */
    createdAt: string
    /**
     * Persisted, but **not durable**: legacy rehydration re-runs every stored
     * point through the builder with `nowIso: properties.createdAt`, which
     * resets `updatedAt` back to `createdAt` on each page load
     * (js/fields/field-annotation-controller.js:305-316). Never build UI or a
     * test that depends on an edit timestamp surviving a reload.
     */
    updatedAt: string
  }
}

export interface CreateWaterControlPointInput {
  /** Short internal key; the repository converts it to the persisted long form. */
  type: WaterControlType
  /** Required by legacy, which refuses to add a point with no target field selected. */
  fieldId: string
  fieldName: string
  coordinates: LatLon
  sourceType: 'manual_map_click' | 'qz1_current_position'
  memo?: string
}

export interface WaterControlSnapshot {
  points: WaterControlPoint[]
  warnings: string[]
  error: string | null
}

// ---------------------------------------------------------------------------
// Water level measurements -- IndexedDB recording store (READ-ONLY in Stage 4A)
// ---------------------------------------------------------------------------

/**
 * A `water_level` marked observation, adapted for display. Source of truth is
 * `buildMarkedObservation()` (js/recording/recording-core.js:197-225), whose
 * records live in IndexedDB `suimon-navi-recording` v1, store
 * `markedObservations`, keyed by `id` and indexed `by_sessionId`.
 *
 * Stage 4A never writes one. Creation is deferred because a marked observation
 * is a *child of a recording session* (deleting the session cascade-deletes it,
 * js/recording/recording-store.js:144) and legacy only ever creates one from a
 * validated, non-stale live fix -- there is no map-click path whose GNSS
 * provenance fields could be filled without fabricating them.
 */
export interface WaterLevelMeasurement {
  /** Persisted. */
  id: string
  /** Persisted. The owning recording session; measurements cannot exist without one. */
  sessionId: string
  /**
   * Persisted. **Named `latitude`/`longitude`**, not a `[lat, lon]` tuple and
   * not `lat`/`lon` -- this store uses a third convention, distinct from both
   * the annotation store and the live GNSS fix shape.
   */
  latitude: number
  longitude: number
  /** Persisted. ISO 8601, stamped at creation. */
  timestamp: string | null
  /**
   * Persisted raw number. **The schema carries no unit.** "cm" appears only in
   * a legacy UI label (index.html:2705) and never in code or a test, so Stage 4A
   * displays this value without asserting a unit.
   *
   * Also: `0` is ambiguous, and much more common than it looks. The builder's
   * default parameter is `waterLevel = null`, and `Number(null) === 0` passes
   * its finiteness check (js/recording/recording-core.js:199, :218) -- so a
   * blank legacy input *and* an omitted argument both persist as `0`. A stored
   * `null` only happens for a non-numeric value. Treat 0 as "possibly not
   * entered", never as a measured zero depth.
   */
  waterLevel: number | null
  /** Persisted. Free text. */
  note: string
  /** Persisted. Links to a field when the recording session had one. */
  fieldId: string | null
  /** Persisted GNSS provenance, exactly as the receiver supplied it. */
  fixQuality: number | null
  satelliteCount: number | null
  hdop: number | null
  fixAugmented: boolean
  /** Persisted. A free-form transport label, e.g. "qz1_serial". */
  positionSource: string
}

export interface WaterMeasurementSnapshot {
  measurements: WaterLevelMeasurement[]
  loading: boolean
  error: string | null
}
