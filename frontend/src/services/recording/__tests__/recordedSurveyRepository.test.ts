import { describe, expect, it } from 'vitest'
import { RecordedSurveyRepository } from '../recordedSurveyRepository'

describe('RecordedSurveyRepository', () => {
  it('reads the unchanged IndexedDB recording schema into Survey records with lat/lon preserved', async () => {
    const repository = new RecordedSurveyRepository({
      async listSessions() {
        return [{ sessionId: 'rec-1', startedAt: '2026-08-08T01:00:00.000Z', endedAt: '2026-08-08T01:10:00.000Z', status: 'stopped', fieldId: 'field-1', fieldName: 'North', totalReceivedLines: 2 }]
      },
      async getStructuredFixes() {
        return [{ seq: 2, lat: 34.65, lon: 135.83, satellites: 12, hdop: 0.7 }, { seq: 4, lat: 34.651, lon: 135.831, satellites: 11, hdop: 0.8 }]
      },
    })
    await repository.refresh()
    const snapshot = repository.getSnapshot()
    expect(snapshot.error).toBeNull()
    expect(snapshot.surveys[0]).toMatchObject({ id: 'recording:rec-1', fieldId: 'field-1', session: { id: 'rec-1', rawNmeaStored: true } })
    expect(snapshot.surveys[0].displayCoordinates).toEqual([[34.65, 135.83], [34.651, 135.831]])
  })

  it('surfaces IndexedDB read failure without fabricating sessions', async () => {
    const repository = new RecordedSurveyRepository({
      async listSessions() { throw new Error('blocked') },
      async getStructuredFixes() { return [] },
    })
    await repository.refresh()
    expect(repository.getSnapshot()).toMatchObject({ surveys: [], loading: false })
    expect(repository.getSnapshot().error).toContain('blocked')
  })

  it('uses the existing session fieldId/fieldName properties when linking a recording', async () => {
    const patches: unknown[] = []
    const repository = new RecordedSurveyRepository({
      async listSessions() { return [] },
      async getStructuredFixes() { return [] },
      async updateSession(id, patch) { patches.push([id, patch]) },
    })
    await repository.linkToField('recording:rec-7', { id: 'field-7', name: 'West' })
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject(['rec-7', { fieldId: 'field-7', fieldName: 'West' }])
  })
})
