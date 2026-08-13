import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import L from 'leaflet'
import { MapWorkspace } from '../../MapWorkspace'
import { FieldLayer } from '../FieldLayer'
import { fieldRepository } from '../../../../services/fields/legacyFieldRepository'
import { useActiveFieldStore } from '../../../../store/useActiveFieldStore'
import { useSelectedEntityStore } from '../../../../store/useSelectedEntityStore'

const SQUARE: [number, number][] = [
  [35, 135],
  [35, 135.001],
  [35.001, 135.001],
  [35.001, 135],
]

describe('FieldLayer', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useActiveFieldStore.getState().setActiveFieldId(null)
    useSelectedEntityStore.getState().clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not throw when mounted with no map yet, or with no fields', () => {
    expect(() => render(<FieldLayer />)).not.toThrow()
  })

  it('renders one polygon path per persisted field once the map exists, and clicking one selects it', async () => {
    const field = await fieldRepository.create({ name: '北田', coordinates: SQUARE })

    const { container } = render(
      <MapWorkspace>
        <FieldLayer />
      </MapWorkspace>,
    )

    const mapNode = container.querySelector('.leaflet-container')

    const path = await waitFor(() => {
      const found = container.querySelector('path')
      expect(found).not.toBeNull()
      return found as SVGPathElement
    })

    fireEvent.click(path)

    await waitFor(() => {
      expect(useActiveFieldStore.getState().activeFieldId).toBe(field.id)
      expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'field', id: field.id })
    })
    expect(container.querySelector('.leaflet-container')).toBe(mapNode)
  })

  it('re-renders the active field with a different style, without recreating the map', async () => {
    const field = await fieldRepository.create({ name: '北田', coordinates: SQUARE })
    const layerGroupSpy = vi.spyOn(L, 'layerGroup')

    const { container } = render(
      <MapWorkspace>
        <FieldLayer />
      </MapWorkspace>,
    )
    const mapNode = container.querySelector('.leaflet-container')
    expect(mapNode).not.toBeNull()

    useActiveFieldStore.getState().setActiveFieldId(field.id)

    await waitFor(() => {
      const path = container.querySelector('path')
      // The active-field style sets stroke color #facc15 (see FieldLayer.tsx).
      expect(path?.getAttribute('stroke')).toBe('#facc15')
    })
    // Same map DOM node identity -- MapWorkspace's own effect never re-ran.
    expect(container.querySelector('.leaflet-container')).toBe(mapNode)

    await fieldRepository.update(field.id, { name: 'renamed without remount' })
    await waitFor(() => expect(container.querySelector('path')).not.toBeNull())
    expect(container.querySelector('.leaflet-container')).toBe(mapNode)
    expect(layerGroupSpy).toHaveBeenCalledTimes(1)
  })
})
