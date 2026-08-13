import { FieldSelector } from './FieldSelector'
import { FIELD_DELETION_DISABLED_REASON } from '../../services/fields/legacyFieldRepository'
import './FieldToolbar.css'

const CREATION_DEFERRED_REASON =
  'Field creation and boundary drawing are deferred to Stage 2B so polygon semantics and navigation cleanup can be designed safely.'

/**
 * Stage 2's compact field controls. Viewing and selection are live; optional
 * creation/boundary editing/deletion remain visibly unavailable rather than
 * exposing workflows whose lifecycle or cross-store reference semantics are
 * not yet safe.
 */
export function FieldToolbar() {
  return (
    <div className="field-toolbar">
      <FieldSelector />
      <div className="field-toolbar__actions">
        <button type="button" className="ghost-button" disabled title={CREATION_DEFERRED_REASON}>
          New Field
        </button>
        <button type="button" className="ghost-button" disabled title={CREATION_DEFERRED_REASON}>
          Edit Boundary
        </button>
        <button type="button" className="ghost-button" disabled title={FIELD_DELETION_DISABLED_REASON}>
          Delete
        </button>
      </div>
    </div>
  )
}
