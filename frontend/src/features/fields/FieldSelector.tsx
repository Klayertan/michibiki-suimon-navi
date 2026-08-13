import { useFields } from '../../services/fields/useFields'
import { useActiveFieldStore } from '../../store/useActiveFieldStore'
import { useSelectedEntityStore } from '../../store/useSelectedEntityStore'
import { fieldAreaSquareMeters, sortFieldsByName } from '../../domain/fields/selectors'
import { formatAreaHa } from '../../domain/fields/area'

/**
 * A compact dropdown, not a permanent card list (task section 19) -- this app
 * has no upper bound on field count in view, and a list would either scroll
 * the whole workspace or force a fixed-height card that's empty most of the
 * time. Selecting here updates both activeFieldId and selectedEntity, exactly
 * like clicking a field polygon on the map does (task section 18: one
 * consistent selection model, not two).
 */
export function FieldSelector() {
  const fields = useFields()
  const activeFieldId = useActiveFieldStore((state) => state.activeFieldId)
  const setActiveFieldId = useActiveFieldStore((state) => state.setActiveFieldId)
  const select = useSelectedEntityStore((state) => state.select)
  const clear = useSelectedEntityStore((state) => state.clear)

  const sorted = sortFieldsByName(fields)

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const id = event.target.value
    if (!id) {
      setActiveFieldId(null)
      clear()
      return
    }
    setActiveFieldId(id)
    select({ type: 'field', id })
  }

  return (
    <select
      className="field-selector"
      aria-label="Select field"
      value={activeFieldId ?? ''}
      onChange={handleChange}
      disabled={sorted.length === 0}
    >
      <option value="">{sorted.length === 0 ? 'No fields registered' : 'Select a field…'}</option>
      {sorted.map((field) => (
        <option key={field.id} value={field.id}>
          {field.name || field.id} · {formatAreaHa(fieldAreaSquareMeters(field))}
        </option>
      ))}
    </select>
  )
}
