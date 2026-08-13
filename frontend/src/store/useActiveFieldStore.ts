import { create } from 'zustand'

/**
 * Which field is "active" across workspaces -- just the id (task section 9:
 * "avoid two sources of truth"). The Field object itself is always derived
 * from the live repository via services/fields/useActiveField.ts's
 * useActiveField(), never duplicated into this store. Self-heals if the
 * active field disappears from persistence -- see
 * useActiveFieldReconciliation(), mounted once at the app root.
 */
interface ActiveFieldState {
  activeFieldId: string | null
  setActiveFieldId: (id: string | null) => void
}

export const useActiveFieldStore = create<ActiveFieldState>((set) => ({
  activeFieldId: null,
  setActiveFieldId: (id) => set({ activeFieldId: id }),
}))
