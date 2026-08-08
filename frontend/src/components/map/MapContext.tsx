import { createContext, useContext } from 'react'
import type L from 'leaflet'

/**
 * The one persistent Leaflet map instance, published by MapWorkspace once it
 * exists (null until then). Layer components (components/map/layers/*)
 * consume this instead of creating their own map, so switching workspaces or
 * updating a layer's data never recreates the map (task section 14).
 */
export const MapContext = createContext<L.Map | null>(null)

export function useMapInstance(): L.Map | null {
  return useContext(MapContext)
}
