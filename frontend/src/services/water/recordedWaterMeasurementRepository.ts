import { RecordingStore, STORE_MARKED_OBSERVATIONS } from '@legacy/recording/recording-store.js'
import type { WaterLevelMeasurement, WaterMeasurementSnapshot } from '../../domain/water/types'

/**
 * READ-ONLY view of the water-level readings that already exist in IndexedDB
 * `suimon-navi-recording`.`markedObservations`, i.e. marked observations whose
 * `observationType` is `water_level` (js/recording/recording-core.js:147, :218).
 *
 * Async/snapshot shape follows services/recording/recordedSurveyRepository.ts,
 * the existing precedent for reading that database from React.
 *
 * Stage 4A never writes here, by design:
 *  - a marked observation is a child of a recording session and is
 *    cascade-deleted with it (js/recording/recording-store.js:136-148), so
 *    creating one outside a session would produce an orphan legacy cannot make;
 *  - legacy only builds one from a validated, non-stale live fix, filling
 *    fixQuality/hdop/satellites/rawSourceSentence from it -- a map click has no
 *    such provenance to record, and inventing it is exactly what this migration
 *    forbids;
 *  - the reading carries no unit anywhere in the schema.
 */

const WATER_LEVEL_OBSERVATION_TYPE = 'water_level'

interface MarkedObservationReader {
  readAll(storeName: string): Promise<unknown[]>
}

export function adaptWaterLevelMeasurement(value: unknown): WaterLevelMeasurement | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.observationType !== WATER_LEVEL_OBSERVATION_TYPE) return null
  if (typeof raw.id !== 'string' || !raw.id) return null
  if (!Number.isFinite(raw.latitude) || !Number.isFinite(raw.longitude)) return null
  return {
    id: raw.id,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    latitude: Number(raw.latitude),
    longitude: Number(raw.longitude),
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : null,
    // Kept exactly as stored. 0 is preserved rather than coerced to null: it is
    // ambiguous (a blank legacy input persists as 0), and silently rewriting it
    // would destroy the only evidence of that ambiguity.
    waterLevel: Number.isFinite(raw.waterLevel) ? Number(raw.waterLevel) : null,
    note: typeof raw.note === 'string' ? raw.note : '',
    fieldId: typeof raw.fieldId === 'string' && raw.fieldId ? raw.fieldId : null,
    fixQuality: Number.isFinite(raw.fixQuality) ? Number(raw.fixQuality) : null,
    satelliteCount: Number.isFinite(raw.satelliteCount) ? Number(raw.satelliteCount) : null,
    hdop: Number.isFinite(raw.hdop) ? Number(raw.hdop) : null,
    fixAugmented: raw.fixAugmented === true,
    positionSource: typeof raw.positionSource === 'string' ? raw.positionSource : '',
  }
}

export class RecordedWaterMeasurementRepository {
  private readonly store: MarkedObservationReader
  private readonly listeners = new Set<() => void>()
  private snapshot: WaterMeasurementSnapshot = {
    measurements: [],
    loading: typeof indexedDB !== 'undefined',
    error: null,
  }
  private loadPromise: Promise<void> | null = null

  constructor(store: MarkedObservationReader = new RecordingStore()) {
    this.store = store
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): WaterMeasurementSnapshot => this.snapshot

  ensureLoaded(): void {
    if (this.snapshot.loading && !this.loadPromise) void this.refresh()
  }

  async refresh(): Promise<void> {
    if (this.loadPromise) return this.loadPromise
    this.snapshot = { ...this.snapshot, loading: true }
    this.emit()
    this.loadPromise = (async () => {
      try {
        // readAll rather than listMarkedObservations(sessionId): the map shows
        // every saved reading, not one session's. Both are existing public
        // methods on the unchanged RecordingStore.
        const records = await this.store.readAll(STORE_MARKED_OBSERVATIONS)
        const measurements = records
          .map(adaptWaterLevelMeasurement)
          .filter((item): item is WaterLevelMeasurement => item !== null)
        this.snapshot = { measurements, loading: false, error: null }
      } catch (error) {
        this.snapshot = {
          measurements: [],
          loading: false,
          error: `Saved water-level readings could not be read: ${error instanceof Error ? error.message : String(error)}`,
        }
      } finally {
        this.loadPromise = null
        this.emit()
      }
    })()
    return this.loadPromise
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener())
  }
}

export const recordedWaterMeasurementRepository = new RecordedWaterMeasurementRepository()
