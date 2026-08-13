/**
 * Thin, testable wrapper around the standard Screen Wake Lock API
 * (`navigator.wakeLock.request("screen")`). Deliberately knows nothing about
 * recording, GNSS, or recovery -- callers (see useWakeLockRuntime.ts) decide
 * *when* to request/release; this service only tracks *whether* a lock is
 * currently held and surfaces failures without ever throwing.
 *
 * Screen Wake Lock can only ask the display to stay on. It cannot prevent OS
 * suspend, a laptop lid close, battery depletion, or the browser process
 * being killed -- nothing here claims otherwise, and nothing shells out to
 * platform power-management commands.
 */

export type WakeLockState = 'unsupported' | 'idle' | 'requesting' | 'active' | 'released' | 'error'

export interface WakeLockSnapshot {
  state: WakeLockState
  error: string | null
}

interface WakeLockSentinelLike {
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
  removeEventListener(type: 'release', listener: () => void): void
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>
}

type Listener = () => void

function wakeLockFromNavigator(): WakeLockLike | null {
  return (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock ?? null
}

export class WakeLockService {
  private readonly wakeLock: WakeLockLike | null
  private readonly listeners = new Set<Listener>()
  private snapshot: WakeLockSnapshot
  private sentinel: WakeLockSentinelLike | null = null
  private releaseListener: (() => void) | null = null
  // Whether the caller currently wants the lock held -- the sole input the
  // sentinel's own unsolicited "release" event is allowed to consult before
  // deciding whether re-requesting would even be desired; it never re-
  // requests itself (task section 8/18: no uncontrolled retry loop). Only
  // an explicit request()/release() call, or the runtime hook's own
  // visibilitychange-driven call to request(), changes this.
  private wanted = false
  // Generation guard: a request() in flight when release() is called (or a
  // new request() supersedes it) must not resurrect a lock the caller no
  // longer wants once its await resolves.
  private generation = 0

  constructor(wakeLock: WakeLockLike | null = wakeLockFromNavigator()) {
    this.wakeLock = wakeLock
    this.snapshot = { state: wakeLock ? 'idle' : 'unsupported', error: null }
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): WakeLockSnapshot => this.snapshot

  /** True once a genuine attempt to hold the lock is wanted -- used by the visibility handler to decide whether "visible again" should reacquire. */
  isWanted(): boolean {
    return this.wanted
  }

  async request(): Promise<void> {
    this.wanted = true
    if (!this.wakeLock) return // unsupported: stays 'unsupported' forever, never a fatal condition for the caller
    if (this.snapshot.state === 'active' || this.snapshot.state === 'requesting') return
    const generation = ++this.generation
    this.update({ state: 'requesting', error: null })
    let sentinel: WakeLockSentinelLike
    try {
      sentinel = await this.wakeLock.request('screen')
    } catch (error) {
      if (generation !== this.generation) return
      // Non-fatal by construction: the caller (recording) never learns of
      // this beyond an informational status -- task section 10.
      this.update({ state: 'error', error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (generation !== this.generation || !this.wanted) {
      // Superseded by a release()/newer request() while awaiting -- don't
      // resurrect a lock nobody wants anymore.
      await sentinel.release().catch(() => undefined)
      return
    }
    this.sentinel = sentinel
    this.releaseListener = () => {
      this.sentinel = null
      this.releaseListener = null
      // Only updates status. Never re-requests on its own, never touches
      // recording or GNSS -- task section 8.
      this.update({ state: 'released', error: null })
    }
    sentinel.addEventListener('release', this.releaseListener)
    this.update({ state: 'active', error: null })
  }

  async release(): Promise<void> {
    this.wanted = false
    this.generation += 1
    const sentinel = this.sentinel
    this.sentinel = null
    if (sentinel) {
      if (this.releaseListener) sentinel.removeEventListener('release', this.releaseListener)
      this.releaseListener = null
      await sentinel.release().catch(() => undefined)
    }
    if (this.snapshot.state !== 'unsupported') this.update({ state: 'idle', error: null })
  }

  private update(patch: Partial<WakeLockSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach((listener) => listener())
  }
}

export const wakeLockService = new WakeLockService()
