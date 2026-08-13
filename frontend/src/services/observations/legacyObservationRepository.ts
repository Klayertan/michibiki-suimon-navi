import {
  LOCAL_STORAGE_KEY,
  SCHEMA_VERSION,
  buildFieldObservation,
  emptyPersistedStore,
  nextObservationName,
  normalizeObservationType,
  normalizePersistedStore,
  normalizeSeverity,
} from '@legacy/fields/field-annotation-core.js'
import { makeId } from '@legacy/gnss/gnss-store.js'
import type { CreateObservationInput, FieldObservation, ObservationSnapshot, ObservationType } from '../../domain/observations/types'

interface PersistedStore {
  schemaVersion: number
  fields: unknown[]
  boundaryTracks: unknown[]
  waterControlPoints: unknown[]
  surveySessions: unknown[]
  fieldObservations: unknown[]
  workflowState: Record<string, unknown>
}

export interface ObservationRepository {
  list(): Promise<FieldObservation[]>
  get(id: string): Promise<FieldObservation | null>
  create(input: CreateObservationInput): Promise<FieldObservation>
}

function adaptObservation(value: unknown): FieldObservation | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const coordinates = raw.coordinates
  const properties = raw.properties
  if (typeof raw.id !== 'string' || !Array.isArray(coordinates) || coordinates.length < 2 ||
      !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1]) ||
      !properties || typeof properties !== 'object' || Array.isArray(properties)) return null
  const props = properties as Record<string, unknown>
  const type = normalizeObservationType(raw.type) as ObservationType
  return {
    id: raw.id,
    fieldId: typeof raw.fieldId === 'string' && raw.fieldId ? raw.fieldId : null,
    type,
    label: typeof raw.label === 'string' ? raw.label : type,
    name: typeof raw.name === 'string' ? raw.name : '',
    geometryType: 'Point',
    coordinates: [Number(coordinates[0]), Number(coordinates[1])],
    properties: {
      severity: normalizeSeverity(props.severity),
      memo: typeof props.memo === 'string' ? props.memo : '',
      sourceType: typeof props.sourceType === 'string' ? props.sourceType : 'manual_map_click',
      createdAt: typeof props.createdAt === 'string' ? props.createdAt : '',
      updatedAt: typeof props.updatedAt === 'string' ? props.updatedAt : (typeof props.createdAt === 'string' ? props.createdAt : ''),
    },
  } as FieldObservation
}

export class LegacyObservationRepository implements ObservationRepository {
  private readonly listeners = new Set<() => void>()
  private cache: ObservationSnapshot | null = null
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

  getSnapshot = (): ObservationSnapshot => {
    this.cache ??= this.readSnapshot()
    return this.cache
  }

  async list(): Promise<FieldObservation[]> { return this.readSnapshot().observations }
  async get(id: string): Promise<FieldObservation | null> { return (await this.list()).find((item) => item.id === id) ?? null }

  async create(input: CreateObservationInput): Promise<FieldObservation> {
    const store = this.readStoreForWrite()
    const count = store.fieldObservations
      .map(adaptObservation)
      .filter((item): item is FieldObservation => item !== null && item.fieldId === input.fieldId && item.type === input.type).length
    const observation = buildFieldObservation({
      id: makeId('obs'), fieldId: input.fieldId, type: input.type,
      name: nextObservationName(input.fieldName, input.type, count),
      severity: input.severity, memo: input.memo ?? '',
      lat: input.coordinates[0], lon: input.coordinates[1], sourceType: input.sourceType,
    } as unknown as Parameters<typeof buildFieldObservation>[0]) as FieldObservation
    store.fieldObservations = [...store.fieldObservations, observation]
    this.writeStore(store)
    return observation
  }

  refresh(): void { this.invalidate() }

  private readSnapshot(): ObservationSnapshot {
    let raw: string | null
    try { raw = this.storage.getItem(LOCAL_STORAGE_KEY) } catch {
      return { observations: [], warnings: [], error: 'Saved observation data could not be read. The stored value was left unchanged.' }
    }
    if (!raw) return { observations: [], warnings: [], error: null }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch {
      return { observations: [], warnings: [], error: 'Saved observation data is malformed. The stored value was left unchanged.' }
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION) {
      return { observations: [], warnings: [], error: `Saved observation data does not use supported schema version ${SCHEMA_VERSION}.` }
    }
    if (!Array.isArray((parsed as { fieldObservations?: unknown }).fieldObservations)) {
      return { observations: [], warnings: [], error: 'Saved fieldObservations is malformed. The stored value was left unchanged.' }
    }
    const source = (parsed as { fieldObservations: unknown[] }).fieldObservations
    const observations = source.map(adaptObservation).filter((item): item is FieldObservation => item !== null)
    const skipped = source.length - observations.length
    return { observations, warnings: skipped ? [`${skipped} malformed observation(s) were ignored.`] : [], error: null }
  }

  private readStoreForWrite(): PersistedStore {
    let raw: string | null
    try { raw = this.storage.getItem(LOCAL_STORAGE_KEY) } catch (error) {
      throw new Error(`Existing observation data could not be read, so nothing was saved. ${String(error)}`)
    }
    if (!raw) return emptyPersistedStore() as PersistedStore
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch {
      throw new Error('Existing observation data is malformed, so nothing was saved.')
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`Existing observation data does not use supported schema version ${SCHEMA_VERSION}, so nothing was saved.`)
    }
    const candidate = parsed as Record<string, unknown>
    for (const key of ['fields', 'boundaryTracks', 'waterControlPoints', 'surveySessions', 'fieldObservations']) {
      if (!Array.isArray(candidate[key])) throw new Error(`Existing ${key} data is malformed, so nothing was saved.`)
    }
    return normalizePersistedStore(parsed) as PersistedStore
  }

  private writeStore(store: PersistedStore): void {
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

export const observationRepository = new LegacyObservationRepository()
