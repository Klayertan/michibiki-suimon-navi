import { describe, expect, it } from 'vitest'
import {
  fieldAreaSquareMeters,
  fieldBoundaryPointCount,
  findFieldById,
  formatAreaSquareMeters,
  sortFieldsByName,
} from '../selectors'
import type { Field } from '../types'

function makeField(overrides: Partial<Field> = {}): Field {
  return {
    id: 'field-1',
    name: 'Field',
    type: 'field',
    geometryType: 'Polygon',
    coordinates: [
      [35, 135],
      [35, 135.001],
      [35.001, 135.001],
    ],
    sourceSessionId: null,
    properties: {
      memo: '',
      sourceType: 'QZ1_NMEA',
      sourceFileName: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      areaM2: 1234,
      closureGapM: 0,
      closedManually: false,
      sourcePointCount: 3,
      fixQualitySummary: null,
    },
    ...overrides,
  }
}

describe('domain/fields/selectors', () => {
  it('fieldAreaSquareMeters / fieldBoundaryPointCount read persisted properties, no recomputation', () => {
    const field = makeField()
    expect(fieldAreaSquareMeters(field)).toBe(1234)
    expect(fieldBoundaryPointCount(field)).toBe(3)
  })

  it('formatAreaSquareMeters formats with thousands separators and rounds', () => {
    expect(formatAreaSquareMeters(12450.4)).toBe('12,450 m²')
    expect(formatAreaSquareMeters(0)).toBe('0 m²')
  })

  it('findFieldById returns null for a null id or a miss, and the match otherwise', () => {
    const fields = [makeField({ id: 'a' }), makeField({ id: 'b' })]
    expect(findFieldById(fields, null)).toBeNull()
    expect(findFieldById(fields, 'missing')).toBeNull()
    expect(findFieldById(fields, 'b')?.id).toBe('b')
  })

  it('sortFieldsByName sorts without mutating the input array', () => {
    const fields = [makeField({ id: 'a', name: '田2' }), makeField({ id: 'b', name: '田1' })]
    const sorted = sortFieldsByName(fields)
    expect(sorted.map((f) => f.id)).toEqual(['b', 'a'])
    expect(fields.map((f) => f.id)).toEqual(['a', 'b'])
  })
})
