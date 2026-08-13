import { describe, expect, it, vi } from 'vitest'
import { SerialGnssService } from '../serialGnssService'
import { RecordingService } from '../../recording/recordingService'

/**
 * Stage 5B, task sections 9/27/28: proves the two decoupled services
 * (SerialGnssService's line events -> RecordingService.ingest(), exactly the
 * wiring useGnssRuntime.ts installs at the app root) survive real disconnect/
 * reconnect cycles with no schema/store involved -- a plain fake store here,
 * since the guarantee under test is sequence/continuity logic, not
 * persistence (that is Playwright's job against real IndexedDB).
 */
const VALID_GGA = '$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*44'
const FAST_RECONNECT = { reconnectDelaysMs: [5, 5], stallTimeoutMs: 60_000, stallCheckIntervalMs: 1000 }

class FakePort {
  readable: ReadableStream<Uint8Array> | null = null
  controller: ReadableStreamDefaultController<Uint8Array> | null = null
  open = vi.fn(async () => {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller },
      cancel: () => { this.controller = null },
    })
  })
  close = vi.fn(async () => { this.readable = null })
  getInfo = () => ({})
  send(text: string) { this.controller?.enqueue(new TextEncoder().encode(text)) }
  errorStream(error: Error) { this.controller?.error(error) }
}

function fakeSerial(port: FakePort) {
  const disconnectListeners = new Set<(event: Event) => void>()
  return {
    getPorts: vi.fn(async () => []),
    requestPort: vi.fn(async () => port),
    addEventListener: vi.fn((_type: string, listener: (event: Event) => void) => disconnectListeners.add(listener)),
    disconnect: () => disconnectListeners.forEach((listener) => listener({ target: port } as unknown as Event)),
  }
}

function fakeRecordingStore() {
  const state = { sessions: [] as Array<Record<string, unknown>>, lines: [] as Array<Record<string, unknown>>, fixes: [] as Array<Record<string, unknown>> }
  return {
    ...state,
    listUnfinishedSessions: vi.fn(async function (this: typeof state) { return this.sessions.filter((s) => s.status === 'recording') }),
    getSession: vi.fn(async function (this: typeof state, id: string) { return this.sessions.find((s) => s.sessionId === id) }),
    getMaxSeq: vi.fn(async function (this: typeof state, id: string) {
      const seqs = [...this.lines, ...this.fixes].filter((r) => r.sessionId === id).map((r) => (r.seq as number) || 0)
      return seqs.length ? Math.max(...seqs) : 0
    }),
    countRawLines: vi.fn(async function (this: typeof state, id: string) { return this.lines.filter((l) => l.sessionId === id).length }),
    createSession: vi.fn(async function (this: typeof state, session: Record<string, unknown>) { this.sessions.push(session) }),
    updateSession: vi.fn(async function (this: typeof state, id: string, patch: Record<string, unknown>) {
      const session = this.sessions.find((s) => s.sessionId === id)
      if (session) Object.assign(session, patch)
    }),
    appendRawLines: vi.fn(async function (this: typeof state, id: string, lines: Array<Record<string, unknown>>) {
      this.lines.push(...lines.map((line) => ({ ...line, sessionId: id })))
    }),
    appendStructuredFixes: vi.fn(async function (this: typeof state, id: string, fixes: Array<Record<string, unknown>>) {
      this.fixes.push(...fixes.map((fix) => ({ ...fix, sessionId: id })))
    }),
    deleteSession: vi.fn(async function (this: typeof state, id: string) {
      this.sessions = this.sessions.filter((s) => s.sessionId !== id)
    }),
  }
}

function wire(serial: SerialGnssService, recording: RecordingService) {
  // Mirrors useGnssRuntime.ts's own wiring exactly.
  return serial.subscribeLines((event) => recording.ingest(event))
}

