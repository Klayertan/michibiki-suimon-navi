import {
  WATER_CONTROL_TYPE_LABELS,
  waterControlInternalType,
} from '@legacy/fields/field-annotation-core.js'
import type {
  WaterControlPoint,
  WaterControlType,
  WaterLevelMeasurement,
} from './types'

/**
 * Short internal key for a persisted point, via the unchanged legacy helper --
 * which also defines the fallback: an unknown/missing type normalizes to
 * `gate` rather than being dropped (js/fields/field-annotation-core.js:66-71).
 */
export function controlPointInternalType(point: WaterControlPoint): WaterControlType {
  return waterControlInternalType(point) as WaterControlType
}

/** The legacy Japanese label (水門 / 給水口 / 排水口 / 水位センサ / 撮影地点). */
export function controlPointTypeLabel(point: WaterControlPoint): string {
  return WATER_CONTROL_TYPE_LABELS[controlPointInternalType(point)]
}

export function waterControlTypeLabel(type: WaterControlType): string {
  return WATER_CONTROL_TYPE_LABELS[type]
}

/**
 * A point whose field link was cleared -- which legacy does silently when the
 * owning field is deleted. Orphans still render on the map but disappear from
 * every report and count, so the workspace surfaces them explicitly rather
 * than letting them become invisible-but-present data.
 */
export function isOrphanedControlPoint(point: WaterControlPoint): boolean {
  return point.relatedFieldId === null
}

export function controlPointsForField(points: WaterControlPoint[], fieldId: string | null): WaterControlPoint[] {
  if (!fieldId) return []
  return points.filter((point) => point.relatedFieldId === fieldId)
}

export function orphanedControlPoints(points: WaterControlPoint[]): WaterControlPoint[] {
  return points.filter(isOrphanedControlPoint)
}

export function findControlPointById(points: WaterControlPoint[], id: string | null): WaterControlPoint | null {
  if (!id) return null
  return points.find((point) => point.id === id) ?? null
}

export function measurementsForField(
  measurements: WaterLevelMeasurement[],
  fieldId: string | null,
): WaterLevelMeasurement[] {
  if (!fieldId) return []
  return measurements.filter((measurement) => measurement.fieldId === fieldId)
}

export function findMeasurementById(
  measurements: WaterLevelMeasurement[],
  id: string | null,
): WaterLevelMeasurement | null {
  if (!id) return null
  return measurements.find((measurement) => measurement.id === id) ?? null
}

/**
 * Renders a stored reading **without asserting a unit**, because the persisted
 * schema carries none (see WaterLevelMeasurement.waterLevel). `0` is reported
 * as recorded but flagged by `isAmbiguousZeroReading` so the inspector can
 * explain it rather than presenting it as a measured zero.
 */
export function formatWaterLevel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Not recorded'
  return `${value} (unit not recorded)`
}

/** True for the legacy blank-input-persists-as-0 case, which must not read as a real zero. */
export function isAmbiguousZeroReading(measurement: WaterLevelMeasurement): boolean {
  return measurement.waterLevel === 0
}

/** Newest first by timestamp; records with no timestamp sort last, order otherwise preserved. */
export function sortMeasurementsNewestFirst(measurements: WaterLevelMeasurement[]): WaterLevelMeasurement[] {
  return [...measurements].sort((a, b) => {
    const left = a.timestamp ? Date.parse(a.timestamp) : Number.NaN
    const right = b.timestamp ? Date.parse(b.timestamp) : Number.NaN
    if (!Number.isFinite(left) && !Number.isFinite(right)) return 0
    if (!Number.isFinite(left)) return 1
    if (!Number.isFinite(right)) return -1
    return right - left
  })
}
