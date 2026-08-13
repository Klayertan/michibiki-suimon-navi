import { afterEach, describe, expect, it } from 'vitest'
import { useSelectedEntityStore } from '../useSelectedEntityStore'

afterEach(() => {
  useSelectedEntityStore.setState({ selectedEntity: null })
})

describe('useSelectedEntityStore', () => {
  it('starts with no selection', () => {
    expect(useSelectedEntityStore.getState().selectedEntity).toBeNull()
  })

  it('select() sets the discriminated entity as-is', () => {
    useSelectedEntityStore.getState().select({ type: 'field', id: 'f1' })
    expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'field', id: 'f1' })
  })

  it('selecting a new entity replaces the previous one (single selection model)', () => {
    const { select } = useSelectedEntityStore.getState()
    select({ type: 'field', id: 'f1' })
    select({ type: 'observation', id: 'o1' })
    expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'observation', id: 'o1' })
  })

  it('clear() resets to null', () => {
    const { select, clear } = useSelectedEntityStore.getState()
    select({ type: 'waterControl', id: 'wcp-1' })
    clear()
    expect(useSelectedEntityStore.getState().selectedEntity).toBeNull()
  })
})
