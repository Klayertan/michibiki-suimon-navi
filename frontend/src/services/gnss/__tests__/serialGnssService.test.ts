import { describe, expect, it, vi } from 'vitest'
import { SerialGnssService } from '../serialGnssService'

const VALID_GGA = '$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*44'

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

  it('marks an OS device disconnect and clears the live fix', async () => {
    const port = new FakePort()
    const serial = fakeSerial(port)
    const service = new SerialGnssService(serial as never)
    await service.connect()
    port.send(`${VALID_GGA}\n`)
    await vi.waitFor(() => expect(service.getSnapshot().currentFix).not.toBeNull())
    serial.disconnect()
    await vi.waitFor(() => expect(service.getSnapshot().connectionState).toBe('disconnected'))
    expect(service.getSnapshot().currentFix).toBeNull()
  })
})
