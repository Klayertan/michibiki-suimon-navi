import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { controlPointInternalType, controlPointTypeLabel } from '../../../domain/water/selectors'
import { useWaterControlSnapshot } from '../../../services/water/useWaterControlPoints'
import { useMapLayersStore } from '../../../store/useMapLayersStore'
import { useSelectedEntityStore } from '../../../store/useSelectedEntityStore'
import { useMapInstance } from '../MapContext'
import { waterControlIcon } from './waterSymbols'

/**
 * Persisted water control points (gate/inlet/outlet/sensor/photo). Owns its own
 * long-lived LayerGroup beside FieldLayer, SurveyLayer, the live GNSS layers and
 * ObservationLayer -- the group's lifetime is tied only to the map instance, so
 * data, selection and route changes never recreate the map.
 *
 * Every point is rendered, including orphans whose field was deleted
 * (relatedFieldId === null). That matches legacy, which also draws the whole
 * array unfiltered -- and it is why the workspace calls orphans out explicitly,
 * since reports silently drop them.
 */
export function WaterControlLayer() {
  const map = useMapInstance()
  const { points } = useWaterControlSnapshot()
  const visible = useMapLayersStore((state) => state.visibility['water-points'])
  const selectedEntity = useSelectedEntityStore((state) => state.selectedEntity)
  const select = useSelectedEntityStore((state) => state.select)
  const groupRef = useRef<L.LayerGroup | null>(null)

  const selectedId = selectedEntity?.type === 'waterControl' ? selectedEntity.id : null

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
    points.forEach((point) => {
      const type = controlPointInternalType(point)
      L.marker(point.coordinates, {
        icon: waterControlIcon(type, point.id === selectedId),
        keyboard: false,
      })
        .bindTooltip(`${controlPointTypeLabel(point)}${point.name ? ` ${point.name}` : ''}`)
        .on('click', (event) => {
          // Never let selecting an existing point double as a placement click.
          L.DomEvent.stopPropagation(event)
          select({ type: 'waterControl', id: point.id })
        })
        .addTo(group)
    })
  }, [map, points, selectedId, select])

  return null
}
