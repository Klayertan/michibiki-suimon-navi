import type { Field } from './types'

export function fieldAreaSquareMeters(field: Field): number {
  return field.properties.areaM2
}

export function fieldBoundaryPointCount(field: Field): number {
  return field.coordinates.length
}

/**
 * en-US grouping (e.g. "12,450 m²") regardless of the browser locale --
 * this app has no i18n layer yet, and a stable format matters more than
 * locale-correct grouping for a Stage 2 inspector.
 */
export function formatAreaSquareMeters(areaM2: number): string {
  return `${Math.round(areaM2).toLocaleString('en-US')} m²`
}

export function fieldLastUpdated(field: Field): string {
  return field.properties.updatedAt
}

export function findFieldById(fields: Field[], id: string | null): Field | null {
  if (!id) return null
  return fields.find((field) => field.id === id) ?? null
}

/** Stable sort by name, matching the order a compact field selector should list them in. */
export function sortFieldsByName(fields: Field[]): Field[] {
  return [...fields].sort((a, b) => a.name.localeCompare(b.name, 'ja'))
}
