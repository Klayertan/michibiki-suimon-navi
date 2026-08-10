import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { FIELD_POLYGON_STYLE } from '@legacy/fields/field-annotation-core.js'
import { useMapInstance } from '../MapContext'
import { useFields } from '../../../services/fields/useFields'
import { useActiveFieldStore } from '../../../store/useActiveFieldStore'
import { useSelectedEntityStore } from '../../../store/useSelectedEntityStore'
import { useMapLayersStore } from '../../../store/useMapLayersStore'
import { fieldAreaSquareMeters, formatAreaSquareMeters } from '../../../domain/fields/selectors'

// Same style object the legacy app renders field polygons with (task section
// 13: reuse, don't invent a second palette) plus one active-field variant.
const ACTIVE_FIELD_STYLE: L.PathOptions = { ...FIELD_POLYGON_STYLE, color: '#facc15', weight: 4, fillOpacity: 0.28 }

function styleFor(isActive: boolean): L.PathOptions {
  return isActive ? ACTIVE_FIELD_STYLE : (FIELD_POLYGON_STYLE as L.PathOptions)
}

/**
 * The first real migrated map layer (task section 13). Renders persisted
 * field polygons, distinguishes the active field, and lets the operator
 * select a field by clicking it. Independent of MapWorkspace and of whichever
 * workspace route is active -- it attaches to the one persistent map instance
 * via MapContext and never recreates it (task section 14).
 */
export function FieldLayer() {
  const map = useMapInstance()
  const fields = useFields()
  const activeFieldId = useActiveFieldStore((state) => state.activeFieldId)
  const setActiveFieldId = useActiveFieldStore((state) => state.setActiveFieldId)
  const select = useSelectedEntityStore((state) => state.select)
  const visible = useMapLayersStore((state) => state.visibility['field-boundary'])

  const groupRef = useRef<L.LayerGroup | null>(null)
  const polygonsByFieldId = useRef(new Map<string, L.Polygon>())
  const hasFittedOnce = useRef(false)

  // The layer group's lifecycle is tied only to the map instance existing --
  // never to field data, selection, or visibility changing.
  useEffect(() => {
    if (!map) return
    const group = L.layerGroup()
    const polygons = polygonsByFieldId.current
    groupRef.current = group
    return () => {
      group.remove()
      groupRef.current = null
      polygons.clear()
    }
  }, [map])

  useEffect(() => {
    const group = groupRef.current
    if (!map || !group) return
    if (visible) group.addTo(map)
    else group.remove()
  }, [map, visible])

  useEffect(() => {
    const group = groupRef.current
    if (!map || !group) return

    group.clearLayers()
    polygonsByFieldId.current.clear()
    fields.forEach((field) => {
      const polygon = L.polygon(field.coordinates, styleFor(field.id === activeFieldId))
      // Compact hover label, not a permanent map overlay (task section 8) --
      // name plus area, same formatter the inspector uses.
      polygon.bindTooltip(`${field.name} · ${formatAreaSquareMeters(fieldAreaSquareMeters(field))}`, { sticky: true })
      polygon.on('click', (event) => {
        // Keep a polygon selection from also reaching the base map. Future
        // map tools can therefore add their own click modes without treating
        // a field-selection click as an unrelated map action.
        L.DomEvent.stopPropagation(event)
        setActiveFieldId(field.id)
        select({ type: 'field', id: field.id })
      })
      polygon.addTo(group)
      polygonsByFieldId.current.set(field.id, polygon)
    })
  }, [map, fields, activeFieldId, setActiveFieldId, select])

  // Fit to the active field's bounds, but not on the very first render --
  // opening the app should not immediately yank the view before the operator
  // has chosen anything.
  useEffect(() => {
    if (!hasFittedOnce.current) {
      hasFittedOnce.current = true
      return
    }
    if (!map || !activeFieldId) return
    const polygon = polygonsByFieldId.current.get(activeFieldId)
    if (polygon) {
      map.fitBounds(polygon.getBounds(), { maxZoom: 18, padding: [32, 32] })
    }
  }, [map, activeFieldId])

  return null
}
