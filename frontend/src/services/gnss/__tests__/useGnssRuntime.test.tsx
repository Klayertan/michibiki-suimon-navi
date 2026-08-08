import { beforeEach, describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { useGnssRuntime } from '../useGnssRuntime'
import { serialGnssService } from '../serialGnssService'
import { useLiveGnssStore } from '../../../store/useLiveGnssStore'
import { useSystemStatusStore } from '../../../store/useSystemStatusStore'

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
})
