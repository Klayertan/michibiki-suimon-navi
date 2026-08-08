import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useActiveFieldReconciliation } from '../useActiveField'
import { useActiveFieldStore } from '../../../store/useActiveFieldStore'
import { useSelectedEntityStore } from '../../../store/useSelectedEntityStore'

vi.mock('../useFields', () => ({
  useFields: () => [],
}))

afterEach(() => {
  useActiveFieldStore.getState().setActiveFieldId(null)
  useSelectedEntityStore.getState().clear()
})

describe('useActiveFieldReconciliation', () => {
  it('clears a stale active field and its matching inspector selection', async () => {
    useActiveFieldStore.getState().setActiveFieldId('missing-field')
    useSelectedEntityStore.getState().select({ type: 'field', id: 'missing-field' })

    renderHook(() => useActiveFieldReconciliation())

    await waitFor(() => {
      expect(useActiveFieldStore.getState().activeFieldId).toBeNull()
      expect(useSelectedEntityStore.getState().selectedEntity).toBeNull()
    })
  })

  it('does not clear a selection for a different entity', async () => {
    useActiveFieldStore.getState().setActiveFieldId('missing-field')
    useSelectedEntityStore.getState().select({ type: 'observation', id: 'observation-7' })

    renderHook(() => useActiveFieldReconciliation())

    await waitFor(() => expect(useActiveFieldStore.getState().activeFieldId).toBeNull())
    expect(useSelectedEntityStore.getState().selectedEntity).toEqual({
      type: 'observation',
      id: 'observation-7',
    })
  })
})
