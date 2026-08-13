import { create } from 'zustand'
import type { LatLon } from '../domain/fields/geometry'

export interface ObservationCandidate {
  coordinates: LatLon
  sourceType: 'manual_map_click' | 'qz1_current_position'
  outsideField: boolean
}

interface ObservationPlacementState {
  mapPlacementActive: boolean
  candidate: ObservationCandidate | null
  beginMapPlacement: () => void
  setCandidate: (candidate: ObservationCandidate) => void
  cancel: () => void
}

export const useObservationPlacementStore = create<ObservationPlacementState>((set) => ({
  mapPlacementActive: false,
  candidate: null,
  beginMapPlacement: () => set({ mapPlacementActive: true, candidate: null }),
  setCandidate: (candidate) => set({ mapPlacementActive: false, candidate }),
  cancel: () => set({ mapPlacementActive: false, candidate: null }),
}))
