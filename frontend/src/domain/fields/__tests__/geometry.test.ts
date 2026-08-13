import { describe, expect, it } from 'vitest'
import { evaluateClosure, polygonAreaSquareMeters, validateBoundary } from '../geometry'
import { polygonAreaSquareMeters as legacyPolygonAreaSquareMeters } from '@legacy/fields/field-annotation-core.js'

// Same fixtures tests/unit/field-registry.test.js and
// tests/unit/field-annotation-core.test.js already use against the plain JS
// modules -- this file only checks the TypeScript wrapper forwards
// unmodified, not the geometry itself (task section 8/23: no second formula).
const SELF_INTERSECTING = [
  [35, 135],
  [35.0001, 135.0001],
  [35, 135.0001],
  [35.0001, 135],
] as [number, number][]

const SQUARE = [
  [34, 135],
  [34, 135.001],
  [34.001, 135.001],
  [34.001, 135],
] as [number, number][]

// ~3m sides -- validateBoundary's closure-gap check (a *warning*, not a
// polygon-validity concept in its own right) is about a walked path's start
// and end nearly meeting, so "a clean/valid boundary" for that function's
// purposes means "small residual gap", not merely "no self-intersection".
// SQUARE above is intentionally too large to also double as that fixture --
// see js/fields/field-registry.js's own 10m warning threshold.
const TIGHT_SQUARE = [
  [34, 135],
  [34, 135.00003],
  [34.00003, 135.00003],
  [34.00003, 135],
] as [number, number][]

describe('domain/fields/geometry (typed wrapper over @legacy/fields/*)', () => {
  it('validateBoundary flags self-intersection, matching field-registry.js', () => {
    const result = validateBoundary(SELF_INTERSECTING)
    expect(result.valid).toBe(false)
    expect(result.warnings.some((warning) => warning.includes('自己交差'))).toBe(true)
  })

  it('validateBoundary accepts a small, tightly-closed square', () => {
    expect(validateBoundary(TIGHT_SQUARE).valid).toBe(true)
  })

  it('evaluateClosure requires at least 3 points', () => {
    const result = evaluateClosure([
      [35, 135],
      [35, 135.001],
    ])
    expect(result.canClose).toBe(false)
  })

  it('evaluateClosure auto-closes a tight loop', () => {
    const result = evaluateClosure(SQUARE)
    expect(result.canClose).toBe(true)
    expect(result.selfIntersects).toBe(false)
  })

  it('polygonAreaSquareMeters returns a plausible area for a known square and 0 for degenerate input', () => {
    const area = polygonAreaSquareMeters(SQUARE)
    expect(area).toBe(legacyPolygonAreaSquareMeters(SQUARE))
    expect(area).toBeGreaterThan(10000)
    expect(area).toBeLessThan(15000)
    expect(polygonAreaSquareMeters([[34, 135], [34, 135.001]])).toBe(0)
  })
})
