import { describe, expect, it } from 'vitest'
import { adaptGnssPoint, adaptPersistedLatLon, adaptSurveySession, joinSurveyRecords, parseSurveyNmeaPreview } from '../adapters'

describe('survey compatibility adapters', () => {
  it('pins persisted boundary tuples as [lat, lon] without swapping them', () => {
    expect(adaptPersistedLatLon([34.651, 135.831])).toEqual([34.651, 135.831])
  })

  it('adapts legacy point aliases and ignores malformed positions', () => {
    expect(adaptGnssPoint({ lat: 34.65, lon: 135.83, satelliteCount: 9, altitude: 12 }, 'fallback')).toMatchObject({
      lat: 34.65,
      lon: 135.83,
      satellites: 9,
      altitudeMsl: 12,
    })
    expect(adaptGnssPoint({ lat: '34.65', lon: 135.83 }, 'bad')).toBeNull()

    const warnings: string[] = []
    const session = adaptSurveySession({ id: 'session-1', rawPoints: [{ lat: 34.65, lon: 135.83 }, { lat: null, lon: 1 }] }, warnings)
    expect(session?.points).toHaveLength(1)
    expect(warnings.join(' ')).toContain('1 malformed point')
  })

  it('joins a session to its boundary track and retains an orphan track', () => {
    const records = joinSurveyRecords(
      [{ id: 's1', name: 'Session', fieldId: null, sourceFileName: null, measurementType: null, createdAt: null, uploadedAt: null, rawNmeaStored: null, rawNmeaLineCount: null, points: [] }],
      [
        { id: 't1', name: 'Linked', fieldId: 'f1', sourceSessionId: 's1', coordinates: [[34, 135], [34.1, 135.1]], createdAt: null, fixQualitySummary: null },
        { id: 't2', name: 'Orphan', fieldId: null, sourceSessionId: null, coordinates: [[35, 136], [35.1, 136.1]], createdAt: null, fixQualitySummary: null },
      ],
    )
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ id: 's1', fieldId: 'f1', track: { id: 't1' } })
    expect(records[0].displayCoordinates).toEqual([[34, 135], [34.1, 135.1]])
    expect(records[1].id).toBe('boundary-track:t2')
  })

  it('parses representative NMEA through the existing parser and preserves lat/lon meaning', () => {
    const points = parseSurveyNmeaPreview('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,')
    expect(points).toHaveLength(1)
    expect(points[0].lat).toBeCloseTo(48.1173, 6)
    expect(points[0].lon).toBeCloseTo(11.5166667, 6)
    expect(points[0]).toMatchObject({ fixQuality: 1, satellites: 8, hdop: 0.9 })
  })
})
