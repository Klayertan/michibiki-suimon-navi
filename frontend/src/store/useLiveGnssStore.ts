import { create } from 'zustand'
import type { GnssSerialSnapshot } from '../services/gnss/serialGnssService'

interface LiveGnssState extends GnssSerialSnapshot {
  applySnapshot: (snapshot: GnssSerialSnapshot) => void
}

const initial = {
  connectionState: 'unsupported',
  currentFix: null,
  baudRate: 115200,
  lineCount: 0,
  malformedLineCount: 0,
  message: null,
  transportLabel: null,
  reconnectAttempt: 0,
  reconnectMaxAttempts: 0,
} satisfies GnssSerialSnapshot

export const useLiveGnssStore = create<LiveGnssState>((set) => ({
  ...initial,
  applySnapshot: (snapshot) => set(snapshot),
}))
