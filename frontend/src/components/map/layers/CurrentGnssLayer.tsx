import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { serialGnssService } from '../../../services/gnss/serialGnssService'
import { useMapLayersStore } from '../../../store/useMapLayersStore'
import { useMapInstance } from '../MapContext'

interface CurrentGnssSource {
  getSnapshot: typeof serialGnssService.getSnapshot
  subscribe: typeof serialGnssService.subscribe
}

export function CurrentGnssLayer({ service = serialGnssService }: { service?: CurrentGnssSource }) {
  const map = useMapInstance()
  const visible = useMapLayersStore((state) => state.visibility['gnss-position'])
  const groupRef = useRef<L.LayerGroup | null>(null)
  const markerRef = useRef<L.CircleMarker | null>(null)

  useEffect(() => {
    if (!map) return
    const group = L.layerGroup()
    groupRef.current = group
    const render = () => {
      const fix = service.getSnapshot().currentFix
      if (!fix) {
        markerRef.current?.remove()
        markerRef.current = null
        return
      }
      if (!markerRef.current) {
        markerRef.current = L.circleMarker([fix.lat, fix.lon], { radius: 7, color: '#0369a1', weight: 3, fillColor: '#38bdf8', fillOpacity: 0.9 }).addTo(group)
        markerRef.current.bindTooltip('Current GNSS position')
      } else {
        markerRef.current.setLatLng([fix.lat, fix.lon])
      }
    }
    render()
    const unsubscribe = service.subscribe(render)
    return () => {
      unsubscribe()
      group.remove()
      groupRef.current = null
      markerRef.current = null
    }
  }, [map, service])

  useEffect(() => {
    const group = groupRef.current
    if (!map || !group) return
    if (visible) group.addTo(map)
    else group.remove()
  }, [map, visible])

  return null
}
