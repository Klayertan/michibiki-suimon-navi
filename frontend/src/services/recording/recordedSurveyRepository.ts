import { RecordingStore } from '@legacy/recording/recording-store.js'
import { adaptGnssPoint } from '../../domain/surveys/adapters'
import type { GnssPoint, SurveyRecord } from '../../domain/surveys/types'

interface RecordingReader {
  listSessions(): Promise<Array<Record<string, unknown>>>
  getStructuredFixes(sessionId: string): Promise<unknown[]>
  updateSession?(sessionId: string, patch: Record<string, unknown>): Promise<unknown>
}

export interface RecordedSurveySnapshot {
  surveys: SurveyRecord[]
  loading: boolean
  error: string | null
}

export class RecordedSurveyRepository {
  private readonly store: RecordingReader
  private readonly listeners = new Set<() => void>()
  private snapshot: RecordedSurveySnapshot = {
    surveys: [],
    loading: typeof indexedDB !== 'undefined',
    error: null,
  }
  private loadPromise: Promise<void> | null = null

  constructor(store: RecordingReader = new RecordingStore()) {
    this.store = store
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): RecordedSurveySnapshot => this.snapshot

  ensureLoaded(): void {
    if (this.snapshot.loading && !this.loadPromise) void this.refresh()
  }

  async refresh(): Promise<void> {
    if (this.loadPromise) return this.loadPromise
    this.snapshot = { ...this.snapshot, loading: true }
    this.emit()
    this.loadPromise = (async () => {
      try {
        const sessions = await this.store.listSessions()
        const surveys = await Promise.all(sessions.map(async (session): Promise<SurveyRecord | null> => {
          const sessionId = typeof session.sessionId === 'string' ? session.sessionId : null
          if (!sessionId) return null
          const fixes = await this.store.getStructuredFixes(sessionId)
          const points = fixes
            .map((fix, index) => adaptGnssPoint(fix, `${sessionId}-fix-${index}`))
            .filter((point): point is GnssPoint => point !== null)
          const startedAt = typeof session.startedAt === 'string' ? session.startedAt : null
          const fieldId = typeof session.fieldId === 'string' ? session.fieldId : null
          const name = typeof session.fieldName === 'string' && session.fieldName
            ? `${session.fieldName} recording`
            : `GNSS recording ${startedAt ? new Date(startedAt).toLocaleString() : sessionId}`
          return {
            id: `recording:${sessionId}`,
            name,
            fieldId,
            session: {
              id: sessionId,
              name,
              fieldId,
              sourceFileName: null,
              measurementType: 'live_recording',
              createdAt: startedAt,
              uploadedAt: typeof session.endedAt === 'string' ? session.endedAt : null,
              rawNmeaStored: true,
              rawNmeaLineCount: typeof session.totalReceivedLines === 'number' ? session.totalReceivedLines : null,
              points,
            },
            track: null,
            displayCoordinates: points.map((point) => [point.lat, point.lon]),
          }
        }))
        this.snapshot = { surveys: surveys.filter((survey): survey is SurveyRecord => survey !== null), loading: false, error: null }
      } catch (error) {
        this.snapshot = { surveys: [], loading: false, error: `Saved recordings could not be read: ${error instanceof Error ? error.message : String(error)}` }
      } finally {
        this.loadPromise = null
        this.emit()
      }
    })()
    return this.loadPromise
  }

  async linkToField(surveyId: string, field: { id: string; name: string }): Promise<void> {
    if (!surveyId.startsWith('recording:') || !this.store.updateSession) return
    await this.store.updateSession(surveyId.slice('recording:'.length), {
      fieldId: field.id,
      fieldName: field.name,
      updatedAt: new Date().toISOString(),
    })
    await this.refresh()
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener())
  }
}

export const recordedSurveyRepository = new RecordedSurveyRepository()
