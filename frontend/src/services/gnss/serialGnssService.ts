import { parseNmeaSession } from '@legacy/gnss/nmea-parser.js'
import { DEFAULT_DIAGNOSTIC_THRESHOLDS_MS } from '@legacy/recording/recording-core.js'
import { adaptGnssPoint } from '../../domain/surveys/adapters'
import type { GnssPoint } from '../../domain/surveys/types'

export const SERIAL_BAUD_RATES = [4800, 9600, 38400, 115200] as const
export const DEFAULT_SERIAL_BAUD_RATE = 115200
const READ_BUFFER_LIMIT = 8192

// Bounded, capped-exponential automatic reconnect (Stage 5B, task section 6):
// four attempts at 1s/2s/4s/8s (worst case ~15s before giving up), chosen to
// be conservative enough not to hammer the device while still recovering
// from a brief cable wiggle within a few seconds. Reusing an arbitrary
// number here was explicitly disallowed by the task brief, so this is
// injectable (see the constructor) precisely so tests never have to wait out
// real wall-clock delays to prove the bound is real.
export const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000]

// "Stalled" (task section 3D: port open, but no usable data) reuses the
// existing legacy byte-level stall threshold rather than inventing a new
// number -- see js/recording/recording-core.js's classifySerialDiagnostics.
// Byte-level (any received chunk), not line- or fix-level: the coarsest,
// most conservative signal, matching the diagnostic system's own first tier.
export const DEFAULT_STALL_TIMEOUT_MS = DEFAULT_DIAGNOSTIC_THRESHOLDS_MS.byteStallMs

