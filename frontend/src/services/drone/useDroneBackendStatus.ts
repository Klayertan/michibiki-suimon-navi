import { useEffect } from 'react'
import { createDroneService, DroneApiError } from './droneService'
import { useSystemStatusStore } from '../../store/useSystemStatusStore'
import { useDroneTelemetryStore } from '../../store/useDroneTelemetryStore'

const HEALTH_POLL_MS = 5000

/**
 * Mounted once at the app root (see app/App.tsx) so the top status bar
 * reflects real backend/drone state regardless of which workspace route is
 * active -- the task's acceptance criterion #11. Polls `/api/health` for the
 * general "backend" badge and opens the telemetry WebSocket for the
 * drone-specific badge; both only ever report what the backend actually said,
 * never an assumed/faked "connected".
 */
export function useDroneBackendStatus(): void {
  const setStatus = useSystemStatusStore((state) => state.setStatus)
  const setSnapshot = useDroneTelemetryStore((state) => state.setSnapshot)

  useEffect(() => {
    const service = createDroneService()
    let cancelled = false
    const pollTimer = setInterval(checkHealth, HEALTH_POLL_MS)

    async function checkHealth() {
      try {
        const health = await service.getHealth()
        if (cancelled) return
        setStatus('backend', 'connected', `${health.mode} mode`)
      } catch (error) {
        if (cancelled) return
        const detail = error instanceof DroneApiError ? error.message : 'unreachable'
        setStatus('backend', 'disconnected', detail)
        setStatus('drone', 'disconnected', detail)
      }
    }

    checkHealth()

    const subscription = service.subscribeTelemetry({
      onOpen: () => {
        if (!cancelled) setStatus('drone', 'unknown', 'awaiting telemetry')
      },
      onMessage: (payload) => {
        if (cancelled) return
        setSnapshot(payload)
        const value = payload.connected ? 'connected' : payload.error ? 'warning' : 'disconnected'
        setStatus('drone', value, payload.connectionState)
      },
      onClose: () => {
        if (!cancelled) setStatus('drone', 'disconnected', 'telemetry socket closed')
      },
      onError: () => {
        if (!cancelled) setStatus('drone', 'warning', 'telemetry socket error')
      },
    })

    return () => {
      cancelled = true
      clearInterval(pollTimer)
      subscription.close()
    }
  }, [setStatus, setSnapshot])
}
