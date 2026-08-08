import { useFieldReadError, useFields } from '../../services/fields/useFields'
import { useActiveField } from '../../services/fields/useActiveField'
import { FieldToolbar } from './FieldToolbar'
import { fieldAreaSquareMeters, fieldBoundaryPointCount, formatAreaSquareMeters } from '../../domain/fields/selectors'
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
      {activeField ? (
        <dl className="field-workspace__summary">
          <div>
            <dt>Active field</dt>
            <dd>{activeField.name || activeField.id}</dd>
          </div>
          <div>
            <dt>Area</dt>
            <dd>{formatAreaSquareMeters(fieldAreaSquareMeters(activeField))}</dd>
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
