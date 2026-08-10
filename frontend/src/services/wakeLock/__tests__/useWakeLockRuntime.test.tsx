import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useWakeLockRuntime, publishWakeLockStatus } from '../useWakeLockRuntime'
import { recordingService, type RecordingSnapshot } from '../../recording/recordingService'
import { wakeLockService, type WakeLockSnapshot } from '../wakeLockService'
import { useSystemStatusStore } from '../../../store/useSystemStatusStore'

function recordingSnapshot(overrides: Partial<RecordingSnapshot> = {}): RecordingSnapshot {
  return {
    state: 'idle', activeSessionId: null, startedAt: null, pointCount: 0, lineCount: 0, pendingCount: 0,
    error: null, warning: null, recoverySessions: [], recoveryInProgress: false, recoveryWarning: null,
    ...overrides,
  }
}

function Harness() {
  useWakeLockRuntime()
  return null
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useWakeLockRuntime', () => {
  let listeners: Set<() => void>
  let currentSnapshot: RecordingSnapshot

  beforeEach(() => {
    listeners = new Set()
    currentSnapshot = recordingSnapshot()
    vi.spyOn(recordingService, 'getSnapshot').mockImplementation(() => currentSnapshot)
    vi.spyOn(recordingService, 'subscribe').mockImplementation((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    vi.spyOn(wakeLockService, 'request').mockResolvedValue(undefined)
    vi.spyOn(wakeLockService, 'release').mockResolvedValue(undefined)
    vi.spyOn(wakeLockService, 'getSnapshot').mockReturnValue({ state: 'idle', error: null })
    vi.spyOn(wakeLockService, 'subscribe').mockReturnValue(() => {})
    vi.spyOn(wakeLockService, 'isWanted').mockReturnValue(false)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  afterEach(() => vi.restoreAllMocks())

  function setRecording(next: Partial<RecordingSnapshot>) {
    currentSnapshot = recordingSnapshot(next)
    listeners.forEach((listener) => listener())
  }

  it('requests wake lock exactly once when recording starts', () => {
    render(<Harness />)
    expect(wakeLockService.request).not.toHaveBeenCalled()
    setRecording({ state: 'recording' })
    expect(wakeLockService.request).toHaveBeenCalledOnce()
  })

  it('releases wake lock when recording stops', () => {
    render(<Harness />)
    setRecording({ state: 'recording' })
    setRecording({ state: 'stopped' })
    expect(wakeLockService.release).toHaveBeenCalledOnce()
  })

  it('does not request repeatedly on every recording snapshot update while already recording -- no spam', () => {
    render(<Harness />)
    setRecording({ state: 'recording', pointCount: 1 })
    setRecording({ state: 'recording', pointCount: 2 })
    setRecording({ state: 'recording', pointCount: 3 })
    expect(wakeLockService.request).toHaveBeenCalledOnce()
  })

  it('never requests merely because Recovery Required is showing', () => {
    render(<Harness />)
    setRecording({ state: 'recovery_available', recoverySessions: [{ sessionId: 'rec-1' } as never] })
    expect(wakeLockService.request).not.toHaveBeenCalled()
  })

  it('requests once a recovered session is Resumed and becomes recording', () => {
    render(<Harness />)
    setRecording({ state: 'recovery_available', recoverySessions: [{ sessionId: 'rec-1' } as never] })
    setRecording({ state: 'recording', activeSessionId: 'rec-1' })
    expect(wakeLockService.request).toHaveBeenCalledOnce()
  })

  it('stays tied to the recording lifecycle, not GNSS -- an interruption warning never releases it', () => {
    render(<Harness />)
    setRecording({ state: 'recording' })
    setRecording({ state: 'recording', warning: 'GNSS reconnecting (attempt 1/4). Recording remains open; no stale or synthetic points will be recorded.' })
    expect(wakeLockService.release).not.toHaveBeenCalled()
  })

  it('reacquires on visibilitychange when recording is still active and the lock is still wanted', () => {
    vi.spyOn(wakeLockService, 'isWanted').mockReturnValue(true)
    render(<Harness />)
    setRecording({ state: 'recording' })
    ;(wakeLockService.request as ReturnType<typeof vi.fn>).mockClear()

    setVisibility('hidden')
    expect(wakeLockService.request).not.toHaveBeenCalled()
    setVisibility('visible')
    expect(wakeLockService.request).toHaveBeenCalledOnce()
  })

  it('does not reacquire on visibilitychange once recording has stopped while hidden', () => {
    vi.spyOn(wakeLockService, 'isWanted').mockReturnValue(true)
    render(<Harness />)
    setRecording({ state: 'recording' })
    setVisibility('hidden')
    setRecording({ state: 'stopped' })
    ;(wakeLockService.request as ReturnType<typeof vi.fn>).mockClear()

    setVisibility('visible')
    expect(wakeLockService.request).not.toHaveBeenCalled()
  })

  it('does not reacquire on visibilitychange if the lock was deliberately released, not just taken away', () => {
    vi.spyOn(wakeLockService, 'isWanted').mockReturnValue(false) // release() sets isWanted() to false
    render(<Harness />)
    setRecording({ state: 'recording' })
    setRecording({ state: 'stopped' })
    ;(wakeLockService.request as ReturnType<typeof vi.fn>).mockClear()
    setVisibility('visible')
    expect(wakeLockService.request).not.toHaveBeenCalled()
  })

  it('repeated start/stop cycles call request/release exactly once per cycle -- no leaks', () => {
    render(<Harness />)
    for (let cycle = 0; cycle < 3; cycle += 1) {
      setRecording({ state: 'recording' })
      setRecording({ state: 'stopped' })
    }
    expect(wakeLockService.request).toHaveBeenCalledTimes(3)
    expect(wakeLockService.release).toHaveBeenCalledTimes(3)
  })

  it('a wake lock error never touches RecordingService -- recording stays authoritative (task section 14)', () => {
    const stopSpy = vi.spyOn(recordingService, 'stop')
    let wakeLockListener: (() => void) | undefined
    ;(wakeLockService.subscribe as ReturnType<typeof vi.fn>).mockImplementation((listener: () => void) => {
      wakeLockListener = listener
      return () => {}
    })
    render(<Harness />)
    setRecording({ state: 'recording' })
    vi.spyOn(wakeLockService, 'getSnapshot').mockReturnValue({ state: 'error', error: 'permission denied' })
    wakeLockListener?.()
    expect(stopSpy).not.toHaveBeenCalled()
    expect(currentSnapshot.state).toBe('recording')
  })

  it('cleans up its listeners on unmount', () => {
    const { unmount } = render(<Harness />)
    expect(listeners.size).toBeGreaterThan(0)
    unmount()
    expect(listeners.size).toBe(0)
  })
})

describe('publishWakeLockStatus', () => {
  beforeEach(() => {
    useSystemStatusStore.getState().setStatus('wakeLock', 'not_integrated')
  })

  function snapshot(overrides: Partial<WakeLockSnapshot> = {}): WakeLockSnapshot {
    return { state: 'idle', error: null, ...overrides }
  }

  it('shows unsupported as a non-fatal warning, independent of recording state', () => {
    publishWakeLockStatus(snapshot({ state: 'unsupported' }), true, false)
    expect(useSystemStatusStore.getState().status.wakeLock).toMatchObject({ value: 'warning', detail: 'Keep-awake unsupported' })
  })

  it('shows disconnected whenever not recording, regardless of the wake lock snapshot', () => {
    publishWakeLockStatus(snapshot({ state: 'active' }), false, false)
    expect(useSystemStatusStore.getState().status.wakeLock.value).toBe('disconnected')
  })

  it('shows connected/Awake while active and recording', () => {
    publishWakeLockStatus(snapshot({ state: 'active' }), true, false)
    expect(useSystemStatusStore.getState().status.wakeLock).toMatchObject({ value: 'connected', detail: 'Awake' })
  })

  it('distinguishes a hidden-tab release from a visible-tab release in the detail text', () => {
    publishWakeLockStatus(snapshot({ state: 'released' }), true, true)
    expect(useSystemStatusStore.getState().status.wakeLock.detail).toContain('return')
    publishWakeLockStatus(snapshot({ state: 'released' }), true, false)
    expect(useSystemStatusStore.getState().status.wakeLock.detail).toBe('Reacquiring')
  })

  it('surfaces a request failure as a warning without claiming the recording is affected', () => {
    publishWakeLockStatus(snapshot({ state: 'error', error: 'permission denied' }), true, false)
    expect(useSystemStatusStore.getState().status.wakeLock).toMatchObject({ value: 'warning', detail: 'permission denied' })
  })
})