export type GnssConnectionState =
  | 'unsupported'
  | 'disconnected'
  | 'requesting'
  | 'opening'
  | 'connected'
  | 'stalled'
  | 'reconnecting'
  | 'reconnect_required'
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
  /** 1-based index of the automatic reconnect attempt in flight; 0 when not reconnecting. */
  reconnectAttempt: number
  /** Total bounded attempts configured for this service instance; 0 when not applicable. */
  reconnectMaxAttempts: number
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
  private readonly reconnectDelaysMs: number[]
  private readonly stallTimeoutMs: number
  private readonly stallCheckIntervalMs: number
  private snapshot: GnssSerialSnapshot
  private port: SerialPortLike | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private readLoopPromise: Promise<void> | null = null
  private disconnecting = false

  // --- Stage 5B: bounded automatic reconnect (task sections 5-7, 17-18) ---
  // The last port a connection actually succeeded on -- and the *only* port
  // automatic reconnect is ever allowed to retry. Automatic reconnect never
  // calls getPorts()/requestPort() itself, so it can never silently pick a
  // different granted device and never triggers a permission prompt.
  private lastPort: SerialPortLike | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  // Incremented by every manual connect()/disconnect() call and by every new
  // transport-loss episode. A scheduled reconnect attempt captures the
  // generation it was scheduled under and checks it again once its delay (and
  // then its own await port.open()) elapses -- if a manual action happened in
  // the meantime, the attempt is stale and no-ops instead of racing it.
  private currentGeneration = 0

  // --- Stage 5B: "stalled" data watchdog (task section 3D) ---
  private dataWatchdogTimer: ReturnType<typeof setInterval> | null = null
  private lastDataAtMs: number | null = null

  constructor(
    serial: SerialLike | null = serialFromNavigator(),
    options: { reconnectDelaysMs?: number[]; stallTimeoutMs?: number; stallCheckIntervalMs?: number } = {},
  ) {
    this.serial = serial
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
    this.stallCheckIntervalMs = options.stallCheckIntervalMs ?? 1000
    this.snapshot = {
      connectionState: serial ? 'disconnected' : 'unsupported',
      currentFix: null,
      baudRate: DEFAULT_SERIAL_BAUD_RATE,
      lineCount: 0,
      malformedLineCount: 0,
      message: serial ? null : 'WebSerial requires desktop Chrome or Edge on HTTPS or localhost.',
      transportLabel: null,
      reconnectAttempt: 0,
      reconnectMaxAttempts: 0,
    }
    // Class A (task section 3): a physical/device disconnect. This used to
    // call the same disconnect() a user-initiated click uses; it now routes
    // through handleTransportLoss() so a genuinely transient unplug gets the
    // bounded automatic retry instead of landing straight on "disconnected".
    this.serial?.addEventListener?.('disconnect', (event) => {
      if (this.port && (event.target as unknown) === this.port) this.handleTransportLoss('The serial device disconnected.')
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

  /**
   * Explicit connect (task section 4/7/17): tries every already-granted port
   * silently first -- unchanged from Stage 3B -- and only falls back to the
   * permission-prompting requestPort() if none of them open. Always available
   * as a manual escape hatch, including while an automatic reconnect is
   * pending or has been exhausted (`reconnecting` / `reconnect_required` are
   * not in the re-entry guard below), and always wins any race against a
   * pending automatic attempt via cancelPendingReconnect().
   */
  async connect(): Promise<void> {
    if (!this.serial) {
      this.update({ connectionState: 'unsupported' })
      return
    }
    if (this.snapshot.connectionState === 'connected' || this.snapshot.connectionState === 'opening') return
    this.cancelPendingReconnect()

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
      this.update({ connectionState: 'error', currentFix: null, message, reconnectAttempt: 0, reconnectMaxAttempts: 0 })
    }
  }

  /**
   * Explicit, user-initiated disconnect. Unlike a transport-loss episode,
   * this always lands on 'disconnected' and never triggers automatic
   * reconnect -- clearing `lastPort` means a later stray disconnect event or
   * read-loop rejection (there shouldn't be one, since the port is already
   * closed) has nothing to retry.
   */
  async disconnect(message: string | null = null): Promise<void> {
    if (this.disconnecting) return
    this.cancelPendingReconnect()
    this.lastPort = null
    this.stopDataWatchdog()
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
      this.update({ connectionState: 'disconnected', currentFix: null, transportLabel: null, message, reconnectAttempt: 0, reconnectMaxAttempts: 0 })
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
    this.onConnected(port)
    return true
  }

  private onConnected(port: SerialPortLike): void {
    this.port = port
    this.lastPort = port
    this.lastDataAtMs = Date.now()
    this.startDataWatchdog()
    this.update({ connectionState: 'connected', transportLabel: transportLabel(port), message: null, reconnectAttempt: 0, reconnectMaxAttempts: 0 })
    this.readLoopPromise = this.readLoop(port)
  }

  private cancelPendingReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.currentGeneration += 1
  }

  /**
   * Entry point for Class A (device disconnect event) and Class B (read-loop
   * failure) transport loss -- task section 3. Never called for Class C
   * (malformed NMEA, handled entirely inside handleLine/the parser) or a
   * user-initiated disconnect() (which clears `lastPort` first, so this path
   * has nothing to retry even if it somehow ran).
   */
  private handleTransportLoss(reason: string): void {
    this.stopDataWatchdog()
    this.reader = null
    this.readLoopPromise = null
    this.port = null
    this.currentGeneration += 1
    const generation = this.currentGeneration
    if (!this.lastPort) {
      this.update({ connectionState: 'disconnected', currentFix: null, transportLabel: null, message: reason, reconnectAttempt: 0, reconnectMaxAttempts: 0 })
      return
    }
    this.scheduleReconnect(reason, 0, generation)
  }

  /**
   * Bounded capped-exponential retry (task section 6) against `lastPort`
   * only -- never a different granted device (task section 18) and never
   * requestPort() (task section 4: no automatic permission prompts).
   */
  private scheduleReconnect(reason: string, attemptIndex: number, generation: number): void {
    if (attemptIndex >= this.reconnectDelaysMs.length) {
      this.update({
        connectionState: 'reconnect_required', currentFix: null, transportLabel: null,
        message: 'Automatic reconnect unsuccessful.',
        reconnectAttempt: this.reconnectDelaysMs.length, reconnectMaxAttempts: this.reconnectDelaysMs.length,
      })
      return
    }
    const delay = this.reconnectDelaysMs[attemptIndex]
    this.update({
      connectionState: 'reconnecting', currentFix: null, message: reason,
      reconnectAttempt: attemptIndex + 1, reconnectMaxAttempts: this.reconnectDelaysMs.length,
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.runReconnectAttempt(reason, attemptIndex, generation)
    }, delay)
  }

  private async runReconnectAttempt(reason: string, attemptIndex: number, generation: number): Promise<void> {
    if (generation !== this.currentGeneration || !this.lastPort) return
    const port = this.lastPort
    try {
      await port.open({ baudRate: this.snapshot.baudRate, bufferSize: 4096 })
    } catch {
      if (generation !== this.currentGeneration) return
      this.scheduleReconnect(reason, attemptIndex + 1, generation)
      return
    }
    if (generation !== this.currentGeneration) {
      // A manual connect()/disconnect() superseded this attempt while it was
      // opening -- close what was just opened rather than leaving a second
      // live port; whichever action is now authoritative already owns state.
      await port.close().catch(() => undefined)
      return
    }
    this.onConnected(port)
  }

  private startDataWatchdog(): void {
    this.stopDataWatchdog()
    this.dataWatchdogTimer = setInterval(() => {
      if (!this.port) return
      const age = this.lastDataAtMs === null ? Infinity : Date.now() - this.lastDataAtMs
      // Class D (task section 3): the port is open and the read loop is
      // healthy, but no byte has arrived recently -- distinct from Class A/B,
      // and deliberately NOT auto-retried: closing/reopening a port that is
      // fine wouldn't help a receiver that simply has no data to send (e.g.
      // no satellite lock indoors). Manual reconnect remains available.
      if (this.snapshot.connectionState === 'connected' && age > this.stallTimeoutMs) {
        this.update({ connectionState: 'stalled', message: 'No data received from the GNSS device recently.' })
      } else if (this.snapshot.connectionState === 'stalled' && age <= this.stallTimeoutMs) {
        this.update({ connectionState: 'connected', message: null })
      }
    }, this.stallCheckIntervalMs)
  }

  private stopDataWatchdog(): void {
    if (this.dataWatchdogTimer) {
      clearInterval(this.dataWatchdogTimer)
      this.dataWatchdogTimer = null
    }
  }

  private async readLoop(port: SerialPortLike): Promise<void> {
    if (!port.readable) {
      this.update({ connectionState: 'error', currentFix: null, message: 'The selected serial port has no readable stream.' })
      return
    }
    this.reader = port.readable.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    // Class B transport loss (task section 3): set below rather than acted on
    // immediately, so the single handleTransportLoss() call after the port is
    // actually closed is the only place that decides reconnect vs. give up.
    let transportLostReason: string | null = null
    try {
      while (this.port === port && !this.disconnecting) {
        const { value, done } = await this.reader.read()
        if (done) break
        this.lastDataAtMs = Date.now()
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
        transportLostReason = `GNSS receive error: ${error instanceof Error ? error.message : String(error)}`
      }
    } finally {
      this.reader?.releaseLock()
      this.reader = null
      if (!this.disconnecting && this.port === port) {
        this.port = null
        await port.close().catch(() => undefined)
        this.handleTransportLoss(transportLostReason ?? 'The serial stream ended. Reconnect to continue.')
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
