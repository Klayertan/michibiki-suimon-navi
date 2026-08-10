import { describe, expect, it } from 'vitest'
import {
  deriveAreaUnits,
  deriveTraditionalAreaUnits,
  formatApproxTan,
  formatAreaA,
  formatAreaHa,
  getBoundaryAreaAvailability,
} from '../area'
import { polygonAreaSquareMeters } from '../geometry'

// Same fixtures domain/fields/__tests__/geometry.test.ts already pins against
// the legacy modules -- reused here rather than inventing new numbers.
const SQUARE: [number, number][] = [
  [34, 135],
  [34, 135.001],
  [34.001, 135.001],
  [34.001, 135],
]

const SELF_INTERSECTING: [number, number][] = [
  [35, 135],
  [35.0001, 135.0001],
  [35, 135.0001],
  [35.0001, 135],
]

// A real ~40m x 45m square, same as tests/unit/field-annotation-core.test.js's
// SQUARE fixture -- exercises a realistic GNSS-scale field polygon.
const REALISTIC_FIELD: [number, number][] = [
  [34.6548, 135.82982],
  [34.6548, 135.83027],
  [34.65444, 135.83027],
  [34.65444, 135.82982],
]

describe('domain/fields/area', () => {
  it('deriveAreaUnits converts m² to a and ha without rounding', () => {
    const units = deriveAreaUnits(4286)
    expect(units.m2).toBe(4286)
    expect(units.a).toBeCloseTo(42.86, 10)
    expect(units.ha).toBeCloseTo(0.4286, 10)
  })

  it('formatAreaA uses 2 decimal places', () => {
    expect(formatAreaA(4286)).toBe('42.86 a')
    expect(formatAreaA(100)).toBe('1.00 a')
  })

  it('formatAreaHa uses 3 decimal places', () => {
    expect(formatAreaHa(4286)).toBe('0.429 ha')
    expect(formatAreaHa(10000)).toBe('1.000 ha')
  })

  it('deriveTraditionalAreaUnits and formatApproxTan are clearly approximate, never authoritative', () => {
    const traditional = deriveTraditionalAreaUnits(4286)
    expect(traditional.tan).toBeCloseTo(4286 / 991.74, 10)
    expect(formatApproxTan(4286)).toBe('約 4.32反')
    expect(formatApproxTan(4286)).toMatch(/^約 /)
  })

  it('returns unavailable for 0 points', () => {
    expect(getBoundaryAreaAvailability([])).toEqual({ status: 'unavailable', reason: 'no-points' })
  })

  it('returns unavailable for 1-2 points', () => {
    expect(getBoundaryAreaAvailability([[35, 135]])).toEqual({ status: 'unavailable', reason: 'too-few-points' })
    expect(getBoundaryAreaAvailability([[35, 135], [35, 135.001]])).toEqual({
      status: 'unavailable',
      reason: 'too-few-points',
    })
  })

  it('returns unavailable for a self-intersecting (invalid) polygon, without computing a misleading area', () => {
    expect(getBoundaryAreaAvailability(SELF_INTERSECTING)).toEqual({ status: 'unavailable', reason: 'invalid-polygon' })
  })

  it('returns unavailable for a malformed coordinate rather than propagating NaN', () => {
    const malformed: [number, number][] = [[NaN, 135], [35, 135.001], [35.001, 135.001]]
    expect(getBoundaryAreaAvailability(malformed)).toEqual({ status: 'unavailable', reason: 'invalid-polygon' })
  })

  it('computes area for a valid >=3 point polygon, matching polygonAreaSquareMeters exactly', () => {
    const result = getBoundaryAreaAvailability(SQUARE)
    expect(result).toEqual({ status: 'ok', areaM2: polygonAreaSquareMeters(SQUARE) })
  })

  it('computes a plausible area for a realistic GNSS-scale field polygon', () => {
    const result = getBoundaryAreaAvailability(REALISTIC_FIELD)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.areaM2).toBeGreaterThan(1000)
      expect(result.areaM2).toBeLessThan(3000)
    }
  })

  it('is order-invariant: clockwise and counter-clockwise rings give the same area (within Turf floating-point tolerance)', () => {
    const clockwise = getBoundaryAreaAvailability(SQUARE)
    const counterClockwise = getBoundaryAreaAvailability([...SQUARE].reverse())
    expect(clockwise.status).toBe('ok')
    expect(counterClockwise.status).toBe('ok')
    if (clockwise.status === 'ok' && counterClockwise.status === 'ok') {
      expect(clockwise.areaM2).toBeCloseTo(counterClockwise.areaM2, 0)
    }
  })

  // A ring that repeats its closing point (as opposed to this codebase's
  // convention of an open ring -- see Field.coordinates' own doc comment)
  // makes the legacy self-intersection check see a degenerate zero-length
  // edge back to the start sharing an endpoint with the first edge, and it
  // flags that as a crossing. This is real authoritative-helper behavior,
  // not a bug introduced here -- it's exactly why boundaries are stored open.
  it('flags a ring that repeats its closing point as invalid, matching the open-ring convention', () => {
    const open = getBoundaryAreaAvailability(SQUARE)
    const closed = getBoundaryAreaAvailability([...SQUARE, SQUARE[0]])
    expect(open.status).toBe('ok')
    expect(closed).toEqual({ status: 'unavailable', reason: 'invalid-polygon' })
  })
})
