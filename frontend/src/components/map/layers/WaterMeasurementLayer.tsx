import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { formatWaterLevel } from '../../../domain/water/selectors'
import { useWaterMeasurementSnapshot } from '../../../services/water/useWaterMeasurements'
import { useMapLayersStore } from '../../../store/useMapLayersStore'
import { useSelectedEntityStore } from '../../../store/useSelectedEntityStore'
import { useMapInstance } from '../MapContext'
import { waterMeasurementIcon } from './waterSymbols'

/**
 * Saved water-level readings from the recording store, read-only. Kept as its
 * own layer and its own selected-entity type rather than merged into
 * WaterControlLayer: a reading and a control point are different records, in
 * different databases, with different coordinate conventions and no link
 * between them.
 */
export function WaterMeasurementLayer() {
  const map = useMapInstance()
  const { measurements } = useWaterMeasurementSnapshot()
  const visible = useMapLayersStore((state) => state.visibility['water-measurements'])
  const selectedEntity = useSelectedEntityStore((state) => state.selectedEntity)
  const select = useSelectedEntityStore((state) => state.select)
  const groupRef = useRef<L.LayerGroup | null>(null)

  const selectedId = selectedEntity?.type === 'waterMeasurement' ? selectedEntity.id : null

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
    measurements.forEach((measurement) => {
      L.marker([measurement.latitude, measurement.longitude], {
        icon: waterMeasurementIcon(measurement.id === selectedId),
        keyboard: false,
      })
        .bindTooltip(`水位 / Water level: ${formatWaterLevel(measurement.waterLevel)}`)
        .on('click', (event) => {
          L.DomEvent.stopPropagation(event)
          select({ type: 'waterMeasurement', id: measurement.id })
        })
        .addTo(group)
    })
  }, [map, measurements, selectedId, select])

  return null
}
