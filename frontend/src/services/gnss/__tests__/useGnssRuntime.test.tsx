import { beforeEach, describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useGnssRuntime, publishSerialStatus } from '../useGnssRuntime'
import { serialGnssService, type GnssSerialSnapshot } from '../serialGnssService'
import { useLiveGnssStore } from '../../../store/useLiveGnssStore'
import { useSystemStatusStore } from '../../../store/useSystemStatusStore'

function snapshot(overrides: Partial<GnssSerialSnapshot>): GnssSerialSnapshot {
  return {
    connectionState: 'connected', currentFix: null, baudRate: 115200, lineCount: 0,
    malformedLineCount: 0, message: null, transportLabel: 'test',
    reconnectAttempt: 0, reconnectMaxAttempts: 0,
    ...overrides,
  }
}

function Harness() {
  useGnssRuntime()
  return null
}

describe('useGnssRuntime', () => {
  beforeEach(() => {
    const setStatus = useSystemStatusStore.getState().setStatus
    setStatus('gnss', 'not_integrated')
    setStatus('serial', 'not_integrated')
    setStatus('recording', 'not_integrated')
  })

  it('wires GNSS, serial, and recording badges to real service state', async () => {
    render(<Harness />)
    await waitFor(() => {
      expect(useSystemStatusStore.getState().status.serial.value).toBe('warning')
      expect(useSystemStatusStore.getState().status.gnss.value).toBe('disconnected')
      expect(useSystemStatusStore.getState().status.recording.value).toBe('disconnected')
    })
    expect(useLiveGnssStore.getState().connectionState).toBe(serialGnssService.getSnapshot().connectionState)
  })

  describe('Stage 5B: reconnect states surface distinctly on both badges', () => {
    it('shows the reconnect attempt count for "reconnecting"', () => {
      publishSerialStatus(snapshot({ connectionState: 'reconnecting', reconnectAttempt: 2, reconnectMaxAttempts: 4 }))
      const status = useSystemStatusStore.getState().status
      expect(status.serial).toMatchObject({ value: 'warning', detail: 'Reconnecting (2/4)' })
      expect(status.gnss).toMatchObject({ value: 'warning', detail: 'Reconnecting (2/4)' })
    })

    it('shows "reconnect required" once automatic attempts are exhausted', () => {
      publishSerialStatus(snapshot({ connectionState: 'reconnect_required', reconnectAttempt: 4, reconnectMaxAttempts: 4 }))
      const status = useSystemStatusStore.getState().status
      expect(status.serial).toMatchObject({ value: 'warning', detail: 'Reconnect required' })
      expect(status.gnss).toMatchObject({ value: 'warning', detail: 'Reconnect required' })
    })

    it('distinguishes "stalled" (transport fine, no data) from a real disconnect', () => {
      publishSerialStatus(snapshot({ connectionState: 'stalled', message: 'No data received from the GNSS device recently.' }))
      const status = useSystemStatusStore.getState().status
      expect(status.serial.value).toBe('warning')
      expect(status.gnss).toMatchObject({ value: 'warning', detail: 'No data received recently' })
    })

    it('never reports "connected" for gnss during reconnecting/reconnect_required, even with a preserved stale currentFix', () => {
      const staleFix = { receivedAtMs: Date.now() - 60_000, fixQuality: 1 } as GnssSerialSnapshot['currentFix']
      publishSerialStatus(snapshot({ connectionState: 'reconnecting', currentFix: staleFix, reconnectAttempt: 1, reconnectMaxAttempts: 4 }))
      expect(useSystemStatusStore.getState().status.gnss.value).not.toBe('connected')
    })
  })
})
