import { describe, expect, it } from 'vitest'
import { buildWaterControlPoint } from '@legacy/fields/field-annotation-core.js'
import { LegacyWaterControlRepository } from '../legacyWaterControlRepository'
import type { CreateWaterControlPointInput } from '../../../domain/water/types'

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
const ROOT_KEYS = [
  'schemaVersion', 'fields', 'boundaryTracks', 'waterControlPoints',
  'surveySessions', 'fieldObservations', 'workflowState',
]

const store = (waterControlPoints: unknown[] = []) => ({
  schemaVersion: 3,
  fields: [{ id: 'f1', name: 'North' }],
  boundaryTracks: [{ id: 'track-1', fieldId: 'f1' }],
  waterControlPoints,
  surveySessions: [{ id: 'session-1', fieldId: 'f1' }],
  fieldObservations: [{ id: 'obs-1', fieldId: 'f1' }],
  workflowState: { lastExportedAt: '2026-01-01T00:00:00.000Z' },
})

/** A byte-accurate legacy record, exactly as buildWaterControlPoint() emits it. */
const LEGACY_GATE = {
  id: 'wcp-1',
  name: '北田 水門1',
  type: 'water_gate',
  relatedFieldId: 'f1',
  geometryType: 'Point',
  coordinates: [34.6548, 135.83],
  properties: {
    memo: 'main intake',
    sourceType: 'manual_map_click',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  },
}

