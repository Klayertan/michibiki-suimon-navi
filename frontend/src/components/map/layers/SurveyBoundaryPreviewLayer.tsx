import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useSurveyBoundaryPreviewStore } from '../../../store/useSurveyBoundaryPreviewStore'
import { useMapInstance } from '../MapContext'

export function SurveyBoundaryPreviewLayer() {
  const map = useMapInstance()
  const coordinates = useSurveyBoundaryPreviewStore((state) => state.coordinates)
  const polygonRef = useRef<L.Polygon | null>(null)

  useEffect(() => {
    if (!map) return
    polygonRef.current?.remove()
    polygonRef.current = null
    if (coordinates.length < 3) return
    const polygon = L.polygon(coordinates, {
      color: '#f59e0b', fillColor: '#fbbf24', fillOpacity: 0.18, weight: 4, dashArray: '7 5',
    }).addTo(map)
    polygonRef.current = polygon
    map.fitBounds(polygon.getBounds(), { maxZoom: 18, padding: [32, 32] })
    return () => {
      polygon.remove()
      if (polygonRef.current === polygon) polygonRef.current = null
    }
  }, [map, coordinates])

  return null
}
