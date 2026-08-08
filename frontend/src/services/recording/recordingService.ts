import { makeSessionId, nextRecordingState } from '@legacy/recording/recording-core.js'
import { QuotaExceededStorageError, RecordingStore } from '@legacy/recording/recording-store.js'
import type { GnssLineEvent, GnssSerialSnapshot, LiveGnssFix } from '../gnss/serialGnssService'

interface RecordingPersistence {
  listUnfinishedSessions(): Promise<Array<{ sessionId: string }>>
  createSession(session: Record<string, unknown>): Promise<unknown>
  updateSession(sessionId: string, patch: Record<string, unknown>): Promise<unknown>
  appendRawLines(sessionId: string, lines: Array<Record<string, unknown>>): Promise<unknown>
  appendStructuredFixes(sessionId: string, fixes: Array<Record<string, unknown>>): Promise<unknown>
}

export type RecordingState = 'idle' | 'recording' | 'stopping' | 'stopped' | 'error'

export interface RecordingSnapshot {
  state: RecordingState
  activeSessionId: string | null
  startedAt: string | null
  pointCount: number
  lineCount: number
  pendingCount: number
  error: string | null
  warning: string | null
}

export type LiveTrackEvent = { type: 'start' } | { type: 'point'; point: LiveGnssFix } | { type: 'stop' }

type Listener = () => void
type TrackListener = (event: LiveTrackEvent) => void

export class RecordingService {
  private readonly store: RecordingPersistence
  private readonly listeners = new Set<Listener>()
  private readonly trackListeners = new Set<TrackListener>()
  private snapshot: RecordingSnapshot = {
    state: 'idle', activeSessionId: null, startedAt: null, pointCount: 0, lineCount: 0, pendingCount: 0, error: null, warning: null,
  }
  private seq = 0
  private rawQueue: Array<Record<string, unknown>> = []
  private fixQueue: Array<Record<string, unknown>> = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushPromise: Promise<boolean> | null = null
  private connectionMeta: GnssSerialSnapshot | null = null

