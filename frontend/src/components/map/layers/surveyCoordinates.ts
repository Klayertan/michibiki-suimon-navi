import type L from 'leaflet'
import type { PersistedLatLon } from '../../../domain/surveys/types'

/** Persistence is `[lat, lon]`; Leaflet consumes `[lat, lng]`. No axis swap is needed. */
export function toLeafletLatLngs(coordinates: PersistedLatLon[]): L.LatLngTuple[] {
  return coordinates.map(([lat, lon]) => [lat, lon])
}
