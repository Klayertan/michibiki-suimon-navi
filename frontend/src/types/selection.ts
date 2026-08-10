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
  /**
   * A water control point (gate/inlet/outlet/sensor/photo) from the annotation
   * store, and a water-level reading from the recording store. These are two
   * genuinely different persisted records in two different databases with no
   * link between them, so they stay two entity types rather than one ambiguous
   * "water" type. Stage 4A replaced the earlier speculative `water`/`sluice`
   * placeholders, which never had backing data.
   */
  | { type: 'waterControl'; id: string }
  | { type: 'waterMeasurement'; id: string }
  | { type: 'mission'; id: string }
  | { type: 'waypoint'; id: string }
  | null
