import { describe, expect, it } from 'vitest'
import { createLegacyFieldRepository } from '../legacyFieldRepository'
import { FieldNotFoundError, FieldSaveError, FieldValidationError } from '../fieldRepositoryErrors'
import type { Field } from '../../../domain/fields/types'

// A real localStorage-shaped fake, not a mock of the class under test --
// exercises the actual JSON.stringify/parse round trip the browser would do.
class FakeStorage implements Storage {
  private data = new Map<string, string>()
  get length() {
    return this.data.size
  }
  clear() {
    this.data.clear()
  }
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  setItem(key: string, value: string) {
    this.data.set(key, value)
  }
}

const LOCAL_STORAGE_KEY = 'suimonNaviFieldAnnotationsV2'
const SQUARE = [
  [35.0, 135.0],
  [35.0, 135.001],
  [35.001, 135.001],
  [35.001, 135.0],
] as [number, number][]

const LEGACY_FIELD: Field = {
  id: 'paddy-007',
  name: 'Legacy north field',
  type: 'field',
  geometryType: 'Polygon',
  coordinates: [
    [35.1234, 135.5678],
    [35.1234, 135.5681],
    [35.1237, 135.5681],
  ],
  sourceSessionId: 'survey-20260801-120000',
  properties: {
    memo: 'saved by the legacy annotation workflow',
    sourceType: 'QZ1_NMEA',
    sourceFileName: 'north-field.nmea',
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    areaM2: 456.75,
    closureGapM: 2.4,
    closedManually: false,
    sourcePointCount: 3,
    fixQualitySummary: { total: 3, byFixQuality: { '2': 3 }, augmentedCount: 3 },
  },
}

