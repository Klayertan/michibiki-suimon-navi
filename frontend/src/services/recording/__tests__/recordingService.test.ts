import { describe, expect, it, vi } from 'vitest'
import { QuotaExceededStorageError } from '@legacy/recording/recording-store.js'
import { RecordingService } from '../recordingService'
import type { GnssLineEvent } from '../../gnss/serialGnssService'

function fakeStore() {
  return {
    unfinished: [] as Array<{ sessionId: string }>,
    sessions: [] as Array<Record<string, unknown>>,
    lines: [] as Array<Record<string, unknown>>,
    fixes: [] as Array<Record<string, unknown>>,
    listUnfinishedSessions: vi.fn(async function (this: { unfinished: Array<{ sessionId: string }> }) { return this.unfinished }),
    createSession: vi.fn(async function (this: { sessions: Array<Record<string, unknown>> }, session: Record<string, unknown>) { this.sessions.push(session) }),
    updateSession: vi.fn(async function (this: { sessions: Array<Record<string, unknown>> }, id: string, patch: Record<string, unknown>) {
      const session = this.sessions.find((candidate) => candidate.sessionId === id)
      if (session) Object.assign(session, patch)
    }),
    appendRawLines: vi.fn(async function (this: { lines: Array<Record<string, unknown>> }, _id: string, lines: Array<Record<string, unknown>>) { this.lines.push(...lines) }),
    appendStructuredFixes: vi.fn(async function (this: { fixes: Array<Record<string, unknown>> }, _id: string, fixes: Array<Record<string, unknown>>) { this.fixes.push(...fixes) }),
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

describe('RecordingService', () => {
  it('starts with the exact legacy session shape, appends incrementally, and stops', async () => {
    const store = fakeStore()
    const service = new RecordingService(store as never)
    service.setConnectionMeta({ connectionState: 'connected', currentFix: event(1).point, baudRate: 115200, lineCount: 0, malformedLineCount: 0, message: null, transportLabel: 'Bluetooth SPP' })
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

  it('blocks a new session while an unfinished legacy recording exists', async () => {
    const store = fakeStore()
    store.unfinished.push({ sessionId: 'rec-old' })
    const service = new RecordingService(store as never)
    expect(await service.start()).toBe(false)
    expect(service.getSnapshot().error).toContain('unfinished legacy recording')
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
    service.setConnectionMeta({ connectionState: 'disconnected', currentFix: null, baudRate: 115200, lineCount: 1, malformedLineCount: 0, message: null, transportLabel: null })
    expect(service.getSnapshot()).toMatchObject({ state: 'recording', pointCount: 1 })
    expect(service.getSnapshot().warning).toContain('no stale or synthetic points')
  })
})
