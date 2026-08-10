import L from 'leaflet'
import { WATER_CONTROL_STYLES } from '@legacy/fields/field-annotation-core.js'
import type { WaterControlType } from '../../../domain/water/types'

/**
 * Water symbols must be distinguishable from the round observation/GNSS
 * markers **without relying on color**, so each one carries a shape class and
 * a short glyph as well as the legacy fill color:
 *
 *   water control point -- square,  type glyph (G/I/O/S/P)
 *   water level reading -- diamond, "L"
 *
 * Colors come from the unchanged legacy `WATER_CONTROL_STYLES`
 * (js/fields/field-annotation-core.js:77-83) rather than a second palette.
 */

const TYPE_GLYPH: Record<WaterControlType, string> = {
  gate: 'G',
  inlet: 'I',
  outlet: 'O',
  sensor: 'S',
  photo: 'P',
}

function fillColorFor(type: WaterControlType): string {
  const style = (WATER_CONTROL_STYLES as Record<string, { fillColor?: string }>)[type]
  return style?.fillColor ?? '#2563eb'
}

export function waterControlIcon(type: WaterControlType, selected: boolean): L.DivIcon {
  return L.divIcon({
    className: '',
    html:
      `<span class="water-symbol water-symbol--control water-symbol--${type}` +
      `${selected ? ' water-symbol--selected' : ''}" ` +
      `style="--water-symbol-fill:${fillColorFor(type)}">${TYPE_GLYPH[type]}</span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  })
}

export function waterMeasurementIcon(selected: boolean): L.DivIcon {
  return L.divIcon({
    className: '',
    html:
      `<span class="water-symbol water-symbol--measurement` +
      `${selected ? ' water-symbol--selected' : ''}">L</span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  })
}

export function waterCandidateIcon(type: WaterControlType): L.DivIcon {
  return L.divIcon({
    className: '',
    html:
      `<span class="water-symbol water-symbol--control water-symbol--${type} water-symbol--candidate" ` +
      `style="--water-symbol-fill:${fillColorFor(type)}">${TYPE_GLYPH[type]}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })
}
