import { parseNmeaSession } from '@legacy/gnss/nmea-parser.js'
import { adaptGnssPoint } from '../../domain/surveys/adapters'
import type { GnssPoint } from '../../domain/surveys/types'

export const SERIAL_BAUD_RATES = [4800, 9600, 38400, 115200] as const
export const DEFAULT_SERIAL_BAUD_RATE = 115200
const READ_BUFFER_LIMIT = 8192

export type GnssConnectionState =
  | 'unsupported'
  | 'disconnected'
  | 'requesting'
  | 'opening'
  | 'connected'
  | 'stalled'
  | 'disconnecting'
  | 'error'

export interface LiveGnssFix extends GnssPoint {
  receivedAtMs: number
  rawLine: string
}

export interface GnssSerialSnapshot {
  connectionState: GnssConnectionState
  currentFix: LiveGnssFix | null
  baudRate: number
  lineCount: number
  malformedLineCount: number
  message: string | null
  transportLabel: string | null
}

export interface GnssLineEvent {
  rawLine: string
  point: LiveGnssFix | null
  looksLikeGga: boolean
  noFix: boolean
  malformed: boolean
}

interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null
  open(options: { baudRate: number; bufferSize: number }): Promise<void>
  close(): Promise<void>
  getInfo?(): { usbVendorId?: number; bluetoothServiceClassId?: unknown }
}

interface SerialLike {
  getPorts(): Promise<SerialPortLike[]>
  requestPort(): Promise<SerialPortLike>
  addEventListener?(type: 'disconnect', listener: (event: Event) => void): void
}

type StateListener = () => void
type LineListener = (event: GnssLineEvent) => void

function serialFromNavigator(): SerialLike | null {
  return (navigator as Navigator & { serial?: SerialLike }).serial ?? null
}

function transportLabel(port: SerialPortLike): string {
  try {
    const info = port.getInfo?.() ?? {}
    if (Number.isFinite(info.usbVendorId)) return `USB serial (VID 0x${info.usbVendorId!.toString(16).padStart(4, '0')})`
    if (info.bluetoothServiceClassId !== undefined) return 'Bluetooth SPP virtual port'
  } catch {
    // Display metadata is optional; failure must not block the connection.
  }
  return 'Serial port (USB or Bluetooth SPP)'
}

export class SerialGnssService {
  private readonly serial: SerialLike | null
  private readonly stateListeners = new Set<StateListener>()
  private readonly lineListeners = new Set<LineListener>()
  private snapshot: GnssSerialSnapshot
  private port: SerialPortLike | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private readLoopPromise: Promise<void> | null = null
  private disconnecting = false

  constructor(serial: SerialLike | null = serialFromNavigator()) {
    this.serial = serial
    this.snapshot = {
      connectionState: serial ? 'disconnected' : 'unsupported',
      currentFix: null,
      baudRate: DEFAULT_SERIAL_BAUD_RATE,
      lineCount: 0,
      malformedLineCount: 0,
      message: serial ? null : 'WebSerial requires desktop Chrome or Edge on HTTPS or localhost.',
      transportLabel: null,
    }
    this.serial?.addEventListener?.('disconnect', (event) => {
      if (this.port && (event.target as unknown) === this.port) void this.disconnect('The serial device disconnected.')
    })
  }

