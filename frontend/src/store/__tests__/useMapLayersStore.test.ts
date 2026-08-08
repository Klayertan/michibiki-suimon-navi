import { describe, expect, it } from 'vitest'
import { MAP_LAYER_IDS, useMapLayersStore } from '../useMapLayersStore'

describe('useMapLayersStore', () => {
  it('has a visibility entry for every declared layer id', () => {
    const { visibility } = useMapLayersStore.getState()
    for (const id of MAP_LAYER_IDS) {
      expect(typeof visibility[id]).toBe('boolean')
    }
  })

  it('toggle() flips only the targeted layer', () => {
    const before = useMapLayersStore.getState().visibility['mission-grid']
    useMapLayersStore.getState().toggle('mission-grid')
    const after = useMapLayersStore.getState().visibility
    expect(after['mission-grid']).toBe(!before)
    expect(after['field-boundary']).toBe(true)
  })

  it('setVisible() sets an explicit value regardless of current state', () => {
    useMapLayersStore.getState().setVisible('gnss-position', false)
    expect(useMapLayersStore.getState().visibility['gnss-position']).toBe(false)
    useMapLayersStore.getState().setVisible('gnss-position', false)
    expect(useMapLayersStore.getState().visibility['gnss-position']).toBe(false)
  })
})
