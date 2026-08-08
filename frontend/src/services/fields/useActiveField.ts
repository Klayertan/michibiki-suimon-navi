import { useEffect } from 'react'
import { useFields } from './useFields'
import { useActiveFieldStore } from '../../store/useActiveFieldStore'
import { useSelectedEntityStore } from '../../store/useSelectedEntityStore'
import { findFieldById } from '../../domain/fields/selectors'
import type { Field } from '../../domain/fields/types'

/**
 * Clears activeFieldId once it no longer names a real field (removed by an
 * external writer, or never existed -- e.g. a stale id from an old session).
 * Mounted once at the app root (see app/App.tsx), like
 * services/drone/useDroneBackendStatus.ts, so it runs regardless of which
 * workspace is active. Deliberately does not auto-select a field when none is
 * active -- selection is always an explicit operator action (task section 18).
 */
export function useActiveFieldReconciliation(): void {
  const fields = useFields()
  const activeFieldId = useActiveFieldStore((state) => state.activeFieldId)
  const setActiveFieldId = useActiveFieldStore((state) => state.setActiveFieldId)
  const selectedEntity = useSelectedEntityStore((state) => state.selectedEntity)
  const clearSelection = useSelectedEntityStore((state) => state.clear)

  useEffect(() => {
    if (activeFieldId && !fields.some((field) => field.id === activeFieldId)) {
      setActiveFieldId(null)
      if (selectedEntity?.type === 'field' && selectedEntity.id === activeFieldId) {
        clearSelection()
      }
    }
  }, [fields, activeFieldId, selectedEntity, setActiveFieldId, clearSelection])
}

/**
 * The active Field object, derived from the live field list and
 * useActiveFieldStore's id -- never stored as a second copy (task section 9:
 * "avoid two sources of truth"). Safe to call from multiple components.
 */
export function useActiveField(): Field | null {
  const fields = useFields()
  const activeFieldId = useActiveFieldStore((state) => state.activeFieldId)
  return findFieldById(fields, activeFieldId)
}