describe('GNSS reconnect + recording continuity integration', () => {
  it('records one session with monotonic, non-duplicated sequence numbers across a repeated disconnect/reconnect while recording', async () => {
    const port = new FakePort()
    const serial = new SerialGnssService(fakeSerial(port) as never, FAST_RECONNECT)
    const store = fakeRecordingStore()
    const recording = new RecordingService(store as never)
    wire(serial, recording)
    recording.setConnectionMeta(serial.getSnapshot())
    const unsubscribeState = serial.subscribe(() => recording.setConnectionMeta(serial.getSnapshot()))

    await serial.connect()
    expect(await recording.start()).toBe(true)
    const sessionId = recording.getSnapshot().activeSessionId!

    port.send(`${VALID_GGA}\n`)
    await vi.waitFor(() => expect(recording.getSnapshot().pointCount).toBe(1))

    // Cycle 1: transport loss while recording -- no fabricated/duplicated
    // points, session stays open, warning reflects the interruption.
    port.errorStream(new Error('cycle 1 lost'))
    await vi.waitFor(() => expect(serial.getSnapshot().connectionState).toBe('reconnecting'), { interval: 1 })
    expect(recording.getSnapshot()).toMatchObject({ state: 'recording', activeSessionId: sessionId, pointCount: 1 })
    expect(recording.getSnapshot().warning).toContain('Recording remains open')
    await vi.waitFor(() => expect(serial.getSnapshot().connectionState).toBe('connected'))
    port.send(`${VALID_GGA}\n`)
    await vi.waitFor(() => expect(recording.getSnapshot().pointCount).toBe(2))

    // Cycle 2: prove this isn't a one-shot fluke -- same session, more points.
    port.errorStream(new Error('cycle 2 lost'))
    await vi.waitFor(() => expect(serial.getSnapshot().connectionState).toBe('reconnecting'), { interval: 1 })
    await vi.waitFor(() => expect(serial.getSnapshot().connectionState).toBe('connected'))
    port.send(`${VALID_GGA}\n`)
    await vi.waitFor(() => expect(recording.getSnapshot().pointCount).toBe(3))

    expect(await recording.stop()).toBe(true)
    expect(recording.getSnapshot()).toMatchObject({ state: 'stopped', activeSessionId: sessionId })
    unsubscribeState()

    // One session throughout -- never a second one created by a reconnect.
    expect(store.sessions).toHaveLength(1)
    expect(store.sessions[0]).toMatchObject({ sessionId, status: 'stopped' })

    const seqValues = [...store.lines, ...store.fixes].map((record) => record.seq as number).sort((a, b) => a - b)
    expect(new Set(seqValues).size).toBe(seqValues.length) // no duplicate seq
    seqValues.forEach((value, index) => { if (index > 0) expect(value).toBeGreaterThan(seqValues[index - 1]) }) // strictly increasing
    // 3 lines + 3 fixes (every sentence carries a fix here) = 6 records.
    expect(store.lines.length + store.fixes.length).toBe(6)
  })

  it('lets Stop Recording finalize normally while GNSS is disconnected/reconnecting -- it never waits for the link', async () => {
    const port = new FakePort()
    const serial = new SerialGnssService(fakeSerial(port) as never, FAST_RECONNECT)
    const store = fakeRecordingStore()
    const recording = new RecordingService(store as never)
    wire(serial, recording)
    const unsubscribeState = serial.subscribe(() => recording.setConnectionMeta(serial.getSnapshot()))

    await serial.connect()
    expect(await recording.start()).toBe(true)
    port.send(`${VALID_GGA}\n`)
    await vi.waitFor(() => expect(recording.getSnapshot().pointCount).toBe(1))

    port.errorStream(new Error('lost mid-recording'))
    await vi.waitFor(() => expect(serial.getSnapshot().connectionState).toBe('reconnecting'), { interval: 1 })

    // Stop must succeed immediately -- no fabricated final fix, no hang.
    expect(await recording.stop()).toBe(true)
    expect(recording.getSnapshot()).toMatchObject({ state: 'stopped', pointCount: 1 })
    expect(store.sessions[0]).toMatchObject({ status: 'stopped', validFixCount: 1 })
    unsubscribeState()
  })
})
