import { describe, expect, it, vi } from 'vitest'
import { SerialGnssService } from '../serialGnssService'

const VALID_GGA = '$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*44'

// Tiny, injected reconnect delays (see SerialGnssService's constructor
// options) so reconnect tests never wait out the real 1s/2s/4s/8s production
// schedule -- see task section 25: "do not require real WebSerial hardware"
// and section 6: bounded retry must be provable without wall-clock waits.
// Staleness disabled (a huge stallTimeoutMs) for tests that aren't
// specifically exercising Class D -- otherwise ordinary test overhead (a
// vi.waitFor poll, several awaits) can exceed a tiny threshold and flip the
// connection to 'stalled' mid-assertion for reasons unrelated to what the
// test is actually proving.
const FAST_RECONNECT = { reconnectDelaysMs: [5, 5, 5], stallTimeoutMs: 60_000, stallCheckIntervalMs: 1000 }
const STALL_DETECTION = { reconnectDelaysMs: [5, 5, 5], stallTimeoutMs: 100, stallCheckIntervalMs: 20 }

class FakePort {
  readable: ReadableStream<Uint8Array> | null = null
  controller: ReadableStreamDefaultController<Uint8Array> | null = null
  openCount = 0
  open = vi.fn(async () => {
    this.openCount += 1
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller },
      cancel: () => { this.controller = null },
    })
  })
  close = vi.fn(async () => { this.readable = null })
  getInfo = () => ({})
  send(text: string) { this.controller?.enqueue(new TextEncoder().encode(text)) }
  /** Simulates Class B: the stream rejects (e.g. a genuine read error). */
  errorStream(error: Error) { this.controller?.error(error) }
  /** Simulates Class B: the stream ends without an explicit disconnect event. */
  endStream() { this.controller?.close() }
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

