import { create } from 'zustand'
import type { LatLon } from '../domain/fields/geometry'

interface SurveyBoundaryPreviewState {
  coordinates: LatLon[]
  setCoordinates: (coordinates: LatLon[]) => void
  clear: () => void
}

export const useSurveyBoundaryPreviewStore = create<SurveyBoundaryPreviewState>((set) => ({
  coordinates: [],
  setCoordinates: (coordinates) => set({ coordinates }),
  clear: () => set({ coordinates: [] }),
}))
