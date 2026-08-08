/**
 * The one generic "what is selected on the map / in a list right now" model.
 * The right-hand inspector renders based on this, never on feature-specific
 * selection state scattered per panel (that scattering is exactly what the
 * legacy app does today — see docs/UI_REDESIGN.md section 6).
 */
export type SelectedEntity =
  | { type: 'field'; id: string }
  | { type: 'survey'; id: string }
  | { type: 'observation'; id: string }
  | { type: 'water'; id: string }
  | { type: 'sluice'; id: string }
  | { type: 'mission'; id: string }
  | { type: 'waypoint'; id: string }
  | null
