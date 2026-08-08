// Plain ES module (js/drone/drone-api-client.js), imported via the @legacy
// alias -- see vite.config.ts. TypeScript infers its shape loosely from the
// JS source; the real, checked types the rest of the app relies on are
// declared explicitly below at this service boundary.
import { DroneApiClient, DroneApiError } from '@legacy/drone/drone-api-client.js'

export interface DroneHealth {
  status: string
  version: string
  mode: string
  linkRunning: boolean
}

/**
 * Shape of `GET /api/drone/status` / the telemetry WebSocket payload.
 * Documented in docs/MAVLINK_INTEGRATION_REPORT.md. Left loose beyond the
 * fields Stage 1 actually reads -- narrowing further belongs to whichever
 * stage builds the full telemetry tray.
 */
export interface DroneStatusSnapshot {
  connectionState: string
  connected: boolean
  commandable: boolean
  mode: string | null
  allowSafeCommands: boolean
  armSupported: boolean
  takeoffSupported: boolean
  error: { message: string } | null
  [key: string]: unknown
}

export interface TelemetrySubscriptionHandlers {
  onMessage?: (payload: DroneStatusSnapshot) => void
  onOpen?: () => void
  onClose?: (event: unknown) => void
  onError?: (error: unknown) => void
}

export interface TelemetrySubscription {
  close: () => void
}

/**
 * Stage 1 boundary around the existing, already-safe MAVLink backend client
 * (js/drone/drone-api-client.js -- see docs/UI_REDESIGN.md section 4 and
 * docs/FRONTEND_ARCHITECTURE.md). Deliberately read-only: only what Stage 1
 * needs to prove the new shell can show real backend state. Connect/
 * disconnect, mode changes, and the rest of DroneApiClient's surface are
 * intentionally not re-exposed here -- add them only when a later stage
 * builds real UI for them, per the task's "no empty abstraction layers for
 * every imaginable future subsystem" guidance. No flight command is added
 * here, and none should be: the backend itself has no code path for one.
 */
export interface DroneService {
  getHealth(): Promise<DroneHealth>
  getStatus(): Promise<DroneStatusSnapshot>
  subscribeTelemetry(handlers: TelemetrySubscriptionHandlers): TelemetrySubscription
}

export { DroneApiError }

/**
 * Same-origin by default so this works unmodified in three places without any
 * dev-only origin/CORS configuration:
 *  - the Vite dev server, which proxies `/api/*` (including the WebSocket) to
 *    127.0.0.1:8787 -- see vite.config.ts
 *  - a production build served by the desktop app, where FastAPI serves the
 *    built frontend and the API from the same origin
 *    (backend/app/desktop_assets.py)
 *  - any future deployment where this frontend and the backend share an
 *    origin behind one reverse proxy
 * Pass an explicit baseUrl only to point at a backend on a different origin
 * during manual testing.
 */
export function createDroneService(baseUrl: string = window.location.origin): DroneService {
  const client = new DroneApiClient({ baseUrl })

  return {
    getHealth: () => client.health(),
    getStatus: () => client.status(),
    subscribeTelemetry: (handlers: TelemetrySubscriptionHandlers) => client.openTelemetrySocket(handlers),
  }
}
