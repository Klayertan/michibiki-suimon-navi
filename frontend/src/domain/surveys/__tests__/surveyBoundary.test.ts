import { describe, expect, it } from 'vitest'
import { prepareSurveyBoundary, SurveyBoundaryError } from '../surveyBoundary'
import type { SurveyRecord } from '../types'

function survey(overrides: Partial<SurveyRecord> = {}): SurveyRecord {
  return {
    id: 'recording:r1', name: 'Walk', fieldId: null, track: null,
    session: {
      id: 'r1', name: 'Walk', fieldId: null, sourceFileName: null, measurementType: 'live_recording',
      createdAt: null, uploadedAt: null, rawNmeaStored: true, rawNmeaLineCount: 4,
      points: [
        { id: '1', lat: 34.65, lon: 135.83, fixValid: true, timestamp: null, timestampUtcMs: null, fixQuality: 2, satellites: 10, hdop: .8, altitudeMsl: null, augmented: true },
        { id: '2', lat: 34.65, lon: 135.831, fixValid: false, timestamp: null, timestampUtcMs: null, fixQuality: 0, satellites: 0, hdop: null, altitudeMsl: null, augmented: false },
        { id: '3', lat: 34.651, lon: 135.831, fixValid: true, timestamp: null, timestampUtcMs: null, fixQuality: 2, satellites: 10, hdop: .8, altitudeMsl: null, augmented: true },
        { id: '4', lat: 34.65, lon: 135.83, fixValid: true, timestamp: null, timestampUtcMs: null, fixQuality: 2, satellites: 10, hdop: .8, altitudeMsl: null, augmented: true },
      ],
    }, displayCoordinates: [], ...overrides,
  }
}

describe('prepareSurveyBoundary', () => {
  it('uses valid recording fixes in exact [lat, lon] order without mutating the survey', () => {
    const source = survey()
    const before = structuredClone(source)
    const result = prepareSurveyBoundary(source)
    expect(result.source).toBe('recording_fixes')
    expect(result.coordinates).toEqual([[34.65, 135.83], [34.651, 135.831], [34.65, 135.83]])
    expect(source).toEqual(before)
  })

  it('prefers an explicit boundary track and preserves duplicate vertices', () => {
    const source = survey({ track: { id: 't1', name: 'Boundary', fieldId: null, sourceSessionId: 'r1', createdAt: null, fixQualitySummary: null, coordinates: [[35, 136], [35, 136], [35.001, 136.001]] } })
    expect(prepareSurveyBoundary(source).coordinates).toEqual([[35, 136], [35, 136], [35.001, 136.001]])
  })

  it('fails clearly below the authoritative three-point floor', () => {
    const source = survey()
    source.session!.points = source.session!.points.slice(0, 2)
    expect(() => prepareSurveyBoundary(source)).toThrow(SurveyBoundaryError)
    expect(() => prepareSurveyBoundary(source)).toThrow(/Only 1 usable boundary points/)
  })

  it('requires explicit confirmation for self-intersection rather than changing legacy closure semantics', () => {
    const result = prepareSurveyBoundary(survey({ track: { id: 't', name: 'Bow', fieldId: null, sourceSessionId: null, createdAt: null, fixQualitySummary: null, coordinates: [[35, 135], [35.001, 135.001], [35, 135.001], [35.001, 135]] } }))
    expect(result.requiresConfirmation).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/自己交差/)
  })
})
