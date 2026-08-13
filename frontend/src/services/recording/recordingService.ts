import { makeSessionId, nextRecordingState } from '@legacy/recording/recording-core.js'
import { QuotaExceededStorageError, RecordingStore } from '@legacy/recording/recording-store.js'
import type { GnssLineEvent, GnssSerialSnapshot, LiveGnssFix } from '../gnss/serialGnssService'

interface RecordingPersistence {
  /** Full session records (js/recording/recording-store.js's own return shape), not just ids -- see adaptRecoverableSession below. */
  listUnfinishedSessions(): Promise<Array<Record<string, unknown>>>
  getSession(sessionId: string): Promise<Record<string, unknown> | undefined>
  /** Highest `seq` already persisted for a session, across both raw lines and fixes -- resuming must continue from here, never reset to 0. */
  getMaxSeq(sessionId: string): Promise<number>
  countRawLines(sessionId: string): Promise<number>
  createSession(session: Record<string, unknown>): Promise<unknown>
  updateSession(sessionId: string, patch: Record<string, unknown>): Promise<unknown>
  appendRawLines(sessionId: string, lines: Array<Record<string, unknown>>): Promise<unknown>
  appendStructuredFixes(sessionId: string, fixes: Array<Record<string, unknown>>): Promise<unknown>
  /** Cascading delete across sessions/rawNmeaLines/structuredFixes/markedObservations/imageBlobs -- see recording-store.js's deleteSession(). */
  deleteSession(sessionId: string): Promise<unknown>
}

export type RecordingState = 'idle' | 'recording' | 'stopping' | 'stopped' | 'error' | 'recovery_available'

/** The last fix a session had recorded before it went unfinished -- shape matches session.lastValidFix exactly (see recording-controller.js's sessionCounterPatch()). */
export interface RecoverableSessionFix {
  timestamp: string | null
  lat: number
  lon: number
  fixQuality: number | null
}

/**
 * A typed, adapted view of one row from `listUnfinishedSessions()` -- "unfinished"
 * meaning its persisted `status` is still "recording" (this app never exposes
 * "paused" in React; see recordingService.ts's own state machine). Every
 * property here is read from the existing session record; nothing is invented.
 */
export interface RecoverableSession {
  sessionId: string
  startedAt: string | null
  /** Last time this session's record was written -- legacy's own proxy for "last activity", not a separate per-point timestamp. */
  updatedAt: string | null
  rawLineCount: number
  validFixCount: number
  lastValidFix: RecoverableSessionFix | null
  fieldId: string | null
  fieldName: string | null
}

/**
 * Never throws: an unfinished session that itself failed to serialize
 * cleanly must still surface as *something* an operator can finalize or
 * discard, not vanish silently. Only a missing/invalid `sessionId` drops the
 * candidate entirely (there is no action any UI could safely offer without one).
 */
export function adaptRecoverableSession(raw: unknown, rawLineCount: number): RecoverableSession | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || !record.sessionId) return null
  return {
    sessionId: record.sessionId,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : null,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    rawLineCount: Number.isFinite(rawLineCount) ? rawLineCount : 0,
    validFixCount: typeof record.validFixCount === 'number' && Number.isFinite(record.validFixCount) ? record.validFixCount : 0,
    lastValidFix: adaptRecoverableFix(record.lastValidFix),
    fieldId: typeof record.fieldId === 'string' && record.fieldId ? record.fieldId : null,
    fieldName: typeof record.fieldName === 'string' && record.fieldName ? record.fieldName : null,
  }
}

function adaptRecoverableFix(raw: unknown): RecoverableSessionFix | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon)) return null
  return {
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
    lat: Number(record.lat),
    lon: Number(record.lon),
    fixQuality: Number.isFinite(record.fixQuality) ? Number(record.fixQuality) : null,
  }
}

/**
 * Stage 5B (task section 12): distinguishes *why* recording currently has no
 * live GNSS input, without ever implying the session stopped or that a point
 * was fabricated. This drives `RecordingSnapshot.warning`, a field distinct
 * from Stage 5A's `recoveryWarning` so the two conditions can never clobber
 * each other.
 */
function interruptionWarning(snapshot: GnssSerialSnapshot): string {
  if (snapshot.connectionState === 'reconnecting') {
    return `GNSS reconnecting (attempt ${snapshot.reconnectAttempt}/${snapshot.reconnectMaxAttempts}). Recording remains open; no stale or synthetic points will be recorded.`
  }
  if (snapshot.connectionState === 'reconnect_required') {
    return 'GNSS reconnect required. Recording remains open; reconnect manually to keep capturing points.'
  }
  if (snapshot.connectionState === 'stalled') {
    return 'GNSS connected but no data received recently. Recording remains open; no stale or synthetic points will be recorded.'
  }
  return 'GNSS disconnected. The session remains open, but no stale or synthetic points will be recorded.'
}

