import { useEffect, useState } from 'react'
import { useFields } from '../../services/fields/useFields'
import { FIELD_DELETION_DISABLED_REASON, fieldRepository } from '../../services/fields/legacyFieldRepository'
import {
  fieldAreaSquareMeters,
  fieldBoundaryPointCount,
  fieldLastUpdated,
  findFieldById,
  formatAreaSquareMeters,
} from '../../domain/fields/selectors'
import { formatAreaA, formatAreaHa } from '../../domain/fields/area'
import './FieldInspector.css'

interface FieldInspectorProps {
  fieldId: string
  onBack: () => void
}

/**
 * Real field detail card (task section 12) shown by InspectorPanel whenever
 * selectedEntity is a field -- whether that selection came from FieldToolbar's
 * selector, or from clicking the field's polygon on the map (task section 18).
 * Editing here is deliberately narrow: name and memo only. Legacy also allows
 * renaming a field's id with a cascading foreign-key rename across
 * boundaryTracks/surveySessions/waterControlPoints/fieldObservations
 * (js/fields/field-annotation-controller.js saveSelectedFeature()); that is
 * not reproduced here, see docs/UI_REDESIGN.md Stage 2 section.
 */
export function FieldInspector({ fieldId, onBack }: FieldInspectorProps) {
  const fields = useFields()
  const field = findFieldById(fields, fieldId)
  const currentFieldId = field?.id ?? null
  const currentName = field?.name ?? ''
  const currentMemo = field?.properties.memo ?? ''

  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [memo, setMemo] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setName(currentName)
    setMemo(currentMemo)
    setEditing(false)
    setError(null)
  }, [currentFieldId, currentMemo, currentName])

  if (!field) {
    // The field this selection pointed at disappeared (e.g. in another tab)
    // -- fail into a clear message, not a crash.
    return (
      <div className="feature-placeholder">
        <h2 className="feature-placeholder__title">Field</h2>
        <p className="feature-placeholder__summary">This field no longer exists.</p>
        <button type="button" className="ghost-button" onClick={onBack}>
          Back
        </button>
      </div>
    )
  }

  async function saveEdits() {
    setError(null)
    try {
      await fieldRepository.update(field!.id, { name, memo })
      setEditing(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save field. Existing field data was not modified.')
    }
  }

  return (
    <div className="field-inspector">
      <h2 className="feature-placeholder__title">{field.name || field.id}</h2>

      {editing ? (
        <div className="field-inspector__edit-form">
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Memo
            <input value={memo} onChange={(event) => setMemo(event.target.value)} />
          </label>
          <div className="field-toolbar__actions">
            <button type="button" className="ghost-button" onClick={saveEdits}>
              Save
            </button>
            <button type="button" className="ghost-button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <dl className="field-inspector__detail">
          <div>
            <dt>Area</dt>
            <dd className="field-inspector__area">
              <span>{formatAreaSquareMeters(fieldAreaSquareMeters(field))}</span>
              <span className="field-inspector__area-secondary">
                {formatAreaA(fieldAreaSquareMeters(field))} · {formatAreaHa(fieldAreaSquareMeters(field))}
              </span>
            </dd>
          </div>
          <div>
            <dt>Boundary</dt>
            <dd>{fieldBoundaryPointCount(field)} points</dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd>{new Date(fieldLastUpdated(field)).toLocaleString()}</dd>
          </div>
          {field.properties.memo ? (
            <div>
              <dt>Memo</dt>
              <dd>{field.properties.memo}</dd>
            </div>
          ) : null}
        </dl>
      )}

      {error ? <p className="field-toolbar__error">{error}</p> : null}

      {!editing ? (
        <div className="field-toolbar__actions">
          <button type="button" className="ghost-button" onClick={() => setEditing(true)}>
            Edit details
          </button>
          <button type="button" className="ghost-button" disabled title={FIELD_DELETION_DISABLED_REASON}>
            Delete
          </button>
        </div>
      ) : null}

      <button type="button" className="ghost-button" onClick={onBack}>
        Back
      </button>
    </div>
  )
}