describe('SerialGnssService', () => {
  it('connects with the authoritative default and disconnects cleanly', async () => {
    const port = new FakePort()
    const serial = fakeSerial(port)
    const service = new SerialGnssService(serial as never)
    await service.connect()
    expect(port.open).toHaveBeenCalledWith({ baudRate: 115200, bufferSize: 4096 })
    expect(service.getSnapshot().connectionState).toBe('connected')
    await service.disconnect()
    expect(port.close).toHaveBeenCalledOnce()
    expect(service.getSnapshot()).toMatchObject({ connectionState: 'disconnected', currentFix: null })
  })

  it('reports picker/open failures without claiming a connection', async () => {
    const port = new FakePort()
    const serial = fakeSerial(port)
    serial.requestPort.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'NotFoundError' }))
    const service = new SerialGnssService(serial as never)
    await service.connect()
    expect(service.getSnapshot()).toMatchObject({ connectionState: 'error', message: 'No serial port was selected.' })
  })

  it('streams representative NMEA through the existing parser with HDOP/satellites and tolerates malformed lines', async () => {
    const port = new FakePort()
    const service = new SerialGnssService(fakeSerial(port) as never)
    await service.connect()
    port.send(`logger prefix ${VALID_GGA}\r\n$GNGGA,bad\r\n`)
    await vi.waitFor(() => expect(service.getSnapshot().lineCount).toBe(2))
    expect(service.getSnapshot().currentFix).toMatchObject({
      fixQuality: 2,
      satellites: 14,
      hdop: 0.9,
    })
    expect(service.getSnapshot().currentFix?.lat).toBeCloseTo(34.6545083, 7)
    expect(service.getSnapshot().currentFix?.lon).toBeCloseTo(135.8306833, 7)
    await vi.waitFor(() => expect(service.getSnapshot().malformedLineCount).toBe(1))
    await service.disconnect()
  })

  it('does not duplicate delivery when the same subscriber is registered twice', async () => {
    const port = new FakePort()
    const service = new SerialGnssService(fakeSerial(port) as never)
    const listener = vi.fn()
    service.subscribeLines(listener)
    service.subscribeLines(listener)
    await service.connect()
    port.send(`${VALID_GGA}\n`)
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())
    await service.disconnect()
  })

  it('marks an OS device disconnect, clears the live fix, and automatically reconnects to the same port', async () => {
    const port = new FakePort()
    const serial = fakeSerial(port)
    const service = new SerialGnssService(serial as never, FAST_RECONNECT)
    await service.connect()
    port.send(`${VALID_GGA}\n`)
    await vi.waitFor(() => expect(service.getSnapshot().currentFix).not.toBeNull())

    // A real physical disconnect both fires the device event and errors the
    // in-flight stream -- reproduce both so the old read loop's pending
    // read() actually resolves instead of dangling forever in the fake.
    serial.disconnect()
    port.errorStream(new Error('device removed'))
    await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('reconnecting'))
    expect(service.getSnapshot()).toMatchObject({ currentFix: null, reconnectAttempt: 1, reconnectMaxAttempts: 3 })

    // The fake port's open() always succeeds by default, so the very next
    // bounded attempt (5ms later) reconnects without any user action.
    await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('connected'))
    expect(service.getSnapshot()).toMatchObject({ reconnectAttempt: 0, reconnectMaxAttempts: 0 })
    expect(port.openCount).toBe(2)

    // Proves no duplicate reader survived: a single sentence increments
    // lineCount by exactly one, not two.
    const before = service.getSnapshot().lineCount
    port.send(`${VALID_GGA}\n`)
    await vi.waitFor(() => expect(service.getSnapshot().lineCount).toBe(before + 1))
  })

  it('a read-loop failure (stream ends without a device event) triggers the same bounded reconnect', async () => {
    const port = new FakePort()
    const service = new SerialGnssService(fakeSerial(port) as never, FAST_RECONNECT)
    await service.connect()
    port.endStream()
    await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('reconnecting'), { interval: 1 })
    await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('connected'))
    expect(port.openCount).toBe(2)
  })

  it('reader.read() rejecting is also treated as transport loss, not a permanent unrecoverable error', async () => {
    const port = new FakePort()
    const service = new SerialGnssService(fakeSerial(port) as never, FAST_RECONNECT)
    await service.connect()
    port.errorStream(new Error('USB bus reset'))
    await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('reconnecting'), { interval: 1 })
    await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('connected'))
  })

  it('malformed NMEA never triggers a reconnect -- Class C is parser-level, not transport-level', async () => {
    const port = new FakePort()
    const service = new SerialGnssService(fakeSerial(port) as never, FAST_RECONNECT)
    await service.connect()
    port.send('$GNGGA,bad\r\n')
    await vi.waitFor(() => expect(service.getSnapshot().malformedLineCount).toBe(1))
    expect(service.getSnapshot().connectionState).toBe('connected')
  })

  it('exhausts bounded automatic attempts into reconnect_required, then a manual Reconnect still succeeds', async () => {
    const port = new FakePort()
    const serial = fakeSerial(port)
    const service = new SerialGnssService(serial as never, FAST_RECONNECT)
    await service.connect()
    expect(port.openCount).toBe(1)

    port.open.mockRejectedValueOnce(new Error('still unplugged'))
    port.open.mockRejectedValueOnce(new Error('still unplugged'))
    port.open.mockRejectedValueOnce(new Error('still unplugged'))
    serial.disconnect()
    port.errorStream(new Error('device removed'))

    await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('reconnect_required'), { timeout: 2000 })
    expect(service.getSnapshot()).toMatchObject({ message: 'Automatic reconnect unsuccessful.', reconnectAttempt: 3, reconnectMaxAttempts: 3 })
    // Never flips back to "reconnecting…" forever -- task section 22.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(service.getSnapshot().connectionState).toBe('reconnect_required')

    // The explicit escape hatch (task section 7) always remains available.
    await service.connect()
    expect(service.getSnapshot().connectionState).toBe('connected')
  })

  it('a manual disconnect while reconnecting cancels the pending attempt instead of racing it', async () => {
    const port = new FakePort()
    const serial = fakeSerial(port)
    const service = new SerialGnssService(serial as never, FAST_RECONNECT)
    await service.connect()
    port.open.mockRejectedValueOnce(new Error('still unplugged'))
    serial.disconnect()
    port.errorStream(new Error('device removed'))
    await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('reconnecting'))

    await service.disconnect()
    expect(service.getSnapshot().connectionState).toBe('disconnected')

    // Long enough that every configured attempt would have fired if the
    // pending timer had not actually been cancelled.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(service.getSnapshot().connectionState).toBe('disconnected')
  })

  it('a manual connect while reconnecting supersedes the pending automatic attempt without double-opening', async () => {
    const port = new FakePort()
    const serial = fakeSerial(port)
    const service = new SerialGnssService(serial as never, FAST_RECONNECT)
    await service.connect()
    serial.disconnect()
    port.errorStream(new Error('device removed'))
    await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('reconnecting'))

    // Manual connect immediately, before the 5ms automatic attempt fires.
    await service.connect()
    expect(service.getSnapshot().connectionState).toBe('connected')

    // Give the stale scheduled attempt's timer window time to elapse; it
    // must not have opened the port a second time or flipped the state.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(service.getSnapshot().connectionState).toBe('connected')
    expect(port.openCount).toBe(2) // initial connect + the manual reconnect only
  })

  it('survives multiple disconnect/reconnect cycles without ever duplicating the reader', async () => {
    const port = new FakePort()
    const serial = fakeSerial(port)
    const service = new SerialGnssService(serial as never, FAST_RECONNECT)
    await service.connect()

    for (let cycle = 0; cycle < 3; cycle += 1) {
      serial.disconnect()
      port.errorStream(new Error(`cycle ${cycle} removed`))
      await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('reconnecting'))
      await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('connected'))
    }

    const before = service.getSnapshot().lineCount
    port.send(`${VALID_GGA}\n`)
    await vi.waitFor(() => expect(service.getSnapshot().lineCount).toBe(before + 1))
    expect(port.openCount).toBe(4) // 1 initial + 3 successful reconnects
  })

  it('flags a stalled connection when data stops arriving, and clears it once data resumes', async () => {
    const port = new FakePort()
    const service = new SerialGnssService(fakeSerial(port) as never, STALL_DETECTION)
    await service.connect()
    port.send(`${VALID_GGA}\n`)
    await vi.waitFor(() => expect(service.getSnapshot().lineCount).toBe(1))

    // No further bytes at all -- Class D, not a transport failure. The port
    // is never closed or reopened for this: connectionState must never
    // become 'reconnecting' or 'reconnect_required' from staleness alone.
    await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('stalled'), { timeout: 2000 })
    expect(port.open).toHaveBeenCalledTimes(1)
    expect(port.close).not.toHaveBeenCalled()

    port.send(`${VALID_GGA}\n`)
    await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('connected'))
  })

  it('an explicit user disconnect never schedules an automatic reconnect', async () => {
    const port = new FakePort()
    const service = new SerialGnssService(fakeSerial(port) as never, FAST_RECONNECT)
    await service.connect()
    await service.disconnect()
    expect(service.getSnapshot().connectionState).toBe('disconnected')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(service.getSnapshot().connectionState).toBe('disconnected')
    expect(port.open).toHaveBeenCalledOnce()
  })
})
