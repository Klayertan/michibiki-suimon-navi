import { describe, expect, it, vi } from 'vitest'
import { WakeLockService } from '../wakeLockService'

class FakeSentinel {
  released = false
  listeners = new Set<() => void>()
  release = vi.fn(async () => {
    if (this.released) return
    this.released = true
    this.listeners.forEach((listener) => listener())
  })
  addEventListener(_type: 'release', listener: () => void) { this.listeners.add(listener) }
  removeEventListener(_type: 'release', listener: () => void) { this.listeners.delete(listener) }
  /** Simulates the browser taking the lock away on its own (e.g. tab hidden). */
  simulateExternalRelease() {
    this.released = true
    this.listeners.forEach((listener) => listener())
  }
}

function fakeWakeLock(factory: () => FakeSentinel | Promise<FakeSentinel> = () => new FakeSentinel()) {
  return { request: vi.fn(async () => factory()) }
}

describe('WakeLockService', () => {
  it('reports unsupported when navigator.wakeLock is absent, and request() is a safe no-op', async () => {
    const service = new WakeLockService(null)
    expect(service.getSnapshot().state).toBe('unsupported')
    await service.request()
    expect(service.getSnapshot().state).toBe('unsupported')
  })

  it('requests the lock and transitions to active', async () => {
    const wakeLock = fakeWakeLock()
    const service = new WakeLockService(wakeLock)
    await service.request()
    expect(wakeLock.request).toHaveBeenCalledWith('screen')
    expect(service.getSnapshot()).toEqual({ state: 'active', error: null })
  })

  it('releases the lock and returns to idle', async () => {
    const sentinel = new FakeSentinel()
    const wakeLock = fakeWakeLock(() => sentinel)
    const service = new WakeLockService(wakeLock)
    await service.request()
    await service.release()
    expect(sentinel.release).toHaveBeenCalledOnce()
    expect(service.getSnapshot()).toEqual({ state: 'idle', error: null })
  })

  it('does not request a second time while already active or already requesting -- no redundant calls', async () => {
    const wakeLock = fakeWakeLock()
    const service = new WakeLockService(wakeLock)
    await service.request()
    await service.request()
    expect(wakeLock.request).toHaveBeenCalledOnce()
  })

  it('an unsolicited sentinel release updates state without releasing or re-requesting on its own', async () => {
    const sentinel = new FakeSentinel()
    const wakeLock = fakeWakeLock(() => sentinel)
    const service = new WakeLockService(wakeLock)
    await service.request()
    sentinel.simulateExternalRelease()
    expect(service.getSnapshot()).toEqual({ state: 'released', error: null })
    // The service itself never calls request() again -- that is exclusively
    // the runtime hook's job, driven by visibilitychange (task section 8/18).
    expect(wakeLock.request).toHaveBeenCalledOnce()
  })

  it('a request rejection is non-fatal: state becomes error, and a later request can still succeed', async () => {
    let shouldFail = true
    const wakeLock = {
      request: vi.fn(async () => {
        if (shouldFail) throw new Error('permission denied')
        return new FakeSentinel()
      }),
    }
    const service = new WakeLockService(wakeLock)
    await service.request()
    expect(service.getSnapshot()).toEqual({ state: 'error', error: 'permission denied' })

    shouldFail = false
    await service.request()
    expect(service.getSnapshot()).toEqual({ state: 'active', error: null })
  })

  it('release() during an in-flight request closes the sentinel instead of resurrecting an unwanted lock', async () => {
    const sentinel = new FakeSentinel()
    let resolveOpen: (value: FakeSentinel) => void = () => {}
    const wakeLock = { request: vi.fn(() => new Promise<FakeSentinel>((resolve) => { resolveOpen = resolve })) }
    const service = new WakeLockService(wakeLock)

    const requestPromise = service.request()
    await service.release() // caller changed its mind before the open() resolved
    resolveOpen(sentinel)
    await requestPromise

    expect(sentinel.release).toHaveBeenCalledOnce()
    expect(service.getSnapshot()).toEqual({ state: 'idle', error: null })
  })

  it('repeated request/release cycles never leak listeners -- an old sentinel releasing after a new cycle has no effect', async () => {
    const sentinelA = new FakeSentinel()
    const sentinelB = new FakeSentinel()
    let call = 0
    const wakeLock = fakeWakeLock(() => (call++ === 0 ? sentinelA : sentinelB))
    const service = new WakeLockService(wakeLock)

    await service.request()
    await service.release()
    await service.request() // second cycle, sentinelB now active

    const before = service.getSnapshot()
    sentinelA.simulateExternalRelease() // stale sentinel from cycle 1 -- must be inert
    expect(service.getSnapshot()).toEqual(before)
    expect(service.getSnapshot().state).toBe('active')
  })

  it('isWanted() reflects the caller\'s intent independent of transient failures', async () => {
    const wakeLock = { request: vi.fn(async () => { throw new Error('denied') }) }
    const service = new WakeLockService(wakeLock)
    expect(service.isWanted()).toBe(false)
    await service.request()
    expect(service.isWanted()).toBe(true) // still wanted even though the attempt failed
    await service.release()
    expect(service.isWanted()).toBe(false)
  })
})
