import {
  LOCAL_STORAGE_KEY,
  SCHEMA_VERSION,
  buildWaterControlPoint,
  emptyPersistedStore,
  nextWaterControlName,
  normalizePersistedStore,
  normalizeWaterControlType,
  waterControlInternalType,
} from '@legacy/fields/field-annotation-core.js'
import { makeId } from '@legacy/gnss/gnss-store.js'
import type {
  CreateWaterControlPointInput,
  PersistedWaterControlType,
  WaterControlPoint,
  WaterControlSnapshot,
  WaterControlType,
} from '../../domain/water/types'

/**
 * Adapter over the existing water-control-point half of the annotation store.
 * Mirrors services/observations/legacyObservationRepository.ts deliberately --
 * same fail-closed rules, same snapshot-carried error, same explicit seven-key
 * write -- because both write the *same* localStorage document and must not
 * diverge in how they treat it.
 *
 * Deliberately list/get/create only. There is no update() and no delete():
 *  - Legacy water-point deletion is a bare identity filter with no cascade
 *    (js/fields/field-annotation-controller.js:1147-1152), but reports and the
 *    decision tab read the array live, and Stage 2 already established that
 *    destructive operations stay disabled until a cross-store reference policy
 *    exists. Stage 3C's observation repository is list/get/create for the same
 *    reason.
 *  - Legacy editing can rename a point's `id`, which is a foreign key nowhere
 *    but is checked for uniqueness across four collections; that is not worth
 *    reproducing for a foundation stage.
 */

interface PersistedStore {
  schemaVersion: number
  fields: unknown[]
  boundaryTracks: unknown[]
  waterControlPoints: unknown[]
  surveySessions: unknown[]
  fieldObservations: unknown[]
  workflowState: Record<string, unknown>
}

export interface WaterControlRepository {
  list(): Promise<WaterControlPoint[]>
  get(id: string): Promise<WaterControlPoint | null>
  create(input: CreateWaterControlPointInput): Promise<WaterControlPoint>
}

/**
 * Pure read adapter. Returns null for a record that cannot be trusted, so the
 * caller can count it as a warning instead of rendering a point at NaN/NaN --
 * the legacy builder applies `Number()` with no finiteness guard, so a
 * malformed coordinate really can reach storage as null.
 */
export function adaptWaterControlPoint(value: unknown): WaterControlPoint | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const coordinates = raw.coordinates
  const properties = raw.properties
  if (
    typeof raw.id !== 'string' || !raw.id ||
    !Array.isArray(coordinates) || coordinates.length < 2 ||
    !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1]) ||
    !properties || typeof properties !== 'object' || Array.isArray(properties)
  ) return null
  const props = properties as Record<string, unknown>
  // Normalizing through the legacy helper keeps the unknown-type fallback
  // ("gate") identical to what the legacy controller shows for the same bytes.
  const internalType = normalizeWaterControlType(raw.type) as WaterControlType
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    type: persistedTypeFor(internalType),
    relatedFieldId: typeof raw.relatedFieldId === 'string' && raw.relatedFieldId ? raw.relatedFieldId : null,
    geometryType: 'Point',
    coordinates: [Number(coordinates[0]), Number(coordinates[1])],
    properties: {
      memo: typeof props.memo === 'string' ? props.memo : '',
      sourceType: typeof props.sourceType === 'string' ? props.sourceType : 'manual_map_click',
      createdAt: typeof props.createdAt === 'string' ? props.createdAt : '',
      updatedAt: typeof props.updatedAt === 'string'
        ? props.updatedAt
        : (typeof props.createdAt === 'string' ? props.createdAt : ''),
    },
  }
}

/** Round-trips the short key back through the legacy builder to get the long persisted string. */
function persistedTypeFor(internalType: WaterControlType): PersistedWaterControlType {
  const probe = buildWaterControlPoint({ id: 'probe', type: internalType, lat: 0, lon: 0 }) as { type: string }
  return probe.type as PersistedWaterControlType
}

export class LegacyWaterControlRepository implements WaterControlRepository {
  private readonly listeners = new Set<() => void>()
  private cache: WaterControlSnapshot | null = null
  private readonly storage: Storage

