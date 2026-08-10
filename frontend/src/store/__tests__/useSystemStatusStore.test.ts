import { describe, expect, it } from 'vitest'
import { useSystemStatusStore } from '../useSystemStatusStore'

describe('useSystemStatusStore', () => {
  it('every subsystem starts not_integrated or unknown, never connected', () => {
    const { status } = useSystemStatusStore.getState()
    for (const entry of Object.values(status)) {
      expect(entry.value).not.toBe('connected')
    }
    // Stage 1 has not queried these at all yet -- see docs/UI_REDESIGN.md.
    expect(status.gnss.value).toBe('not_integrated')
    expect(status.serial.value).toBe('not_integrated')
    expect(status.recording.value).toBe('not_integrated')
    expect(status.wakeLock.value).toBe('not_integrated')
    expect(status.camera.value).toBe('not_integrated')
    // Drone/backend are real services that just haven't reported yet.
    expect(status.drone.value).toBe('unknown')
    expect(status.backend.value).toBe('unknown')
  })

  it('setStatus updates exactly the named service and stamps updatedAt', () => {
    const before = Date.now()
    useSystemStatusStore.getState().setStatus('backend', 'connected', 'mock mode')
    const { status } = useSystemStatusStore.getState()
    expect(status.backend).toMatchObject({ value: 'connected', detail: 'mock mode' })
    expect(status.backend.updatedAt).toBeGreaterThanOrEqual(before)
    // Unrelated services are untouched.
    expect(status.gnss.value).toBe('not_integrated')
  })
})
