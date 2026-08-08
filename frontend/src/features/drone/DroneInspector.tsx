import { FeaturePlaceholder } from '../common/FeaturePlaceholder'
import { StatusBadge } from '../../components/status/StatusBadge'
import { useSystemStatusStore } from '../../store/useSystemStatusStore'
import { useDroneTelemetryStore } from '../../store/useDroneTelemetryStore'

/**
 * The one workspace with real backend integration in Stage 1 (acceptance
 * criterion #11). Strictly read-only, matching backend/app/mavlink/
 * command_service.py: no connect/disconnect/mode buttons here, only what the
 * backend has already reported through useDroneBackendStatus (mounted at the
 * app root). Full telemetry tray / mission planning is Stage 6.
 */
export function DroneInspector() {
  const backend = useSystemStatusStore((state) => state.status.backend)
  const drone = useSystemStatusStore((state) => state.status.drone)
  const snapshot = useDroneTelemetryStore((state) => state.snapshot)

  return (
    <FeaturePlaceholder
      title="Drone"
      summary="Vehicle connection, Pixhawk/MAVLink status, flight mode, battery, GPS. Mission planning and full telemetry are later stages."
      migrationNote="This panel already reads the real backend (backend/app/mavlink/*) through services/drone/droneService.ts -- everything below is live, not a placeholder."
    >
      <dl className="drone-status-grid">
        <div>
          <dt>Backend</dt>
          <dd>
            <StatusBadge label="backend" value={backend.value} />
            {backend.detail ? <span className="drone-status-grid__detail">{backend.detail}</span> : null}
          </dd>
        </div>
        <div>
          <dt>Drone link</dt>
          <dd>
            <StatusBadge label="drone" value={drone.value} />
            {drone.detail ? <span className="drone-status-grid__detail">{drone.detail}</span> : null}
          </dd>
        </div>
        {snapshot ? (
          <>
            <div>
              <dt>Mode</dt>
              <dd>{snapshot.mode ?? '—'}</dd>
            </div>
            <div>
              <dt>Commandable</dt>
              <dd>{String(snapshot.commandable)}</dd>
            </div>
            <div>
              <dt>Arm / takeoff supported</dt>
              <dd>{String(snapshot.armSupported)} / {String(snapshot.takeoffSupported)}</dd>
            </div>
          </>
        ) : (
          <div>
            <dt>Telemetry</dt>
            <dd>
              No snapshot yet. Start the backend with <code>npm run backend:mock</code> (or{' '}
              <code>npm run dev</code> from the repository root) and reload.
            </dd>
          </div>
        )}
      </dl>
    </FeaturePlaceholder>
  )
}
