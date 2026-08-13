import { describe, expect, it, vi } from 'vitest'
import { createLegacySurveyRepository } from '../legacySurveyRepository'

function storageWith(value: string | null): Storage {
  const values = new Map<string, string>()
  if (value !== null) values.set('suimonNaviFieldAnnotationsV2', value)
  return {
    get length() { return values.size },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, next: string) => values.set(key, next)),
  }
}

describe('LegacySurveyRepository', () => {
  it('reads a representative legacy v3 session/track without writing and preserves [lat, lon]', async () => {
    const storage = storageWith(JSON.stringify({
      schemaVersion: 3,
      fields: [],
      boundaryTracks: [{
        id: 'track-1', name: 'North boundary', type: 'field_boundary_track', fieldId: 'field-1', geometryType: 'LineString',
        coordinates: [[34.6512, 135.8314], [34.6513, 135.8315]], sourceSessionId: 'session-1',
        properties: { createdAt: '2026-01-01T00:00:00.000Z', fixQualitySummary: { total: 2, augmented: 1 } },
      }],
      surveySessions: [{
        id: 'session-1', name: 'North survey', fieldId: 'field-1', sourceFileName: 'north.nmea', measurementType: 'boundary_track',
        createdAt: '2026-01-01T00:00:00.000Z', uploadedAt: '2026-01-01T00:01:00.000Z',
        rawPoints: [
          { id: 'p1', timestamp: '120000', lat: 34.6512, lon: 135.8314, fixQuality: 2, satellites: 11, hdop: 0.7 },
          { id: 'p2', timestamp: '120001', lat: 34.6513, lon: 135.8315, fixQuality: 1, satellites: 10, hdop: 0.8 },
        ],
      }],
      waterControlPoints: [], fieldObservations: [], workflowState: {},
    }))
    const repository = createLegacySurveyRepository(storage)

    const surveys = await repository.list()
    expect(surveys).toHaveLength(1)
    expect(await repository.get('session-1')).toEqual(surveys[0])
    expect(surveys[0].displayCoordinates).toEqual([[34.6512, 135.8314], [34.6513, 135.8315]])
    expect(surveys[0].session?.points[0]).toMatchObject({ lat: 34.6512, lon: 135.8314, hdop: 0.7, satellites: 11 })
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid JSON', '{'],
    ['unsupported schema', JSON.stringify({ schemaVersion: 4, surveySessions: [], boundaryTracks: [] })],
  ])('reports %s as an error and never mutates storage', async (_label, raw) => {
    const storage = storageWith(raw)
    const repository = createLegacySurveyRepository(storage)
    expect(repository.getSnapshot().error).not.toBeNull()
    expect(await repository.list()).toEqual([])
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('keeps valid records while reporting malformed child data', () => {
    const storage = storageWith(JSON.stringify({
      schemaVersion: 3,
      surveySessions: [{ id: 's1', rawPoints: [{ lat: 1, lon: 2 }, { lat: 'bad', lon: 2 }] }],
      boundaryTracks: 'bad',
    }))
    const snapshot = createLegacySurveyRepository(storage).getSnapshot()
    expect(snapshot.surveys).toHaveLength(1)
    expect(snapshot.surveys[0].session?.points).toHaveLength(1)
    expect(snapshot.warnings.join(' ')).toContain('malformed point')
    expect(snapshot.warnings.join(' ')).toContain('boundaryTracks')
  })
})
