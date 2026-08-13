import { create } from 'zustand'
import type { LatLon } from '../domain/fields/geometry'
import type { WaterControlType } from '../domain/water/types'

export interface WaterControlCandidate {
  coordinates: LatLon
  sourceType: 'manual_map_click' | 'qz1_current_position'
  /**
   * Informational only. Legacy applies **no** point-in-polygon gate to water
   * placement -- `isPointInsideBoundary` is called exactly once in the whole
   * legacy controller, and only for observations. Stage 4A preserves that
   * acceptance (nothing is blocked and no Save-Anyway step is invented) while
   * still showing the operator what it is about to save.
   */
  outsideField: boolean
}

interface WaterPlacementState {
  /** The armed type, or null when no placement is in progress. */
  pendingType: WaterControlType | null
  mapPlacementActive: boolean
  candidate: WaterControlCandidate | null
  /** Arms exactly one map click. An ordinary click never creates data. */
  beginMapPlacement: (type: WaterControlType) => void
  armType: (type: WaterControlType) => void
  setCandidate: (candidate: WaterControlCandidate) => void
  cancel: () => void
}

export const useWaterPlacementStore = create<WaterPlacementState>((set) => ({
  pendingType: null,
  mapPlacementActive: false,
  candidate: null,
  beginMapPlacement: (type) => set({ pendingType: type, mapPlacementActive: true, candidate: null }),
  armType: (type) => set({ pendingType: type }),
  setCandidate: (candidate) => set({ mapPlacementActive: false, candidate }),
  cancel: () => set({ pendingType: null, mapPlacementActive: false, candidate: null }),
}))