  constructor(store: RecordingPersistence = new RecordingStore()) {
    this.store = store
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeLiveTrack(listener: TrackListener): () => void {
    this.trackListeners.add(listener)
    return () => this.trackListeners.delete(listener)
  }

  getSnapshot = (): RecordingSnapshot => this.snapshot

  setConnectionMeta(snapshot: GnssSerialSnapshot): void {
    this.connectionMeta = snapshot
    if (this.snapshot.state === 'recording' && snapshot.connectionState !== 'connected') {
      this.update({ warning: 'GNSS disconnected. The session remains open, but no stale or synthetic points will be recorded.' })
    } else if (this.snapshot.state === 'recording') {
      this.update({ warning: null })
    }
  }

  async start(field: { id: string; name: string } | null = null): Promise<boolean> {
    if (this.snapshot.activeSessionId && this.snapshot.state === 'error') return false
    const coreState = this.snapshot.state === 'stopped' ? 'stopped' : 'idle'
    if (nextRecordingState(coreState, 'start') !== 'recording') return false
    try {
      const unfinished = await this.store.listUnfinishedSessions()
      if (unfinished.length > 0) {
        this.update({ error: 'An unfinished legacy recording exists. Resume or finish it in the legacy interface before starting another.' })
        return false
      }
      const sessionId = makeSessionId()
      const startedAt = new Date().toISOString()
      await this.store.createSession({
        sessionId,
        startedAt,
        endedAt: null,
        status: 'recording',
        fieldId: field?.id ?? null,
        fieldName: field?.name ?? null,
        transportLabel: this.connectionMeta?.transportLabel ?? null,
        baudRate: this.connectionMeta?.baudRate ?? null,
        deviceInfo: {},
        totalReceivedLines: 0,
        validFixCount: 0,
        checksumFailureCount: 0,
        malformedLineCount: 0,
        lastValidFix: null,
        notes: '',
        updatedAt: startedAt,
      })
      this.seq = 0
      this.rawQueue = []
      this.fixQueue = []
      this.update({ state: 'recording', activeSessionId: sessionId, startedAt, pointCount: 0, lineCount: 0, pendingCount: 0, error: null, warning: this.connectionMeta?.connectionState === 'connected' ? null : 'Recording is open, but GNSS is disconnected.' })
      this.trackListeners.forEach((listener) => listener({ type: 'start' }))
      return true
    } catch (error) {
      this.update({ state: 'error', error: `Could not create recording session: ${error instanceof Error ? error.message : String(error)}` })
      return false
    }
  }

  ingest(event: GnssLineEvent): void {
    if (this.snapshot.state !== 'recording' || !this.snapshot.activeSessionId) return
    const receivedAt = new Date().toISOString()
    this.rawQueue.push({ seq: ++this.seq, receivedAt, line: event.rawLine })
    let pointCount = this.snapshot.pointCount
    if (event.point) {
      pointCount += 1
      this.fixQueue.push({
        seq: ++this.seq,
        receivedAt,
        timestamp: event.point.timestamp,
        lat: event.point.lat,
        lon: event.point.lon,
        altitude: event.point.altitudeMsl,
        fixQuality: event.point.fixQuality,
        satellites: event.point.satellites,
        hdop: event.point.hdop,
        rawLine: event.rawLine,
      })
      this.trackListeners.forEach((listener) => listener({ type: 'point', point: event.point! }))
    }
    this.update({ lineCount: this.snapshot.lineCount + 1, pointCount, pendingCount: this.rawQueue.length + this.fixQueue.length })
    if (this.rawQueue.length + this.fixQueue.length >= 25) void this.flush()
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush() }, 1000)
  }

  async stop(): Promise<boolean> {
    if ((this.snapshot.state !== 'recording' && this.snapshot.state !== 'error') || !this.snapshot.activeSessionId) return false
    this.update({ state: 'stopping', warning: null })
    const flushed = await this.flush()
    if (!flushed) {
      this.update({ state: 'error' })
      return false
    }
    const endedAt = new Date().toISOString()
    try {
      await this.store.updateSession(this.snapshot.activeSessionId, {
        status: 'stopped',
        endedAt,
        totalReceivedLines: this.snapshot.lineCount,
        validFixCount: this.snapshot.pointCount,
        updatedAt: endedAt,
      })
      this.update({ state: 'stopped', pendingCount: 0, error: null })
      this.trackListeners.forEach((listener) => listener({ type: 'stop' }))
      return true
    } catch (error) {
      this.update({ state: 'error', error: this.storageError(error) })
      return false
    }
  }

  async flush(): Promise<boolean> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.flushPromise) return this.flushPromise
    if (!this.snapshot.activeSessionId) return true
    const sessionId = this.snapshot.activeSessionId
    const lines = this.rawQueue.splice(0)
    const fixes = this.fixQueue.splice(0)
    if (lines.length === 0 && fixes.length === 0) return true
    this.flushPromise = (async () => {
      try {
        if (lines.length > 0) await this.store.appendRawLines(sessionId, lines)
        if (fixes.length > 0) await this.store.appendStructuredFixes(sessionId, fixes)
        await this.store.updateSession(sessionId, {
          totalReceivedLines: this.snapshot.lineCount,
          validFixCount: this.snapshot.pointCount,
          lastValidFix: this.connectionMeta?.currentFix
            ? { timestamp: this.connectionMeta.currentFix.timestamp, lat: this.connectionMeta.currentFix.lat, lon: this.connectionMeta.currentFix.lon, fixQuality: this.connectionMeta.currentFix.fixQuality }
            : null,
          updatedAt: new Date().toISOString(),
        })
        this.update({ pendingCount: this.rawQueue.length + this.fixQueue.length, error: null })
        return true
      } catch (error) {
        this.rawQueue = lines.concat(this.rawQueue).slice(-2000)
        this.fixQueue = fixes.concat(this.fixQueue).slice(-2000)
        this.update({ pendingCount: this.rawQueue.length + this.fixQueue.length, error: this.storageError(error) })
        return false
      } finally {
        this.flushPromise = null
      }
    })()
    return this.flushPromise
  }

  private storageError(error: unknown): string {
    return error instanceof QuotaExceededStorageError
      ? 'Recording storage quota was exceeded. Unsaved queued data is retained for retry.'
      : `Recording storage error: ${error instanceof Error ? error.message : String(error)}`
  }

  private update(patch: Partial<RecordingSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((listener) => listener())
  }
}

export const recordingService = new RecordingService()