describe('LegacyFieldRepository', () => {
  it('reads no fields from an empty store, and get() returns null for an unknown id', async () => {
    const repo = createLegacyFieldRepository(new FakeStorage())
    expect(await repo.list()).toEqual([])
    expect(await repo.get('nope')).toBeNull()
  })

  it('reads a representative legacy v3 field unchanged without rewriting bytes or swapping [lat, lon]', async () => {
    const storage = new FakeStorage()
    storage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 3,
        fields: [LEGACY_FIELD],
        boundaryTracks: [],
        waterControlPoints: [],
        surveySessions: [],
        fieldObservations: [],
        workflowState: { lastExportedAt: null },
      }),
    )
    const before = storage.getItem(LOCAL_STORAGE_KEY)
    const repo = createLegacyFieldRepository(storage)

    expect(await repo.list()).toEqual([LEGACY_FIELD])
    expect(await repo.get(LEGACY_FIELD.id)).toEqual(LEGACY_FIELD)
    expect((await repo.get(LEGACY_FIELD.id))?.coordinates[0]).toEqual([35.1234, 135.5678])
    expect(storage.getItem(LOCAL_STORAGE_KEY)).toBe(before)
  })

  it('create() persists under the exact legacy localStorage key/shape, computes area via the legacy formula, and returns the new field', async () => {
    const storage = new FakeStorage()
    const repo = createLegacyFieldRepository(storage)

    const field = await repo.create({ name: '北田', coordinates: SQUARE, memo: 'test field' })

    expect(field.name).toBe('北田')
    expect(field.type).toBe('field')
    expect(field.geometryType).toBe('Polygon')
    expect(field.properties.sourceType).toBe('react_manual_draw')
    expect(field.properties.memo).toBe('test field')
    // ~111m square -> ~12,344 m^2 via the local-planar fallback (no Turf in
    // this test environment) -- same formula js/fields/field-annotation-core.js's
    // own unit test exercises for a similarly-sized square.
    expect(field.properties.areaM2).toBeGreaterThan(10000)
    expect(field.properties.areaM2).toBeLessThan(15000)

    const raw = JSON.parse(storage.getItem(LOCAL_STORAGE_KEY)!)
    expect(raw.schemaVersion).toBe(3)
    expect(Object.keys(raw).sort()).toEqual(
      ['boundaryTracks', 'fieldObservations', 'fields', 'schemaVersion', 'surveySessions', 'waterControlPoints', 'workflowState'].sort(),
    )
    expect(raw.fields).toHaveLength(1)
    expect(raw.fields[0].id).toBe(field.id)
  })

  it('create() rejects fewer than 3 points without writing anything', async () => {
    const storage = new FakeStorage()
    const repo = createLegacyFieldRepository(storage)

    await expect(repo.create({ name: 'too small', coordinates: [[35, 135], [35, 135.001]] })).rejects.toBeInstanceOf(
      FieldValidationError,
    )
    expect(storage.getItem(LOCAL_STORAGE_KEY)).toBeNull()
  })

  it('create() preserves the legacy non-fatal self-intersection behavior', async () => {
    const repo = createLegacyFieldRepository(new FakeStorage())
    const bowTie: [number, number][] = [
      [35, 135],
      [35.001, 135.001],
      [35, 135.001],
      [35.001, 135],
    ]

    await expect(repo.create({ name: 'legacy-compatible bow tie', coordinates: bowTie })).resolves.toMatchObject({
      coordinates: bowTie,
    })
  })

  it('create() does not discard boundaryTracks/waterControlPoints/surveySessions/fieldObservations/workflowState already in the store', async () => {
    const storage = new FakeStorage()
    storage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 3,
        fields: [],
        boundaryTracks: [{ id: 'track-1', fieldId: null }],
        waterControlPoints: [{ id: 'wcp-1', relatedFieldId: null }],
        surveySessions: [{ id: 'session-1', fieldId: null }],
        fieldObservations: [{ id: 'obs-1', fieldId: null }],
        workflowState: { lastExportedAt: '2026-01-01T00:00:00.000Z' },
      }),
    )
    const repo = createLegacyFieldRepository(storage)

    await repo.create({ name: 'new field', coordinates: SQUARE })

    const raw = JSON.parse(storage.getItem(LOCAL_STORAGE_KEY)!)
    expect(raw.boundaryTracks).toEqual([{ id: 'track-1', fieldId: null }])
    expect(raw.waterControlPoints).toEqual([{ id: 'wcp-1', relatedFieldId: null }])
    expect(raw.surveySessions).toEqual([{ id: 'session-1', fieldId: null }])
    expect(raw.fieldObservations).toEqual([{ id: 'obs-1', fieldId: null }])
    expect(raw.workflowState).toEqual({ lastExportedAt: '2026-01-01T00:00:00.000Z' })
  })

  it('creates a survey-sourced field and links only the existing source records in the same legacy payload', async () => {
    const storage = new FakeStorage()
    storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
      schemaVersion: 3, fields: [], waterControlPoints: [], fieldObservations: [], workflowState: { lastExportedAt: null },
      surveySessions: [{ id: 'session-1', fieldId: null, rawPoints: [{ lat: 35, lon: 135 }] }],
      boundaryTracks: [{ id: 'track-1', sourceSessionId: 'session-1', fieldId: null, coordinates: SQUARE }],
    }))
    const repo = createLegacyFieldRepository(storage)
    const field = await repo.create({ name: 'Survey field', coordinates: SQUARE, sourceSessionId: 'session-1', sourceTrackId: 'track-1', sourceType: 'QZ1_NMEA', sourcePointCount: 4 })
    const raw = JSON.parse(storage.getItem(LOCAL_STORAGE_KEY)!)
    expect(field.sourceSessionId).toBe('session-1')
    expect(field.coordinates).toEqual(SQUARE)
    expect(raw.surveySessions[0]).toEqual({ id: 'session-1', fieldId: field.id, rawPoints: [{ lat: 35, lon: 135 }] })
    expect(raw.boundaryTracks[0].fieldId).toBe(field.id)
  })

  it('update() patches only name/memo and bumps updatedAt, leaving every other property untouched', async () => {
    const repo = createLegacyFieldRepository(new FakeStorage())
    const created = await repo.create({ name: 'original', coordinates: SQUARE, memo: 'old memo' })

    const updated = await repo.update(created.id, { name: 'renamed', memo: 'new memo' })

    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('renamed')
    expect(updated.properties.memo).toBe('new memo')
    expect(updated.properties.areaM2).toBe(created.properties.areaM2)
    expect(updated.coordinates).toEqual(created.coordinates)
    expect(new Date(updated.properties.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.properties.updatedAt).getTime(),
    )
  })

  it('update() throws FieldNotFoundError for an unknown id', async () => {
    const repo = createLegacyFieldRepository(new FakeStorage())
    await expect(repo.update('missing', { name: 'x' })).rejects.toBeInstanceOf(FieldNotFoundError)
  })

  it('corrupted localStorage degrades to an empty list rather than throwing, matching hydrateFromStorage()', async () => {
    const storage = new FakeStorage()
    storage.setItem(LOCAL_STORAGE_KEY, '{not json')
    const repo = createLegacyFieldRepository(storage)
    expect(await repo.list()).toEqual([])
    expect(repo.getSnapshot()).toEqual([])
    expect(repo.getReadErrorSnapshot()).toMatch(/could not be read/i)
  })

  it('never overwrites malformed existing bytes during a mutation', async () => {
    const storage = new FakeStorage()
    storage.setItem(LOCAL_STORAGE_KEY, '{not json')
    const before = storage.getItem(LOCAL_STORAGE_KEY)
    const repo = createLegacyFieldRepository(storage)

    await expect(repo.create({ name: 'must not overwrite', coordinates: SQUARE })).rejects.toBeInstanceOf(FieldSaveError)
    expect(storage.getItem(LOCAL_STORAGE_KEY)).toBe(before)
  })

  it('never down-stamps an unsupported persisted schema during a mutation', async () => {
    const storage = new FakeStorage()
    storage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 99,
        fields: [LEGACY_FIELD],
        boundaryTracks: [],
        waterControlPoints: [],
        surveySessions: [],
        fieldObservations: [],
        workflowState: { lastExportedAt: null },
      }),
    )
    const before = storage.getItem(LOCAL_STORAGE_KEY)
    const repo = createLegacyFieldRepository(storage)

    await expect(repo.update(LEGACY_FIELD.id, { name: 'must not migrate' })).rejects.toBeInstanceOf(FieldSaveError)
    expect(storage.getItem(LOCAL_STORAGE_KEY)).toBe(before)
  })

  it('a quota-exceeded write throws FieldSaveError and leaves the prior data untouched', async () => {
    const storage = new FakeStorage()
    const repo = createLegacyFieldRepository(storage)
    await repo.create({ name: 'first', coordinates: SQUARE })
    const before = storage.getItem(LOCAL_STORAGE_KEY)

    storage.setItem = () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    }

    await expect(repo.create({ name: 'second', coordinates: SQUARE })).rejects.toBeInstanceOf(FieldSaveError)
    expect(storage.getItem(LOCAL_STORAGE_KEY)).toBe(before)
  })

  it('subscribe()/getSnapshot() notify on create/update, for useSyncExternalStore', async () => {
    const repo = createLegacyFieldRepository(new FakeStorage())
    let notifications = 0
    const unsubscribe = repo.subscribe(() => {
      notifications += 1
    })

    expect(repo.getSnapshot()).toEqual([])
    const field = await repo.create({ name: 'a', coordinates: SQUARE })
    expect(notifications).toBe(1)
    expect(repo.getSnapshot()).toHaveLength(1)

    await repo.update(field.id, { name: 'b' })
    expect(notifications).toBe(2)

    unsubscribe()
    await repo.update(field.id, { name: 'after unsubscribe' })
    expect(notifications).toBe(2)
  })
})