export interface RecordingSnapshot {
  state: RecordingState
  activeSessionId: string | null
  startedAt: string | null
  pointCount: number
  lineCount: number
  pendingCount: number
  error: string | null
  warning: string | null
  /** Every other unfinished session detected at startup or after a recovery action -- excludes the currently active session, if any (see resumeRecovery). */
  recoverySessions: RecoverableSession[]
  /** True only while a resume/finalize/discard call is in flight -- guards a double-click from racing two calls against the same session, mirroring legacy's recoveryInProgress flag. */
  recoveryInProgress: boolean
  /** Distinct from `warning` (a live-recording GNSS notice) so the two can never overwrite each other. */
  recoveryWarning: string | null
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
    recoverySessions: [], recoveryInProgress: false, recoveryWarning: null,
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
      this.update({ warning: interruptionWarning(snapshot) })
    } else if (this.snapshot.state === 'recording') {
      this.update({ warning: null })
    }
  }

  async start(field: { id: string; name: string } | null = null): Promise<boolean> {
    if (this.snapshot.activeSessionId && this.snapshot.state === 'error') return false
    // 'recovery_available' must map through unchanged, not collapse to
    // 'idle': the legacy state machine (recording-core.js) has no `start`
    // transition from recovery_available, only resume/finish/delete -- an
    // unresolved recovery must keep blocking a brand-new session exactly like
    // it does in the legacy app.
    const coreState = this.snapshot.state === 'stopped' || this.snapshot.state === 'recovery_available'
      ? this.snapshot.state
      : 'idle'
    if (nextRecordingState(coreState, 'start') !== 'recording') return false
    try {
      const unfinished = await this.store.listUnfinishedSessions()
      if (unfinished.length > 0) {
        // Defense-in-depth against the same race the state check above
        // already guards: refresh so the operator sees exactly which
        // session(s) are blocking, rather than a generic rejection.
        await this.checkForRecovery()
        this.update({ error: 'An unfinished recording exists. Resolve it above (Resume, Finish & Save, or Discard) before starting a new one.' })
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

  // -------------------------------------------------------------------------
  // Recovery -- port of js/recording/recording-controller.js's
  // refreshRecoveryList/resumeSession/finishSession/deleteSession. "Unfinished"
  // means exactly what RecordingStore.listUnfinishedSessions() already
  // defines: status === "recording" (this app never writes "paused"). No new
  // definition, no schema change, no second recovery state machine --
  // recording-core.js's own RECORDING_TRANSITIONS already model
  // recovery_available -> {resume, finish, delete}.
  // -------------------------------------------------------------------------

  /**
   * Detects unfinished sessions without mutating any of them. Safe to call
   * repeatedly (once at app-root mount, and again after every resume/finish/
   * discard) -- mirrors legacy's refreshRecoveryList(). Only auto-transitions
   * into 'recovery_available' from 'idle', exactly like legacy's own guard
   * (`this.recordingState === "idle"`), so this can never interrupt an
   * in-progress recording or silently overwrite an error state.
   */
  async checkForRecovery(): Promise<void> {
    let rawSessions: Array<Record<string, unknown>>
    try {
      rawSessions = await this.store.listUnfinishedSessions()
    } catch (error) {
      // A failed scan is not "nothing to recover" -- those are different
      // facts and must not be presented identically.
      this.update({ recoveryWarning: `Could not check for unfinished recordings: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    const candidates = await Promise.all(rawSessions.map(async (raw) => {
      const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : null
      const rawLineCount = sessionId ? await this.store.countRawLines(sessionId).catch(() => 0) : 0
      return adaptRecoverableSession(raw, rawLineCount)
    }))
    const valid = candidates.filter((candidate): candidate is RecoverableSession => candidate !== null)
      // The just-resumed session is still "status: recording" in storage (it
      // is actively being recorded again), so it would otherwise reappear in
      // its own recovery list -- exclude whichever session is currently active.
      .filter((candidate) => candidate.sessionId !== this.snapshot.activeSessionId)
    const droppedCount = candidates.length - candidates.filter((candidate) => candidate !== null).length
    // Symmetric with the idle -> recovery_available transition below: if the
    // last unfinished session was just resolved (Finish & Save / Discard) and
    // it wasn't the active session -- so neither method's own state patch
    // already moved us on -- this state must release back to idle, or a
    // legacy-created session with no React-side "active" session would leave
    // the app permanently stuck refusing new recordings.
    let nextState = this.snapshot.state
    if (nextState === 'idle' && valid.length > 0) nextState = 'recovery_available'
    else if (nextState === 'recovery_available' && valid.length === 0) nextState = 'idle'
    this.update({
      recoverySessions: valid,
      recoveryWarning: droppedCount > 0
        ? `${droppedCount} unfinished recording(s) could not be read and were not shown.`
        : null,
      state: nextState,
    })
  }

  /**
   * Resumes an unfinished session: continues its monotonic seq counter from
   * `getMaxSeq()` (never resets to 0), restores it as the active session, and
   * marks it "recording" again. Deliberately does **not** touch the serial
   * connection or request a wake lock -- resuming is a recording-state action
   * only; connecting GNSS remains a separate, explicit operator action (task
   * section 10), and wake locks are out of scope for this stage.
   */
  async resumeRecovery(sessionId: string): Promise<boolean> {
    // Guards a double-click firing two overlapping calls, exactly like
    // legacy's recoveryInProgress flag.
    if (this.snapshot.recoveryInProgress) return false
    this.update({ recoveryInProgress: true })
    try {
      const session = await this.store.getSession(sessionId)
      if (!session) {
        // No checkForRecovery() call here: nothing in storage changed, so the
        // existing recoverySessions list is still accurate -- refreshing it
        // would also unconditionally reset recoveryWarning to null and erase
        // the message this line just set.
        this.update({ recoveryInProgress: false, recoveryWarning: 'That recording could not be found. It may have already been resumed, finished, or discarded elsewhere.' })
        return false
      }
      const seq = await this.store.getMaxSeq(sessionId)
      const nowIso = new Date().toISOString()
      await this.store.updateSession(sessionId, { status: 'recording', updatedAt: nowIso })
      this.seq = seq
      this.rawQueue = []
      this.fixQueue = []
      const startedAt = typeof session.startedAt === 'string' ? session.startedAt : nowIso
      const lineCount = typeof session.totalReceivedLines === 'number' ? session.totalReceivedLines : 0
      const pointCount = typeof session.validFixCount === 'number' ? session.validFixCount : 0
      this.update({
        state: 'recording',
        activeSessionId: sessionId,
        startedAt,
        pointCount,
        lineCount,
        pendingCount: 0,
        error: null,
        warning: this.connectionMeta?.connectionState === 'connected' ? null : 'Recording is open, but GNSS is disconnected. Connect it separately to keep recording.',
        recoveryInProgress: false,
      })
      // Tells SurveyLayer/LiveSurveyLayer a live track begins here -- the
      // persisted portion is drawn separately from the saved session; this
      // starts a fresh polyline that extends it forward, not a duplicate.
      this.trackListeners.forEach((listener) => listener({ type: 'start' }))
      await this.checkForRecovery()
      return true
    } catch (error) {
      this.update({ recoveryInProgress: false, state: 'error', error: `Could not resume that recording: ${error instanceof Error ? error.message : String(error)}` })
      return false
    }
  }

  /**
   * Marks an unfinished session stopped without adding any point or fix --
   * a single status/endedAt patch, exactly like legacy's finishSession(). Can
   * target any unfinished session, not only the currently active one (task
   * section 13: multiple unfinished sessions must be handled independently).
   */
  async finalizeRecovery(sessionId: string): Promise<boolean> {
    try {
      const nowIso = new Date().toISOString()
      await this.store.updateSession(sessionId, { status: 'stopped', endedAt: nowIso, updatedAt: nowIso })
      if (this.snapshot.activeSessionId === sessionId) {
        this.update({ state: 'stopped' })
      }
      await this.checkForRecovery()
      return true
    } catch (error) {
      this.update({ recoveryWarning: `Could not finish that recording: ${error instanceof Error ? error.message : String(error)}` })
      return false
    }
  }

  /**
   * Discards an unfinished session. Proven safe to expose (unlike Stage 2's
   * deferred field deletion): RecordingStore.deleteSession() already cascades
   * across every child store (rawNmeaLines, structuredFixes,
   * markedObservations, imageBlobs) keyed by sessionId, so nothing can be
   * orphaned. Confirmation is the caller's (UI) responsibility, matching how
   * FieldInspector's delete confirmation works.
   */
  async discardRecovery(sessionId: string): Promise<boolean> {
    try {
      await this.store.deleteSession(sessionId)
      if (this.snapshot.activeSessionId === sessionId) {
        this.seq = 0
        this.rawQueue = []
        this.fixQueue = []
        this.update({ state: 'idle', activeSessionId: null, startedAt: null, pointCount: 0, lineCount: 0, pendingCount: 0 })
      }
      await this.checkForRecovery()
      return true
    } catch (error) {
      this.update({ recoveryWarning: `Could not discard that recording: ${error instanceof Error ? error.message : String(error)}` })
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
