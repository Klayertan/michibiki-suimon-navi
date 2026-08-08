import type { LatLon } from '../fields/geometry'

export type ObservationType = 'weed' | 'insect' | 'disease' | 'water_shortage' | 'excess_water' | 'lodging' | 'soil_problem' | 'gate_problem' | 'note'
export type Stage3CObservationType = 'weed' | 'insect' | 'disease' | 'note'
export type ObservationSeverity = 'low' | 'medium' | 'high' | 'urgent'
export type ObservationSourceType = 'manual_map_click' | 'qz1_current_position' | 'phone_gps' | string

export interface FieldObservation {
  id: string
  fieldId: string | null
  type: ObservationType
  label: string
  name: string
  geometryType: 'Point'
  /** Persisted authority is [lat, lon], never GeoJSON order. */
  coordinates: LatLon
  properties: {
    severity: ObservationSeverity
    memo: string
    sourceType: ObservationSourceType
    createdAt: string
    updatedAt: string
  }
}

export interface CreateObservationInput {
  fieldId: string
  fieldName: string
  type: Stage3CObservationType
  severity: ObservationSeverity
  memo?: string
  coordinates: LatLon
  sourceType: 'manual_map_click' | 'qz1_current_position'
}

export interface ObservationSnapshot {
  observations: FieldObservation[]
  warnings: string[]
  error: string | null
}
