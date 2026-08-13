import { create } from 'zustand'
import type { SelectedEntity } from '../types/selection'

interface SelectedEntityState {
  selectedEntity: SelectedEntity
  select: (entity: SelectedEntity) => void
  clear: () => void
}

export const useSelectedEntityStore = create<SelectedEntityState>((set) => ({
  selectedEntity: null,
  select: (entity) => set({ selectedEntity: entity }),
  clear: () => set({ selectedEntity: null }),
}))
