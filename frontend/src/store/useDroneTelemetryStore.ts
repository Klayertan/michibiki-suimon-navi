import { create } from 'zustand'
import type { DroneStatusSnapshot } from '../services/drone/droneService'

/**
 * Kept separate from useSystemStatusStore on purpose: telemetry arrives at
 * ~2Hz (see backend's ws_interval) and only the drone workspace's inspector
 * needs the full snapshot. The status bar instead reads only the small
 * derived status string in useSystemStatusStore, so it does not re-render at
 * telemetry rate -- see docs/UI_REDESIGN.md section 17 on high-frequency data.
 */
interface DroneTelemetryState {
  snapshot: DroneStatusSnapshot | null
  setSnapshot: (snapshot: DroneStatusSnapshot) => void
}

export const useDroneTelemetryStore = create<DroneTelemetryState>((set) => ({
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),
}))
