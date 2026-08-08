import { LOCAL_STORAGE_KEY, SCHEMA_VERSION } from '@legacy/fields/field-annotation-core.js'
import { adaptSurveySession, adaptSurveyTrack, joinSurveyRecords } from '../../domain/surveys/adapters'
import type { SurveyRecord, SurveyRepositorySnapshot } from '../../domain/surveys/types'

interface PersistedSurveyStore {
  schemaVersion: number
  surveySessions: unknown[]
  boundaryTracks: unknown[]
}

export interface SurveyRepository {
  list(): Promise<SurveyRecord[]>
  get(id: string): Promise<SurveyRecord | null>
}

const EMPTY_SNAPSHOT: SurveyRepositorySnapshot = { surveys: [], warnings: [], error: null, loading: false }

/** Read-only adapter for the annotation store's schema-v3 survey datasets. */
export class LegacySurveyRepository implements SurveyRepository {
  private readonly storage: Storage
  private readonly listeners = new Set<() => void>()
  private cache: SurveyRepositorySnapshot | null = null

  constructor(storage: Storage = window.localStorage) {
    this.storage = storage
    window.addEventListener('storage', this.handleStorage)
  }

  private handleStorage = (event: StorageEvent): void => {
    if (event.storageArea === this.storage && (event.key === LOCAL_STORAGE_KEY || event.key === null)) this.invalidate()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SurveyRepositorySnapshot => {
    this.cache ??= this.readSnapshot()
    return this.cache
  }

  async list(): Promise<SurveyRecord[]> {
    return this.readSnapshot().surveys
  }

  async get(id: string): Promise<SurveyRecord | null> {
    return (await this.list()).find((survey) => survey.id === id) ?? null
  }

  /** Useful after a same-document legacy write, which cannot emit a storage event. */
  refresh(): void {
    this.invalidate()
  }

  private readSnapshot(): SurveyRepositorySnapshot {
    let raw: string | null
    try {
      raw = this.storage.getItem(LOCAL_STORAGE_KEY)
    } catch {
      return { ...EMPTY_SNAPSHOT, error: 'Saved survey data could not be read. The stored value was left unchanged.' }
    }
    if (!raw) return EMPTY_SNAPSHOT

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ...EMPTY_SNAPSHOT, error: 'Saved survey data is malformed. The stored value was left unchanged.' }
    }
    if (!parsed || typeof parsed !== 'object') {
      return { ...EMPTY_SNAPSHOT, error: 'Saved survey data has an unsupported shape. The stored value was left unchanged.' }
    }
    const store = parsed as Partial<PersistedSurveyStore>
    if (store.schemaVersion !== SCHEMA_VERSION) {
      return {
        ...EMPTY_SNAPSHOT,
        error: `Saved survey data uses schema version ${String(store.schemaVersion ?? 'missing')}; this frontend supports version ${SCHEMA_VERSION}.`,
      }
    }

    const warnings: string[] = []
    if (!Array.isArray(store.surveySessions)) warnings.push('The saved surveySessions collection is not an array and was ignored.')
    if (!Array.isArray(store.boundaryTracks)) warnings.push('The saved boundaryTracks collection is not an array and was ignored.')
    const sessions = (Array.isArray(store.surveySessions) ? store.surveySessions : [])
      .map((session) => adaptSurveySession(session, warnings))
      .filter((session): session is NonNullable<typeof session> => session !== null)
    const tracks = (Array.isArray(store.boundaryTracks) ? store.boundaryTracks : [])
      .map((track) => adaptSurveyTrack(track, warnings))
      .filter((track): track is NonNullable<typeof track> => track !== null)
    return { surveys: joinSurveyRecords(sessions, tracks), warnings, error: null, loading: false }
  }

  private invalidate(): void {
    this.cache = null
    this.listeners.forEach((listener) => listener())
  }
}

export function createLegacySurveyRepository(storage?: Storage): LegacySurveyRepository {
  return new LegacySurveyRepository(storage)
}

export const surveyRepository = createLegacySurveyRepository()
