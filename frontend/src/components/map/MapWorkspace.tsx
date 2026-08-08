import { useEffect, useRef, useState, type ReactNode } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapContext } from './MapContext'
import './MapWorkspace.css'

// Same default view and base tile layer as the legacy app (index.html) for
// visual continuity -- see docs/UI_REDESIGN.md section 9. This is otherwise a
// completely separate Leaflet instance; the legacy map and this one do not
// share layers, per the "coexist, don't fight over one global map" decision
// in docs/FRONTEND_ARCHITECTURE.md. FieldLayer (Stage 2) is the first real
// layer attached here; survey/water/drone/mission layers arrive in later
// stages.
const DEFAULT_CENTER: L.LatLngExpression = [34.65, 135.83]
const DEFAULT_ZOOM = 14

interface MapWorkspaceProps {
  /**
   * Layer components (e.g. components/map/layers/FieldLayer) that attach to
   * the map instance via MapContext once it exists. Rendered as siblings of
   * the Leaflet-owned div, never inside it -- Leaflet manages that div's DOM
   * itself, and a layer component renders no DOM of its own (it returns
   * null), so there is no conflict between React's and Leaflet's DOM writes.
   */
  children?: ReactNode
}

/**
 * Plain Leaflet wrapped in a ref-managed effect rather than react-leaflet:
 * at the time of this migration react-leaflet's React 19 support was not
 * established, and a ~20-line host doesn't need the extra dependency. Revisit
 * once real layers (from useMapLayersStore) start getting added in Stage 2+ --
 * if the imperative layer-management code grows unwieldy, react-leaflet is
 * worth reconsidering then.
 */
export function MapWorkspace({ children }: MapWorkspaceProps = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  // State (not just the ref above) so layer children re-render once the map
  // instance actually exists -- the ref alone wouldn't notify consumers.
  const [map, setMap] = useState<L.Map | null>(null)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const instance = L.map(containerRef.current, {
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: true,
    })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(instance)
    mapRef.current = instance
    setMap(instance)

    return () => {
      instance.remove()
      mapRef.current = null
      setMap(null)
    }
  }, [])

  return (
    <MapContext.Provider value={map}>
      <div ref={containerRef} className="map-workspace" role="region" aria-label="Map workspace" />
      {children}
    </MapContext.Provider>
  )
}