  constructor(storage: Storage = window.localStorage) {
    this.storage = storage
    window.addEventListener('storage', (event) => {
      if (event.storageArea === storage && (event.key === LOCAL_STORAGE_KEY || event.key === null)) this.invalidate()
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): WaterControlSnapshot => {
    this.cache ??= this.readSnapshot()
    return this.cache
  }

  async list(): Promise<WaterControlPoint[]> { return this.readSnapshot().points }

  async get(id: string): Promise<WaterControlPoint | null> {
    return (await this.list()).find((point) => point.id === id) ?? null
  }

  async create(input: CreateWaterControlPointInput): Promise<WaterControlPoint> {
    const store = this.readStoreForWrite()
    // Legacy numbers a new point per (field, type) pair, counting the *internal*
    // type of existing records -- js/fields/field-annotation-controller.js:837-839.
    const existingCount = store.waterControlPoints
      .map(adaptWaterControlPoint)
      .filter((point): point is WaterControlPoint =>
        point !== null &&
        point.relatedFieldId === input.fieldId &&
        waterControlInternalType(point) === input.type).length
    const point = buildWaterControlPoint({
      id: makeId('wcp'),
      name: nextWaterControlName(input.fieldName, input.type, existingCount),
      type: input.type,
      lat: input.coordinates[0],
      lon: input.coordinates[1],
      relatedFieldId: input.fieldId,
      memo: input.memo ?? '',
      sourceType: input.sourceType,
    } as unknown as Parameters<typeof buildWaterControlPoint>[0]) as WaterControlPoint
    store.waterControlPoints = [...store.waterControlPoints, point]
    this.writeStore(store)
    return point
  }

  refresh(): void { this.invalidate() }

  private readSnapshot(): WaterControlSnapshot {
    let raw: string | null
    try { raw = this.storage.getItem(LOCAL_STORAGE_KEY) } catch {
      return { points: [], warnings: [], error: 'Saved water-point data could not be read. The stored value was left unchanged.' }
    }
    if (!raw) return { points: [], warnings: [], error: null }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch {
      return { points: [], warnings: [], error: 'Saved water-point data is malformed. The stored value was left unchanged.' }
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION) {
      return { points: [], warnings: [], error: `Saved water-point data does not use supported schema version ${SCHEMA_VERSION}.` }
    }
    if (!Array.isArray((parsed as { waterControlPoints?: unknown }).waterControlPoints)) {
      return { points: [], warnings: [], error: 'Saved waterControlPoints is malformed. The stored value was left unchanged.' }
    }
    const source = (parsed as { waterControlPoints: unknown[] }).waterControlPoints
    const points = source.map(adaptWaterControlPoint).filter((point): point is WaterControlPoint => point !== null)
    const skipped = source.length - points.length
    return { points, warnings: skipped ? [`${skipped} malformed water point(s) were ignored.`] : [], error: null }
  }

  private readStoreForWrite(): PersistedStore {
    let raw: string | null
    try { raw = this.storage.getItem(LOCAL_STORAGE_KEY) } catch (error) {
      throw new Error(`Existing water-point data could not be read, so nothing was saved. ${String(error)}`)
    }
    if (!raw) return emptyPersistedStore() as PersistedStore
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch {
      throw new Error('Existing water-point data is malformed, so nothing was saved.')
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`Existing water-point data does not use supported schema version ${SCHEMA_VERSION}, so nothing was saved.`)
    }
    const candidate = parsed as Record<string, unknown>
    for (const key of ['fields', 'boundaryTracks', 'waterControlPoints', 'surveySessions', 'fieldObservations']) {
      if (!Array.isArray(candidate[key])) throw new Error(`Existing ${key} data is malformed, so nothing was saved.`)
    }
    return normalizePersistedStore(parsed) as PersistedStore
  }

  private writeStore(store: PersistedStore): void {
    // Explicit literal, never a spread: the legacy document has exactly these
    // seven root keys, and sibling datasets must round-trip untouched.
    this.storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      fields: store.fields,
      boundaryTracks: store.boundaryTracks,
      waterControlPoints: store.waterControlPoints,
      surveySessions: store.surveySessions,
      fieldObservations: store.fieldObservations,
      workflowState: store.workflowState,
    }))
    this.invalidate()
  }

  private invalidate(): void {
    this.cache = null
    this.listeners.forEach((listener) => listener())
  }
}

export const waterControlRepository = new LegacyWaterControlRepository()