describe('LegacyWaterControlRepository', () => {
  it('reads a representative legacy record unchanged, keeping [lat, lon] order and the long type string', async () => {
    const storage = new FakeStorage()
    storage.setItem(KEY, JSON.stringify(store([LEGACY_GATE])))
    const before = storage.getItem(KEY)
    const repository = new LegacyWaterControlRepository(storage)

    expect(await repository.list()).toEqual([LEGACY_GATE])
    const point = await repository.get('wcp-1')
    // Coordinate order is the compatibility contract: [lat, lon], never GeoJSON.
    expect(point?.coordinates).toEqual([34.6548, 135.83])
    expect(point?.coordinates[0]).toBe(34.6548)
    expect(point?.type).toBe('water_gate')
    // The field link is relatedFieldId, not fieldId, unlike every sibling collection.
    expect(point?.relatedFieldId).toBe('f1')
    expect((point as unknown as { fieldId?: unknown }).fieldId).toBeUndefined()
    // A read must never rewrite the stored bytes.
    expect(storage.getItem(KEY)).toBe(before)
  })

  it('reads every legacy type, and normalizes an unknown type to gate exactly like the legacy helper', async () => {
    const storage = new FakeStorage()
    const types = ['water_gate', 'water_inlet', 'water_outlet', 'water_level_sensor', 'photo_point']
    storage.setItem(KEY, JSON.stringify(store(
      types.map((type, index) => ({ ...LEGACY_GATE, id: `wcp-${index}`, type })),
    )))
    const repository = new LegacyWaterControlRepository(storage)
    expect((await repository.list()).map((point) => point.type)).toEqual(types)

    storage.setItem(KEY, JSON.stringify(store([{ ...LEGACY_GATE, type: 'bogus' }])))
    repository.refresh()
    expect((await repository.list())[0].type).toBe('water_gate')
  })

  it('creates a record byte-identical to the legacy builder and preserves every sibling dataset', async () => {
    const storage = new FakeStorage()
    storage.setItem(KEY, JSON.stringify(store()))
    const repository = new LegacyWaterControlRepository(storage)

    const created = await repository.create({
      type: 'inlet',
      fieldId: 'f1',
      fieldName: '北田',
      coordinates: [34.651, 135.832],
      sourceType: 'qz1_current_position',
      memo: 'edge',
    })

    expect(created).toMatchObject({
      type: 'water_inlet',
      relatedFieldId: 'f1',
      geometryType: 'Point',
      coordinates: [34.651, 135.832],
      properties: { memo: 'edge', sourceType: 'qz1_current_position' },
    })
    // Legacy names a new point "<field> <label><n>" -- no 地点 word for water.
    expect(created.name).toBe('北田 給水口1')

    const raw = JSON.parse(storage.getItem(KEY)!)
    expect(raw.schemaVersion).toBe(3)
    expect(Object.keys(raw).sort()).toEqual([...ROOT_KEYS].sort())
    expect(raw.fields).toEqual([{ id: 'f1', name: 'North' }])
    expect(raw.boundaryTracks).toEqual([{ id: 'track-1', fieldId: 'f1' }])
    expect(raw.surveySessions).toEqual([{ id: 'session-1', fieldId: 'f1' }])
    expect(raw.fieldObservations).toEqual([{ id: 'obs-1', fieldId: 'f1' }])
    expect(raw.workflowState).toEqual({ lastExportedAt: '2026-01-01T00:00:00.000Z' })

    // Feeding the persisted record back through the unchanged legacy builder
    // must reproduce it exactly -- that is what makes it legacy-readable.
    const persisted = raw.waterControlPoints[0]
    const legacyRehydrated = buildWaterControlPoint({
      id: persisted.id,
      name: persisted.name,
      type: persisted.type,
      lat: persisted.coordinates[0],
      lon: persisted.coordinates[1],
      relatedFieldId: persisted.relatedFieldId,
      memo: persisted.properties.memo,
      sourceType: persisted.properties.sourceType,
      nowIso: persisted.properties.createdAt,
    } as never)
    expect(legacyRehydrated).toEqual(persisted)
    expect(Object.keys(persisted)).toEqual(['id', 'name', 'type', 'relatedFieldId', 'geometryType', 'coordinates', 'properties'])
    expect(Object.keys(persisted.properties)).toEqual(['memo', 'sourceType', 'createdAt', 'updatedAt'])
    // Water points carry no `label` key, unlike field observations.
    expect(persisted.label).toBeUndefined()
  })

  it('numbers each new point per field and per type, counting existing records like legacy does', async () => {
    const storage = new FakeStorage()
    storage.setItem(KEY, JSON.stringify(store([
      { ...LEGACY_GATE, id: 'wcp-a', type: 'water_gate', relatedFieldId: 'f1' },
      { ...LEGACY_GATE, id: 'wcp-b', type: 'water_gate', relatedFieldId: 'other' },
      { ...LEGACY_GATE, id: 'wcp-c', type: 'water_inlet', relatedFieldId: 'f1' },
    ])))
    const repository = new LegacyWaterControlRepository(storage)
    const created = await repository.create({
      type: 'gate', fieldId: 'f1', fieldName: '北田',
      coordinates: [34.6, 135.8], sourceType: 'manual_map_click',
    })
    // One existing gate on f1 -> the next is 2. Other fields/types do not count.
    expect(created.name).toBe('北田 水門2')
  })

  it('keeps an orphaned point (relatedFieldId null) readable rather than dropping it', async () => {
    const storage = new FakeStorage()
    storage.setItem(KEY, JSON.stringify(store([{ ...LEGACY_GATE, relatedFieldId: null }])))
    const repository = new LegacyWaterControlRepository(storage)
    const points = await repository.list()
    expect(points).toHaveLength(1)
    expect(points[0].relatedFieldId).toBeNull()
  })

  it('skips malformed records with a warning instead of rendering them at NaN', async () => {
    const storage = new FakeStorage()
    storage.setItem(KEY, JSON.stringify(store([
      LEGACY_GATE,
      { id: 'bad-coords', coordinates: ['x', 2], properties: {} },
      { id: 'null-coords', coordinates: [null, null], properties: {} },
      { coordinates: [1, 2], properties: {} },
      'not-an-object',
    ])))
    const repository = new LegacyWaterControlRepository(storage)
    const snapshot = repository.getSnapshot()
    expect(snapshot.points).toHaveLength(1)
    expect(snapshot.warnings).toEqual(['4 malformed water point(s) were ignored.'])
    expect(snapshot.error).toBeNull()
  })

  it('fails closed on unreadable, malformed, unsupported-version and malformed-collection stores, never overwriting them', async () => {
    const storage = new FakeStorage()
    const input: CreateWaterControlPointInput = {
      type: 'gate', fieldId: 'f1', fieldName: 'F',
      coordinates: [34, 135], sourceType: 'manual_map_click',
    }

    storage.setItem(KEY, '{broken')
    const repository = new LegacyWaterControlRepository(storage)
    expect(repository.getSnapshot().error).toMatch(/malformed/)
    let before = storage.getItem(KEY)
    await expect(repository.create(input)).rejects.toThrow(/malformed/)
    expect(storage.getItem(KEY)).toBe(before)

    storage.setItem(KEY, JSON.stringify({ ...store(), schemaVersion: 99 }))
    repository.refresh()
    expect(repository.getSnapshot().error).toMatch(/schema version 3/)
    before = storage.getItem(KEY)
    await expect(repository.create(input)).rejects.toThrow(/schema version 3/)
    expect(storage.getItem(KEY)).toBe(before)

    storage.setItem(KEY, JSON.stringify({ ...store(), waterControlPoints: 'not-an-array' }))
    repository.refresh()
    expect(repository.getSnapshot().error).toMatch(/waterControlPoints is malformed/)
    before = storage.getItem(KEY)
    await expect(repository.create(input)).rejects.toThrow(/waterControlPoints data is malformed/)
    expect(storage.getItem(KEY)).toBe(before)

    // A sibling collection being malformed must also block the write, because
    // writing would persist a normalized (i.e. silently repaired) version of it.
    storage.setItem(KEY, JSON.stringify({ ...store(), fieldObservations: 'not-an-array' }))
    repository.refresh()
    before = storage.getItem(KEY)
    await expect(repository.create(input)).rejects.toThrow(/fieldObservations data is malformed/)
    expect(storage.getItem(KEY)).toBe(before)
  })

  it('treats an absent store as empty rather than an error, and can create into it', async () => {
    const storage = new FakeStorage()
    const repository = new LegacyWaterControlRepository(storage)
    expect(repository.getSnapshot()).toEqual({ points: [], warnings: [], error: null })

    await repository.create({
      type: 'outlet', fieldId: 'f1', fieldName: 'F',
      coordinates: [34, 135], sourceType: 'manual_map_click',
    })
    const raw = JSON.parse(storage.getItem(KEY)!)
    expect(Object.keys(raw).sort()).toEqual([...ROOT_KEYS].sort())
    expect(raw.waterControlPoints).toHaveLength(1)
  })

  it('exposes no update or delete surface while cross-store reference semantics are unproven', () => {
    const repository = new LegacyWaterControlRepository(new FakeStorage())
    expect((repository as unknown as { update?: unknown }).update).toBeUndefined()
    expect((repository as unknown as { delete?: unknown }).delete).toBeUndefined()
  })

  it('notifies subscribers on create so the map and lists refresh without a reload', async () => {
    const storage = new FakeStorage()
    storage.setItem(KEY, JSON.stringify(store()))
    const repository = new LegacyWaterControlRepository(storage)
    let notifications = 0
    const unsubscribe = repository.subscribe(() => { notifications += 1 })

    expect(repository.getSnapshot().points).toHaveLength(0)
    await repository.create({
      type: 'gate', fieldId: 'f1', fieldName: 'F',
      coordinates: [34, 135], sourceType: 'manual_map_click',
    })
    expect(notifications).toBe(1)
    expect(repository.getSnapshot().points).toHaveLength(1)
    unsubscribe()
  })
})
