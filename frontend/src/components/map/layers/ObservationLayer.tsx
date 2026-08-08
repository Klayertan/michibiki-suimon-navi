import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { OBSERVATION_STYLES, OBSERVATION_TYPE_LABELS, SEVERITY_MARKER_RADIUS } from '@legacy/fields/field-annotation-core.js'
import { useObservationSnapshot } from '../../../services/observations/useObservations'
import { useMapLayersStore } from '../../../store/useMapLayersStore'
import { useSelectedEntityStore } from '../../../store/useSelectedEntityStore'
import { useMapInstance } from '../MapContext'

export function ObservationLayer() {
  const map = useMapInstance()
  const { observations } = useObservationSnapshot()
  const visible = useMapLayersStore((state) => state.visibility.observations)
  const select = useSelectedEntityStore((state) => state.select)
  const groupRef = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    if (!map) return
    const group = L.layerGroup()
    groupRef.current = group
    return () => { group.remove(); groupRef.current = null }
  }, [map])

  useEffect(() => {
    const group = groupRef.current
    if (!map || !group) return
    if (visible) group.addTo(map)
    else group.remove()
  }, [map, visible])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    group.clearLayers()
    observations.forEach((observation) => {
      const style = OBSERVATION_STYLES[observation.type] ?? OBSERVATION_STYLES.note
      const radius = SEVERITY_MARKER_RADIUS[observation.properties.severity] ?? SEVERITY_MARKER_RADIUS.medium
      L.circleMarker(observation.coordinates, {
        radius, color: '#ffffff', weight: 2, fillColor: style.fillColor, fillOpacity: 0.95,
      })
        .bindTooltip(observation.name || OBSERVATION_TYPE_LABELS[observation.type])
        .on('click', (event) => {
          L.DomEvent.stopPropagation(event)
          select({ type: 'observation', id: observation.id })
        })
        .addTo(group)
    })
  }, [map, observations, select])

  return null
}
