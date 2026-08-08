import { afterEach, describe, expect, it } from 'vitest'
import { useActiveFieldStore } from '../useActiveFieldStore'

afterEach(() => {
  useActiveFieldStore.getState().setActiveFieldId(null)
})

describe('useActiveFieldStore', () => {
  it('stores only the selected field id', () => {
    useActiveFieldStore.getState().setActiveFieldId('field-42')
    expect(useActiveFieldStore.getState().activeFieldId).toBe('field-42')
  })

  it('clears the active field without retaining a Field object copy', () => {
    useActiveFieldStore.getState().setActiveFieldId('field-42')
    useActiveFieldStore.getState().setActiveFieldId(null)
    expect(useActiveFieldStore.getState().activeFieldId).toBeNull()
    expect('activeField' in useActiveFieldStore.getState()).toBe(false)
  })
})
