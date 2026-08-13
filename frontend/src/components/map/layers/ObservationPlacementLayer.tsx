import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { isPointInsideBoundary } from '@legacy/fields/field-annotation-core.js'
import { useActiveField } from '../../../services/fields/useActiveField'
import { useObservationPlacementStore } from '../../../store/useObservationPlacementStore'
import { useMapInstance } from '../MapContext'

export function ObservationPlacementLayer() {
  const map = useMapInstance()
  const activeField = useActiveField()
  const active = useObservationPlacementStore((state) => state.mapPlacementActive)
  const candidate = useObservationPlacementStore((state) => state.candidate)
  const setCandidate = useObservationPlacementStore((state) => state.setCandidate)
  const cancel = useObservationPlacementStore((state) => state.cancel)
  const previewRef = useRef<L.CircleMarker | null>(null)

  useEffect(() => {
    if (!map || !active || !activeField) return
    const onClick = (event: L.LeafletMouseEvent) => {
      const coordinates: [number, number] = [event.latlng.lat, event.latlng.lng]
      setCandidate({
        coordinates,
        sourceType: 'manual_map_click',
        outsideField: !isPointInsideBoundary(coordinates, activeField.coordinates),
      })
    }
    map.getContainer().classList.add('map-workspace--placing')
    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
      map.getContainer().classList.remove('map-workspace--placing')
    }
  }, [map, active, activeField, setCandidate])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cancel])

  useEffect(() => {
    previewRef.current?.remove()
    previewRef.current = null
    if (!map || !candidate) return
    const marker = L.circleMarker(candidate.coordinates, {
      radius: 11, color: '#ffffff', weight: 3,
      fillColor: candidate.outsideField ? '#f97316' : '#38bdf8', fillOpacity: 0.95,
    }).addTo(map)
    previewRef.current = marker
    return () => {
      marker.remove()
      if (previewRef.current === marker) previewRef.current = null
    }
  }, [map, candidate])

  return null
}
