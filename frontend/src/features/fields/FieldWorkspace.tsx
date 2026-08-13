import { useFieldReadError, useFields } from '../../services/fields/useFields'
import { useActiveField } from '../../services/fields/useActiveField'
import { FieldToolbar } from './FieldToolbar'
import { fieldAreaSquareMeters, fieldBoundaryPointCount, formatAreaSquareMeters } from '../../domain/fields/selectors'
import { formatAreaA, formatAreaHa } from '../../domain/fields/area'
import './FieldWorkspace.css'

/**
 * The /field route's default content -- rendered into the inspector panel
 * (task section 4/10: the map itself is owned by AppShell/MapWorkspace and
 * stays mounted regardless of route). Toolbar-first, no permanent card list
 * (task section 19); the detailed field card lives in FieldInspector, shown
 * by InspectorPanel whenever a field is selected -- selecting one here (via
 * FieldToolbar's FieldSelector) or on the map both lead there the same way.
 */
export function FieldWorkspace() {
  const fields = useFields()
  const readError = useFieldReadError()
  const activeField = useActiveField()

  // Only meaningful once there's more than one field to sum -- with a single
  // field this would just repeat the active-field summary below (task
  // section 12: "if multiple fields exist").
  const totalAreaM2 =
    fields.length > 1 ? fields.reduce((sum, field) => sum + fieldAreaSquareMeters(field), 0) : null

  return (
    <div className="field-workspace">
      <FieldToolbar />
      {readError ? (
        <p className="feature-placeholder__note" role="alert">
          {readError}
        </p>
      ) : null}
      {fields.length === 0 && !readError ? (
        <p className="feature-placeholder__summary">
          Nothing registered yet. Existing fields saved by the legacy app will appear here automatically when both
          interfaces run on the same origin. Field creation is deferred to Stage 2B.
        </p>
      ) : null}
      {totalAreaM2 !== null ? (
        <p className="field-workspace__totals">
          Registered fields: {fields.length} · Total area: {formatAreaHa(totalAreaM2)}
        </p>
      ) : null}
      {activeField ? (
        <dl className="field-workspace__summary">
          <div>
            <dt>Active field</dt>
            <dd>{activeField.name || activeField.id}</dd>
          </div>
          <div>
            <dt>Area</dt>
            <dd className="field-workspace__area">
              <span>{formatAreaSquareMeters(fieldAreaSquareMeters(activeField))}</span>
              <span className="field-workspace__area-secondary">
                {formatAreaA(fieldAreaSquareMeters(activeField))} · {formatAreaHa(fieldAreaSquareMeters(activeField))}
              </span>
            </dd>
          </div>
          <div>
            <dt>Boundary</dt>
            <dd>{fieldBoundaryPointCount(activeField)} points</dd>
          </div>
        </dl>
      ) : null}
    </div>
  )
}
