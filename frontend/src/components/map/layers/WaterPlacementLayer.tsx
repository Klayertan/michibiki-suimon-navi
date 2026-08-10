import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { isPointInsideBoundary } from '@legacy/fields/field-annotation-core.js'
import { useActiveField } from '../../../services/fields/useActiveField'
import { useWaterPlacementStore } from '../../../store/useWaterPlacementStore'
import { useMapInstance } from '../MapContext'
import { waterCandidateIcon } from './waterSymbols'

/**
 * One-shot map placement for a new water control point, mirroring
 * ObservationPlacementLayer: the click listener exists only while placement is
 * armed, so an ordinary map click can never create data, and Escape cancels.
 *
 * `outsideField` is computed with the authoritative legacy helper but is
 * advisory only -- legacy applies no boundary gate to water placement, and
 * Stage 4A does not invent one.
 */
export function WaterPlacementLayer() {
  const map = useMapInstance()
  const activeField = useActiveField()
  const active = useWaterPlacementStore((state) => state.mapPlacementActive)
  const pendingType = useWaterPlacementStore((state) => state.pendingType)
  const candidate = useWaterPlacementStore((state) => state.candidate)
  const setCandidate = useWaterPlacementStore((state) => state.setCandidate)
  const cancel = useWaterPlacementStore((state) => state.cancel)
  const previewRef = useRef<L.Marker | null>(null)

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
    if (!map || !candidate || !pendingType) return
    const marker = L.marker(candidate.coordinates, {
      icon: waterCandidateIcon(pendingType),
      keyboard: false,
    }).addTo(map)
    previewRef.current = marker
    return () => {
      marker.remove()
      if (previewRef.current === marker) previewRef.current = null
    }
  }, [map, candidate, pendingType])

  return null
}
