/**
 * Status vocabulary for the top status bar and telemetry tray.
 *
 * "not_integrated" is distinct from "unknown": "unknown" means the new UI
 * has wired up a real service and simply has not heard from it yet (e.g. the
 * first health check hasn't resolved), while "not_integrated" means Stage 1
 * has not connected that subsystem to the new UI at all (GNSS/serial/
 * recording/camera today). Rendering must never show "connected" for a
 * service that was not actually queried — see docs/UI_REDESIGN.md Stage 1.
 */
export type StatusValue = 'connected' | 'disconnected' | 'unknown' | 'warning' | 'not_integrated'

export type ServiceId = 'gnss' | 'serial' | 'recording' | 'wakeLock' | 'drone' | 'camera' | 'backend'

export interface ServiceStatus {
  value: StatusValue
  /** Short human-readable detail, e.g. "mock mode" or "no response". */
  detail?: string
  /** ms since epoch of the last time this status was actually updated by a real check. */
  updatedAt?: number
}
