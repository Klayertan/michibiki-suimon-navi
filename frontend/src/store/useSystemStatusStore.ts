import { create } from 'zustand'
import type { ServiceId, ServiceStatus, StatusValue } from '../types/systemStatus'

type StatusMap = Record<ServiceId, ServiceStatus>

interface SystemStatusState {
  status: StatusMap
  setStatus: (service: ServiceId, value: StatusValue, detail?: string) => void
}

const NOT_INTEGRATED: ServiceStatus = { value: 'not_integrated' }

// GNSS/serial/recording are overwritten from their real Stage 3B services as
// soon as App mounts. Initial not_integrated remains the honest pre-mount
// value and camera stays there until its own stage.
const INITIAL_STATUS: StatusMap = {
  gnss: NOT_INTEGRATED,
  serial: NOT_INTEGRATED,
  recording: NOT_INTEGRATED,
  wakeLock: NOT_INTEGRATED,
  camera: NOT_INTEGRATED,
  drone: { value: 'unknown' },
  backend: { value: 'unknown' },
}

export const useSystemStatusStore = create<SystemStatusState>((set) => ({
  status: INITIAL_STATUS,
  setStatus: (service, value, detail) =>
    set((state) => ({
      status: {
        ...state.status,
        [service]: { value, detail, updatedAt: Date.now() },
      },
    })),
}))
