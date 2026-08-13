import { describe, expect, it } from 'vitest'
import {
  controlPointInternalType,
  controlPointTypeLabel,
  controlPointsForField,
  findControlPointById,
  formatWaterLevel,
  isAmbiguousZeroReading,
  isOrphanedControlPoint,
  measurementsForField,
  orphanedControlPoints,
  sortMeasurementsNewestFirst,
  waterControlTypeLabel,
} from '../selectors'
import type { PersistedWaterControlType, WaterControlPoint, WaterLevelMeasurement } from '../types'

function point(overrides: Partial<WaterControlPoint> = {}): WaterControlPoint {
  return {
    id: 'wcp-1',
    name: '北田 水門1',
    type: 'water_gate',
    relatedFieldId: 'f1',
    geometryType: 'Point',
    coordinates: [34.65, 135.83],
    properties: { memo: '', sourceType: 'manual_map_click', createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z' },
    ...overrides,
  }
}

function measurement(overrides: Partial<WaterLevelMeasurement> = {}): WaterLevelMeasurement {
  return {
    id: 'mo-1', sessionId: 'rec-1', latitude: 34.65, longitude: 135.83,
    timestamp: '2026-08-09T00:00:00.000Z', waterLevel: 4.5, note: '', fieldId: 'f1',
    fixQuality: 2, satelliteCount: 10, hdop: 0.9, fixAugmented: true, positionSource: 'qz1_serial',
    ...overrides,
  }
}

describe('domain/water/selectors', () => {
  it('maps every persisted type back to its short key and Japanese label', () => {
    const cases: Array<[PersistedWaterControlType, string, string]> = [
      ['water_gate', 'gate', '水門'],
      ['water_inlet', 'inlet', '給水口'],
      ['water_outlet', 'outlet', '排水口'],
      ['water_level_sensor', 'sensor', '水位センサ'],
      ['photo_point', 'photo', '撮影地点'],
    ]
    for (const [persisted, internal, label] of cases) {
      const candidate = point({ type: persisted })
      expect(controlPointInternalType(candidate)).toBe(internal)
      expect(controlPointTypeLabel(candidate)).toBe(label)
    }
    expect(waterControlTypeLabel('gate')).toBe('水門')
  })

  it('treats a null field link as orphaned, and finds orphans across the list', () => {
    const linked = point({ id: 'a' })
    const orphan = point({ id: 'b', relatedFieldId: null })
    expect(isOrphanedControlPoint(linked)).toBe(false)
    expect(isOrphanedControlPoint(orphan)).toBe(true)
    expect(orphanedControlPoints([linked, orphan]).map((item) => item.id)).toEqual(['b'])
  })

  it('filters by relatedFieldId, and returns nothing when no field is active', () => {
    const mine = point({ id: 'a', relatedFieldId: 'f1' })
    const other = point({ id: 'b', relatedFieldId: 'f2' })
    expect(controlPointsForField([mine, other], 'f1').map((item) => item.id)).toEqual(['a'])
    expect(controlPointsForField([mine, other], null)).toEqual([])
    expect(findControlPointById([mine, other], 'b')?.id).toBe('b')
    expect(findControlPointById([mine, other], null)).toBeNull()
    expect(findControlPointById([mine, other], 'missing')).toBeNull()
  })

  it('filters measurements by fieldId (the recording store uses fieldId, not relatedFieldId)', () => {
    const mine = measurement({ id: 'a', fieldId: 'f1' })
    const other = measurement({ id: 'b', fieldId: 'f2' })
    expect(measurementsForField([mine, other], 'f1').map((item) => item.id)).toEqual(['a'])
    expect(measurementsForField([mine, other], null)).toEqual([])
  })

  it('never asserts a unit for a reading, because the schema records none', () => {
    expect(formatWaterLevel(4.5)).toBe('4.5 (unit not recorded)')
    expect(formatWaterLevel(null)).toBe('Not recorded')
    expect(formatWaterLevel(Number.NaN)).toBe('Not recorded')
    expect(formatWaterLevel(0)).toBe('0 (unit not recorded)')
    // No selector should ever emit cm/mm -- "cm" lives only in a legacy label.
    expect(formatWaterLevel(4.5)).not.toMatch(/cm|mm/)
  })

  it('flags a stored zero as ambiguous rather than as a measured zero', () => {
    expect(isAmbiguousZeroReading(measurement({ waterLevel: 0 }))).toBe(true)
    expect(isAmbiguousZeroReading(measurement({ waterLevel: 4.5 }))).toBe(false)
    expect(isAmbiguousZeroReading(measurement({ waterLevel: null }))).toBe(false)
  })

  it('sorts readings newest first without mutating, putting undated ones last', () => {
    const input = [
      measurement({ id: 'old', timestamp: '2026-08-01T00:00:00.000Z' }),
      measurement({ id: 'undated', timestamp: null }),
      measurement({ id: 'new', timestamp: '2026-08-09T00:00:00.000Z' }),
    ]
    expect(sortMeasurementsNewestFirst(input).map((item) => item.id)).toEqual(['new', 'old', 'undated'])
    expect(input.map((item) => item.id)).toEqual(['old', 'undated', 'new'])
  })
})
