import { describe, expect, it, vi } from 'vitest'
import { QuotaExceededStorageError } from '@legacy/recording/recording-store.js'
import { RecordingService, adaptRecoverableSession } from '../recordingService'
import type { GnssLineEvent } from '../../gnss/serialGnssService'

interface FakeRecord extends Record<string, unknown> {
  sessionId: string
}

function fakeStore() {
  const state = {
    unfinished: [] as FakeRecord[],
    sessions: [] as FakeRecord[],
    lines: [] as Array<FakeRecord & { seq: number }>,
    fixes: [] as Array<FakeRecord & { seq: number }>,
  }
  return {
    ...state,
    listUnfinishedSessions: vi.fn(async function (this: typeof state) { return this.unfinished }),
    getSession: vi.fn(async function (this: typeof state, id: string) { return this.sessions.find((s) => s.sessionId === id) }),
    getMaxSeq: vi.fn(async function (this: typeof state, id: string) {
      const seqs = [...this.lines, ...this.fixes].filter((r) => r.sessionId === id).map((r) => r.seq || 0)
      return seqs.length ? Math.max(...seqs) : 0
    }),
    countRawLines: vi.fn(async function (this: typeof state, id: string) { return this.lines.filter((l) => l.sessionId === id).length }),
    createSession: vi.fn(async function (this: typeof state, session: Record<string, unknown>) { this.sessions.push(session as FakeRecord) }),
    updateSession: vi.fn(async function (this: typeof state, id: string, patch: Record<string, unknown>) {
      const session = this.sessions.find((candidate) => candidate.sessionId === id)
      if (session) Object.assign(session, patch)
    }),
    appendRawLines: vi.fn(async function (this: typeof state, id: string, lines: Array<Record<string, unknown>>) {
      this.lines.push(...lines.map((line) => ({ ...line, sessionId: id }) as FakeRecord & { seq: number }))
    }),
    appendStructuredFixes: vi.fn(async function (this: typeof state, id: string, fixes: Array<Record<string, unknown>>) {
      this.fixes.push(...fixes.map((fix) => ({ ...fix, sessionId: id }) as FakeRecord & { seq: number }))
    }),
    deleteSession: vi.fn(async function (this: typeof state, id: string) {
      this.sessions = this.sessions.filter((s) => s.sessionId !== id)
      this.lines = this.lines.filter((l) => l.sessionId !== id)
      this.fixes = this.fixes.filter((f) => f.sessionId !== id)
    }),
  }
}

function event(index: number): GnssLineEvent {
  const rawLine = `$GNGGA,${index}`
  return {
    rawLine,
    looksLikeGga: true,
    noFix: false,
    malformed: false,
    point: {
      id: `p${index}`, lat: 34 + index / 1000, lon: 135 + index / 1000, timestamp: String(index), timestampUtcMs: null,
      fixQuality: 2, fixValid: true, satellites: 12, hdop: 0.8, altitudeMsl: 10, augmented: true,
      receivedAtMs: Date.now(), rawLine,
    },
  }
}

/** A legacy-shaped unfinished session record, as recording-controller.js's startRecording() would have written it. */
function unfinishedSession(overrides: Partial<FakeRecord> = {}): FakeRecord {
  return {
    sessionId: 'rec-old', startedAt: '2026-08-01T00:00:00.000Z', endedAt: null, status: 'recording',
    fieldId: 'field-1', fieldName: 'North field', transportLabel: 'Bluetooth SPP', baudRate: 115200,
    deviceInfo: {}, totalReceivedLines: 3, validFixCount: 2, checksumFailureCount: 0, malformedLineCount: 0,
    lastValidFix: { timestamp: '2026-08-01T00:04:00.000Z', lat: 34.001, lon: 135.001, fixQuality: 2 },
    notes: '', updatedAt: '2026-08-01T00:05:00.000Z',
    ...overrides,
  }
}

