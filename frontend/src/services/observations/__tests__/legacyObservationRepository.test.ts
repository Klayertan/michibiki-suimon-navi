import { describe, expect, it } from 'vitest'
import { LegacyObservationRepository } from '../legacyObservationRepository'
import { buildFieldObservation } from '@legacy/fields/field-annotation-core.js'

class FakeStorage implements Storage {
  data = new Map<string, string>()
  get length() { return this.data.size }
  clear() { this.data.clear() }
  getItem(key: string) { return this.data.get(key) ?? null }
  key(index: number) { return [...this.data.keys()][index] ?? null }
  removeItem(key: string) { this.data.delete(key) }
  setItem(key: string, value: string) { this.data.set(key, value) }
}
const KEY = 'suimonNaviFieldAnnotationsV2'
const store = (observations: unknown[] = []) => ({ schemaVersion: 3, fields: [{ id: 'f1' }], boundaryTracks: [], waterControlPoints: [], surveySessions: [], fieldObservations: observations, workflowState: { lastExportedAt: null } })

describe('LegacyObservationRepository', () => {
  it('reads a representative legacy observation with exact type and [lat, lon]', async () => {
    const storage = new FakeStorage()
    const legacy = { id: 'obs-1', fieldId: 'f1', type: 'insect', label: '害虫', name: 'Pest', geometryType: 'Point', coordinates: [34.65, 135.83], properties: { severity: 'high', memo: 'note', sourceType: 'manual_map_click', createdAt: '2026-08-09T00:00:00Z', updatedAt: '2026-08-09T00:00:00Z' } }
    storage.setItem(KEY, JSON.stringify(store([legacy])))
    const before = storage.getItem(KEY)
    const repository = new LegacyObservationRepository(storage)
    expect(await repository.list()).toEqual([legacy])
    expect((await repository.get('obs-1'))?.coordinates).toEqual([34.65, 135.83])
    expect(storage.getItem(KEY)).toBe(before)
  })

  it('creates the exact legacy-compatible shape and preserves sibling datasets', async () => {
    const storage = new FakeStorage()
    storage.setItem(KEY, JSON.stringify(store()))
    const repository = new LegacyObservationRepository(storage)
    const created = await repository.create({ fieldId: 'f1', fieldName: 'North', type: 'weed', severity: 'urgent', memo: 'edge', coordinates: [34.651, 135.832], sourceType: 'qz1_current_position' })
    expect(created).toMatchObject({ fieldId: 'f1', type: 'weed', geometryType: 'Point', coordinates: [34.651, 135.832], properties: { severity: 'urgent', memo: 'edge', sourceType: 'qz1_current_position' } })
    const raw = JSON.parse(storage.getItem(KEY)!)
    expect(raw.schemaVersion).toBe(3)
    expect(raw.fields).toEqual([{ id: 'f1' }])
    expect(Object.keys(raw).sort()).toEqual(['schemaVersion', 'fields', 'boundaryTracks', 'waterControlPoints', 'surveySessions', 'fieldObservations', 'workflowState'].sort())
    const persisted = raw.fieldObservations[0]
    const legacyRehydrated = buildFieldObservation({
      id: persisted.id, fieldId: persisted.fieldId, type: persisted.type, name: persisted.name,
      severity: persisted.properties.severity, memo: persisted.properties.memo,
      lat: persisted.coordinates[0], lon: persisted.coordinates[1],
      sourceType: persisted.properties.sourceType, nowIso: persisted.properties.createdAt,
    } as never)
    expect(legacyRehydrated).toEqual(persisted)
  })

  it('skips malformed reads and fails closed without replacing malformed bytes', async () => {
    const storage = new FakeStorage()
    storage.setItem(KEY, JSON.stringify(store([{ id: 'bad', coordinates: ['x', 2], properties: {} }])))
    const repository = new LegacyObservationRepository(storage)
    expect(repository.getSnapshot()).toMatchObject({ observations: [], warnings: ['1 malformed observation(s) were ignored.'] })
    storage.setItem(KEY, '{broken')
    repository.refresh()
    const before = storage.getItem(KEY)
    await expect(repository.create({ fieldId: 'f1', fieldName: 'F', type: 'note', severity: 'medium', coordinates: [34, 135], sourceType: 'manual_map_click' })).rejects.toThrow(/malformed/)
    expect(storage.getItem(KEY)).toBe(before)

    storage.setItem(KEY, JSON.stringify({ ...store(), fieldObservations: 'not-an-array' }))
    repository.refresh()
    const malformedCollection = storage.getItem(KEY)
    expect(repository.getSnapshot().error).toMatch(/fieldObservations is malformed/)
    await expect(repository.create({ fieldId: 'f1', fieldName: 'F', type: 'note', severity: 'medium', coordinates: [34, 135], sourceType: 'manual_map_click' })).rejects.toThrow(/fieldObservations data is malformed/)
    expect(storage.getItem(KEY)).toBe(malformedCollection)
  })
})
