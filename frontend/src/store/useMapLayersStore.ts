import { create } from 'zustand'

/**
 * Layer visibility registry (see docs/UI_REDESIGN.md section 9 on map-layer
 * ownership). `field-boundary` is wired to a real layer as of Stage 2
 * (components/map/layers/FieldLayer.tsx); the rest still describe layers the
 * legacy app owns until their own migration stage.
 */
export type MapLayerId =
  | 'field-boundary'
  | 'survey-track'
  | 'gnss-position'
  | 'water-points'
  | 'observations'
  | 'drone-position'
  | 'mission-grid'

export const MAP_LAYER_IDS: MapLayerId[] = [
  'field-boundary',
  'survey-track',
  'gnss-position',
  'water-points',
  'observations',
  'drone-position',
  'mission-grid',
]

interface MapLayersState {
  visibility: Record<MapLayerId, boolean>
  toggle: (layer: MapLayerId) => void
  setVisible: (layer: MapLayerId, visible: boolean) => void
}

const DEFAULT_VISIBILITY: Record<MapLayerId, boolean> = {
  'field-boundary': true,
  'survey-track': true,
  'gnss-position': true,
  'water-points': true,
  observations: true,
  'drone-position': true,
  'mission-grid': false,
}

export const useMapLayersStore = create<MapLayersState>((set) => ({
  visibility: DEFAULT_VISIBILITY,
  toggle: (layer) =>
    set((state) => ({
      visibility: { ...state.visibility, [layer]: !state.visibility[layer] },
    })),
  setVisible: (layer, visible) =>
    set((state) => ({
      visibility: { ...state.visibility, [layer]: visible },
    })),
}))