describe('RecordingService', () => {
  it('starts with the exact legacy session shape, appends incrementally, and stops', async () => {
    const store = fakeStore()
    const service = new RecordingService(store as never)
    service.setConnectionMeta({ connectionState: 'connected', currentFix: event(1).point, baudRate: 115200, lineCount: 0, malformedLineCount: 0, message: null, transportLabel: 'Bluetooth SPP', reconnectAttempt: 0, reconnectMaxAttempts: 0 })
    expect(await service.start({ id: 'field-1', name: 'North field' })).toBe(true)
    service.ingest(event(1))
    service.ingest(event(2))
    expect(await service.stop()).toBe(true)

    expect(store.sessions).toHaveLength(1)
    expect(store.sessions[0]).toMatchObject({ status: 'stopped', fieldId: 'field-1', baudRate: 115200, totalReceivedLines: 2, validFixCount: 2 })
    expect(store.lines).toHaveLength(2)
    expect(store.fixes).toHaveLength(2)
    expect([...store.lines, ...store.fixes].map((record) => record.seq).sort()).toEqual([1, 2, 3, 4])
    expect(service.getSnapshot()).toMatchObject({ state: 'stopped', pointCount: 2, pendingCount: 0 })
  })

  it('blocks a new session while an unfinished recording exists, and surfaces it as a recovery candidate rather than only an error', async () => {
    const store = fakeStore()
    store.unfinished.push(unfinishedSession())
    const service = new RecordingService(store as never)
    expect(await service.start()).toBe(false)
    expect(service.getSnapshot().error).toContain('unfinished recording')
    expect(service.getSnapshot().state).toBe('recovery_available')
    expect(service.getSnapshot().recoverySessions).toHaveLength(1)
    expect(store.createSession).not.toHaveBeenCalled()
  })

  it('retains queued data and reports quota failure instead of pretending it saved', async () => {
    const store = fakeStore()
    const service = new RecordingService(store as never)
    await service.start()
    service.ingest(event(1))
    store.appendRawLines.mockRejectedValueOnce(new QuotaExceededStorageError('full'))
    expect(await service.flush()).toBe(false)
    expect(service.getSnapshot().pendingCount).toBe(2)
    expect(service.getSnapshot().error).toContain('quota')
    expect(await service.flush()).toBe(true)
    expect(service.getSnapshot().pendingCount).toBe(0)
  })

  it('keeps recording open across disconnect but does not add stale or synthetic points', async () => {
    const store = fakeStore()
    const service = new RecordingService(store as never)
    await service.start()
    service.ingest(event(1))
    service.setConnectionMeta({ connectionState: 'disconnected', currentFix: null, baudRate: 115200, lineCount: 1, malformedLineCount: 0, message: null, transportLabel: null, reconnectAttempt: 0, reconnectMaxAttempts: 0 })
    expect(service.getSnapshot()).toMatchObject({ state: 'recording', pointCount: 1 })
    expect(service.getSnapshot().warning).toContain('no stale or synthetic points')
  })

  describe('interruption messaging across GNSS connection states (Stage 5B)', () => {
    it('distinguishes reconnecting, with the attempt count, from a plain disconnect', async () => {
      const store = fakeStore()
      const service = new RecordingService(store as never)
      await service.start()
      service.setConnectionMeta({ connectionState: 'reconnecting', currentFix: null, baudRate: 115200, lineCount: 0, malformedLineCount: 0, message: null, transportLabel: null, reconnectAttempt: 2, reconnectMaxAttempts: 4 })
      expect(service.getSnapshot().state).toBe('recording')
      expect(service.getSnapshot().warning).toContain('reconnecting (attempt 2/4)')
      expect(service.getSnapshot().warning).toContain('Recording remains open')
    })

    it('tells the operator reconnect is now manual once automatic attempts are exhausted', async () => {
      const store = fakeStore()
      const service = new RecordingService(store as never)
      await service.start()
      service.setConnectionMeta({ connectionState: 'reconnect_required', currentFix: null, baudRate: 115200, lineCount: 0, malformedLineCount: 0, message: null, transportLabel: null, reconnectAttempt: 4, reconnectMaxAttempts: 4 })
      expect(service.getSnapshot().state).toBe('recording')
      expect(service.getSnapshot().warning).toContain('reconnect required')
      expect(service.getSnapshot().warning).toContain('Recording remains open')
    })

    it('distinguishes a stalled (port open, no data) link from an actual disconnect', async () => {
      const store = fakeStore()
      const service = new RecordingService(store as never)
      await service.start()
      service.setConnectionMeta({ connectionState: 'stalled', currentFix: null, baudRate: 115200, lineCount: 0, malformedLineCount: 0, message: null, transportLabel: null, reconnectAttempt: 0, reconnectMaxAttempts: 0 })
      expect(service.getSnapshot().warning).toContain('no data received recently')
    })

    it('clears the interruption warning once reconnected, without emitting a duplicate point', async () => {
      const store = fakeStore()
      const service = new RecordingService(store as never)
      await service.start()
      service.setConnectionMeta({ connectionState: 'reconnecting', currentFix: null, baudRate: 115200, lineCount: 0, malformedLineCount: 0, message: null, transportLabel: null, reconnectAttempt: 1, reconnectMaxAttempts: 4 })
      expect(service.getSnapshot().warning).not.toBeNull()
      service.setConnectionMeta({ connectionState: 'connected', currentFix: null, baudRate: 115200, lineCount: 0, malformedLineCount: 0, message: null, transportLabel: 'USB', reconnectAttempt: 0, reconnectMaxAttempts: 0 })
      expect(service.getSnapshot()).toMatchObject({ warning: null, pointCount: 0, lineCount: 0 })
    })
  })

  describe('sequence continuity across a disconnect/reconnect cycle (Stage 5B, no reload)', () => {
    it('never resets or duplicates seq -- ingest simply pauses and resumes on the same in-memory counter', async () => {
      const store = fakeStore()
      const service = new RecordingService(store as never)
      await service.start()
      service.ingest(event(1))
      service.ingest(event(2))
      // Disconnect: nothing calls ingest() while the transport is down --
      // this is enforced by useGnssRuntime only wiring subscribeLines() to
      // ingest(), and serialGnssService simply stops emitting line events
      // while no read loop is active. No RecordingService code path needs to
      // change for this, which this test exists to prove.
      service.setConnectionMeta({ connectionState: 'reconnecting', currentFix: null, baudRate: 115200, lineCount: 2, malformedLineCount: 0, message: null, transportLabel: null, reconnectAttempt: 1, reconnectMaxAttempts: 4 })
      const pendingBeforeReconnect = store.lines.length + store.fixes.length
      service.setConnectionMeta({ connectionState: 'connected', currentFix: null, baudRate: 115200, lineCount: 2, malformedLineCount: 0, message: null, transportLabel: 'USB', reconnectAttempt: 0, reconnectMaxAttempts: 0 })
      service.ingest(event(10))
      service.ingest(event(11))
      await service.flush()
      const seqValues = [...store.lines, ...store.fixes].map((record) => record.seq).sort((a, b) => a - b)
      expect(new Set(seqValues).size).toBe(seqValues.length) // no duplicates
      seqValues.forEach((value, index) => { if (index > 0) expect(value).toBeGreaterThan(seqValues[index - 1]) }) // monotonic
      expect(store.lines.length + store.fixes.length).toBeGreaterThan(pendingBeforeReconnect)
      expect(await service.stop()).toBe(true)
      expect(store.sessions).toHaveLength(1) // one session throughout, never a second
    })
  })

  describe('adaptRecoverableSession', () => {
    it('adapts a well-formed legacy session record', () => {
      const candidate = adaptRecoverableSession(unfinishedSession(), 3)
      expect(candidate).toEqual({
        sessionId: 'rec-old', startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:05:00.000Z',
        rawLineCount: 3, validFixCount: 2,
        lastValidFix: { timestamp: '2026-08-01T00:04:00.000Z', lat: 34.001, lon: 135.001, fixQuality: 2 },
        fieldId: 'field-1', fieldName: 'North field',
      })
    })

    it('drops a candidate with no usable sessionId -- no action could ever target it safely', () => {
      expect(adaptRecoverableSession({ startedAt: '2026-08-01T00:00:00.000Z' }, 0)).toBeNull()
      expect(adaptRecoverableSession({ sessionId: '' }, 0)).toBeNull()
      expect(adaptRecoverableSession(null, 0)).toBeNull()
      expect(adaptRecoverableSession('not an object', 0)).toBeNull()
    })

    it('degrades a corrupt/partial record to safe defaults instead of throwing or fabricating data', () => {
      expect(adaptRecoverableSession({ sessionId: 'rec-x' }, 0)).toEqual({
        sessionId: 'rec-x', startedAt: null, updatedAt: null, rawLineCount: 0, validFixCount: 0,
        lastValidFix: null, fieldId: null, fieldName: null,
      })
      // Malformed lastValidFix (non-finite coordinates) -> null, not NaN.
      expect(adaptRecoverableSession(unfinishedSession({ lastValidFix: { lat: 'oops', lon: 135 } }), 0)?.lastValidFix).toBeNull()
      // Wrong-typed validFixCount/fieldId -> defaults, not a crash.
      expect(adaptRecoverableSession(unfinishedSession({ validFixCount: 'two', fieldId: 42 }), 0)).toMatchObject({ validFixCount: 0, fieldId: null })
    })

    it('never reports a negative or non-finite raw line count', () => {
      expect(adaptRecoverableSession(unfinishedSession(), Number.NaN)?.rawLineCount).toBe(0)
    })
  })

  describe('recovery detection (checkForRecovery)', () => {
    it('finds nothing when storage has no unfinished session, and never mutates anything', async () => {
      const store = fakeStore()
      const service = new RecordingService(store as never)
      await service.checkForRecovery()
      expect(service.getSnapshot()).toMatchObject({ state: 'idle', recoverySessions: [] })
      expect(store.updateSession).not.toHaveBeenCalled()
      expect(store.deleteSession).not.toHaveBeenCalled()
    })

    it('finds one unfinished session and transitions idle -> recovery_available without mutating it', async () => {
      const store = fakeStore()
      store.unfinished.push(unfinishedSession())
      store.lines.push({ sessionId: 'rec-old', seq: 1 }, { sessionId: 'rec-old', seq: 2 }, { sessionId: 'rec-old', seq: 3 })
      const service = new RecordingService(store as never)
      await service.checkForRecovery()
      const snapshot = service.getSnapshot()
      expect(snapshot.state).toBe('recovery_available')
      expect(snapshot.recoverySessions).toEqual([{
        sessionId: 'rec-old', startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:05:00.000Z',
        rawLineCount: 3, validFixCount: 2,
        lastValidFix: { timestamp: '2026-08-01T00:04:00.000Z', lat: 34.001, lon: 135.001, fixQuality: 2 },
        fieldId: 'field-1', fieldName: 'North field',
      }])
      expect(store.updateSession).not.toHaveBeenCalled()
    })

    it('surfaces multiple unfinished sessions deterministically, not just the newest', async () => {
      const store = fakeStore()
      store.unfinished.push(unfinishedSession({ sessionId: 'rec-a' }), unfinishedSession({ sessionId: 'rec-b' }))
      const service = new RecordingService(store as never)
      await service.checkForRecovery()
      expect(service.getSnapshot().recoverySessions.map((session) => session.sessionId)).toEqual(['rec-a', 'rec-b'])
    })

    it('drops a malformed candidate (no sessionId) and reports how many were hidden, without hiding the well-formed ones', async () => {
      const store = fakeStore()
      store.unfinished.push(unfinishedSession({ sessionId: 'rec-a' }), { startedAt: 'x' } as unknown as FakeRecord)
      const service = new RecordingService(store as never)
      await service.checkForRecovery()
      const snapshot = service.getSnapshot()
      expect(snapshot.recoverySessions).toHaveLength(1)
      expect(snapshot.recoveryWarning).toContain('1 unfinished recording(s)')
    })

    it('reports a failed scan distinctly from "nothing to recover"', async () => {
      const store = fakeStore()
      store.listUnfinishedSessions.mockRejectedValueOnce(new Error('IDB unavailable'))
      const service = new RecordingService(store as never)
      await service.checkForRecovery()
      expect(service.getSnapshot().recoveryWarning).toContain('Could not check')
      expect(service.getSnapshot().recoverySessions).toEqual([])
    })

    it('does not overwrite an active recording or an error state', async () => {
      const store = fakeStore()
      const service = new RecordingService(store as never)
      await service.start()
      store.unfinished.push(unfinishedSession({ sessionId: 'rec-other' }))
      await service.checkForRecovery()
      expect(service.getSnapshot().state).toBe('recording')
    })

    it('releases recovery_available back to idle once the last unfinished session is resolved, even when it was never the active session', async () => {
      const store = fakeStore()
      store.unfinished.push(unfinishedSession())
      store.sessions.push(unfinishedSession())
      const service = new RecordingService(store as never)
      await service.checkForRecovery()
      expect(service.getSnapshot().state).toBe('recovery_available')

      // Finalizing resolves the session in storage; a real store's
      // listUnfinishedSessions() would no longer include it afterward.
      store.unfinished.length = 0
      expect(await service.finalizeRecovery('rec-old')).toBe(true)
      expect(service.getSnapshot().state).toBe('idle')
      expect(service.getSnapshot().recoverySessions).toEqual([])
    })
  })

  describe('resumeRecovery', () => {
    it('restores the session as active and transitions to recording', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession())
      store.unfinished.push(unfinishedSession())
      const service = new RecordingService(store as never)
      await service.checkForRecovery()
      expect(await service.resumeRecovery('rec-old')).toBe(true)
      expect(service.getSnapshot()).toMatchObject({ state: 'recording', activeSessionId: 'rec-old', pointCount: 2, lineCount: 3 })
      expect(store.sessions[0].status).toBe('recording')
    })

    it('never touches the serial connection -- resuming is a recording-state action only', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession())
      const service = new RecordingService(store as never)
      // No setConnectionMeta call at all: resuming must not require or assume one.
      expect(await service.resumeRecovery('rec-old')).toBe(true)
      expect(service.getSnapshot().warning).toContain('disconnected')
    })

    it('continues the monotonic seq counter from getMaxSeq -- new points never collide with pre-crash records', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession())
      store.lines.push({ sessionId: 'rec-old', seq: 1 }, { sessionId: 'rec-old', seq: 2 })
      store.fixes.push({ sessionId: 'rec-old', seq: 3 })
      const service = new RecordingService(store as never)
      await service.resumeRecovery('rec-old')

      service.ingest(event(10))
      service.ingest(event(11))
      await service.flush()

      const allSeq = [...store.lines, ...store.fixes].map((record) => record.seq).sort((a, b) => a - b)
      // 3 pre-existing (seq 1-3) + 2 ingests x (1 line + 1 fix each) = 7 total.
      expect(allSeq).toEqual([1, 2, 3, 4, 5, 6, 7])
      expect(new Set(allSeq).size).toBe(allSeq.length)
    })

    it('preserves old and new points exactly once across the resume boundary', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession())
      store.lines.push({ sessionId: 'rec-old', seq: 1, line: '$OLD,1' })
      const service = new RecordingService(store as never)
      await service.resumeRecovery('rec-old')
      service.ingest(event(1))
      await service.flush()

      expect(store.lines).toHaveLength(2)
      expect(store.lines.map((line) => line.line)).toEqual(['$OLD,1', event(1).rawLine])
      expect(store.fixes).toHaveLength(1)
    })

    it('preserves the field link -- resuming never edits fieldId/fieldName', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession({ fieldId: 'field-9', fieldName: 'South field' }))
      const service = new RecordingService(store as never)
      await service.resumeRecovery('rec-old')
      expect(store.sessions[0]).toMatchObject({ fieldId: 'field-9', fieldName: 'South field' })
    })

    it('starts a fresh live-track segment on resume, so the map extends rather than duplicates the persisted track', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession())
      const service = new RecordingService(store as never)
      const events: string[] = []
      service.subscribeLiveTrack((event) => events.push(event.type))
      await service.resumeRecovery('rec-old')
      expect(events).toEqual(['start'])
    })

    it('ignores a second concurrent resume call while the first is still in flight', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession())
      const service = new RecordingService(store as never)
      const [first, second] = await Promise.all([service.resumeRecovery('rec-old'), service.resumeRecovery('rec-old')])
      expect([first, second].filter(Boolean)).toHaveLength(1)
      expect(store.getSession).toHaveBeenCalledTimes(1)
    })

    it('fails closed when the session no longer exists, without corrupting service state', async () => {
      const store = fakeStore()
      const service = new RecordingService(store as never)
      expect(await service.resumeRecovery('rec-missing')).toBe(false)
      expect(service.getSnapshot()).toMatchObject({ state: 'idle', activeSessionId: null, recoveryInProgress: false })
      expect(service.getSnapshot().recoveryWarning).toContain('could not be found')
    })

    it('fails closed on a storage error during resume, leaving the original session status untouched', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession())
      store.updateSession.mockRejectedValueOnce(new Error('transaction aborted'))
      const service = new RecordingService(store as never)
      expect(await service.resumeRecovery('rec-old')).toBe(false)
      expect(service.getSnapshot()).toMatchObject({ state: 'error', recoveryInProgress: false })
      // The write never happened -- the session is exactly as it was before.
      expect(store.sessions[0].status).toBe('recording')
    })
  })

  describe('finalizeRecovery ("Finish & Save")', () => {
    it('marks the session stopped without adding any point, fix, or fabricated endpoint', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession())
      store.lines.push({ sessionId: 'rec-old', seq: 1 })
      const service = new RecordingService(store as never)
      expect(await service.finalizeRecovery('rec-old')).toBe(true)
      expect(store.sessions[0]).toMatchObject({ status: 'stopped' })
      expect(store.sessions[0].endedAt).toEqual(expect.any(String))
      expect(store.lines).toHaveLength(1)
      expect(store.fixes).toHaveLength(0)
      expect(store.appendRawLines).not.toHaveBeenCalled()
      expect(store.appendStructuredFixes).not.toHaveBeenCalled()
    })

    it('can finalize a session that is not the currently active one, leaving the active recording untouched', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession({ sessionId: 'rec-other' }))
      const service = new RecordingService(store as never)
      await service.start()
      expect(await service.finalizeRecovery('rec-other')).toBe(true)
      expect(service.getSnapshot().state).toBe('recording')
      expect(store.sessions.find((s) => s.sessionId === 'rec-other')).toMatchObject({ status: 'stopped' })
    })

    it('transitions the active session to stopped when finalizing itself', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession())
      const service = new RecordingService(store as never)
      await service.resumeRecovery('rec-old')
      expect(await service.finalizeRecovery('rec-old')).toBe(true)
      expect(service.getSnapshot().state).toBe('stopped')
    })

    it('fails closed on a storage error, leaving the session unaffected and reporting rather than pretending success', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession())
      store.updateSession.mockRejectedValueOnce(new Error('write failed'))
      const service = new RecordingService(store as never)
      expect(await service.finalizeRecovery('rec-old')).toBe(false)
      expect(store.sessions[0].status).toBe('recording')
      expect(service.getSnapshot().recoveryWarning).toContain('Could not finish')
    })
  })

  describe('discardRecovery ("Discard")', () => {
    it('delegates to the proven-safe cascading store delete', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession())
      store.lines.push({ sessionId: 'rec-old', seq: 1 })
      const service = new RecordingService(store as never)
      expect(await service.discardRecovery('rec-old')).toBe(true)
      expect(store.deleteSession).toHaveBeenCalledWith('rec-old')
      expect(store.sessions).toHaveLength(0)
      expect(store.lines).toHaveLength(0)
    })

    it('resets to idle only when discarding the currently active session', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession({ sessionId: 'rec-other' }))
      const service = new RecordingService(store as never)
      await service.start()
      await service.discardRecovery('rec-other')
      expect(service.getSnapshot().state).toBe('recording')

      await service.discardRecovery(service.getSnapshot().activeSessionId!)
      expect(service.getSnapshot()).toMatchObject({ state: 'idle', activeSessionId: null })
    })

    it('fails closed on a storage error without claiming success', async () => {
      const store = fakeStore()
      store.sessions.push(unfinishedSession())
      store.deleteSession.mockRejectedValueOnce(new Error('delete failed'))
      const service = new RecordingService(store as never)
      expect(await service.discardRecovery('rec-old')).toBe(false)
      expect(store.sessions).toHaveLength(1)
      expect(service.getSnapshot().recoveryWarning).toContain('Could not discard')
    })
  })
})