  subscribe = (listener: StateListener): (() => void) => {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  subscribeLines(listener: LineListener): () => void {
    this.lineListeners.add(listener)
    return () => this.lineListeners.delete(listener)
  }

  getSnapshot = (): GnssSerialSnapshot => this.snapshot

  setBaudRate(baudRate: number): void {
    if (this.snapshot.connectionState !== 'disconnected' || !SERIAL_BAUD_RATES.includes(baudRate as never)) return
    this.update({ baudRate })
  }

  async connect(): Promise<void> {
    if (!this.serial) {
      this.update({ connectionState: 'unsupported' })
      return
    }
    if (this.snapshot.connectionState === 'connected' || this.snapshot.connectionState === 'opening') return

    let selected: SerialPortLike | null = null
    try {
      const granted = await this.serial.getPorts().catch(() => [])
      for (const candidate of granted) {
        if (await this.tryOpen(candidate, true)) return
      }
      this.update({ connectionState: 'requesting', message: null })
      selected = await this.serial.requestPort()
      await this.tryOpen(selected, false)
    } catch (error) {
      const message = error instanceof Error && error.name === 'NotFoundError'
        ? 'No serial port was selected.'
        : `Could not connect to GNSS: ${error instanceof Error ? error.message : String(error)}`
      this.update({ connectionState: 'error', currentFix: null, message })
    }
  }

  async disconnect(message: string | null = null): Promise<void> {
    if (this.disconnecting) return
    this.disconnecting = true
    this.update({ connectionState: 'disconnecting', currentFix: null })
    try {
      await this.reader?.cancel().catch(() => undefined)
      await this.readLoopPromise?.catch(() => undefined)
      await this.port?.close().catch(() => undefined)
    } finally {
      this.reader = null
      this.readLoopPromise = null
      this.port = null
      this.disconnecting = false
      this.update({ connectionState: 'disconnected', currentFix: null, transportLabel: null, message })
    }
  }

  private async tryOpen(port: SerialPortLike, silent: boolean): Promise<boolean> {
    this.update({ connectionState: 'opening', message: null })
    try {
      await port.open({ baudRate: this.snapshot.baudRate, bufferSize: 4096 })
    } catch (error) {
      if (!silent) throw error
      this.update({ connectionState: 'disconnected' })
      return false
    }
    this.port = port
    this.update({ connectionState: 'connected', transportLabel: transportLabel(port), message: null })
    this.readLoopPromise = this.readLoop(port)
    return true
  }

  private async readLoop(port: SerialPortLike): Promise<void> {
    if (!port.readable) {
      this.update({ connectionState: 'error', currentFix: null, message: 'The selected serial port has no readable stream.' })
      return
    }
    this.reader = port.readable.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    try {
      while (this.port === port && !this.disconnecting) {
        const { value, done } = await this.reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r\n|\r|\n/)
        buffer = lines.pop() ?? ''
        if (buffer.length > READ_BUFFER_LIMIT) {
          buffer = buffer.slice(-256)
          this.update({ message: 'Received data without line endings; check the baud rate and device.' })
        }
        for (const line of lines) this.handleLine(line)
      }
    } catch (error) {
      if (!this.disconnecting) {
        this.update({ connectionState: 'error', currentFix: null, message: `GNSS receive error: ${error instanceof Error ? error.message : String(error)}` })
      }
    } finally {
      this.reader?.releaseLock()
      this.reader = null
      if (!this.disconnecting && this.port === port) {
        this.port = null
        await port.close().catch(() => undefined)
        this.update({ connectionState: 'disconnected', currentFix: null, transportLabel: null, message: 'The serial stream ended. Reconnect to continue.' })
      }
    }
  }

  private handleLine(rawInput: string): void {
    let rawLine = rawInput.trim()
    if (!rawLine) return
    const dollarIndex = rawLine.indexOf('$G')
    if (dollarIndex > 0) rawLine = rawLine.slice(dollarIndex)
    const looksLikeGga = /^\$G[A-Z0-9]GGA,/i.test(rawLine)
    let point: LiveGnssFix | null = null
    let noFix = false
    let malformed = false
    if (looksLikeGga) {
      // The authoritative legacy live path rejects truncated GGA frames
      // before parsing; keep that framing guard while delegating all actual
      // NMEA field interpretation to parseNmeaSession.
      if (rawLine.split('*')[0].split(',').length < 10) {
        malformed = true
      } else try {
        const parsed = parseNmeaSession(rawLine)
        const observation = parsed.observations[0]
        noFix = Boolean(observation && observation.fixValid === false)
        const adapted = adaptGnssPoint(observation, `live-${this.snapshot.lineCount + 1}`)
        if (adapted && observation?.fixValid !== false) {
          point = { ...adapted, fixValid: true, receivedAtMs: Date.now(), rawLine }
        } else if (!noFix) {
          malformed = true
        }
      } catch {
        malformed = true
      }
    }
    this.update({
      lineCount: this.snapshot.lineCount + 1,
      malformedLineCount: this.snapshot.malformedLineCount + (malformed ? 1 : 0),
      currentFix: point ?? this.snapshot.currentFix,
      message: malformed ? 'A malformed NMEA sentence was ignored.' : this.snapshot.message,
    })
    const event = { rawLine, point, looksLikeGga, noFix, malformed }
    this.lineListeners.forEach((listener) => listener(event))
  }

  private update(patch: Partial<GnssSerialSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.stateListeners.forEach((listener) => listener())
  }
}

export const serialGnssService = new SerialGnssService()
