import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { fieldRepository } from '../../../../services/fields/legacyFieldRepository'
import { observationRepository } from '../../../../services/observations/legacyObservationRepository'
import { useSelectedEntityStore } from '../../../../store/useSelectedEntityStore'
import { useMapLayersStore } from '../../../../store/useMapLayersStore'
import { InspectorPanel } from '../../../layout/InspectorPanel'
import { MapWorkspace } from '../../MapWorkspace'
import { FieldLayer } from '../FieldLayer'
import { ObservationLayer } from '../ObservationLayer'

describe('ObservationLayer', () => {
  beforeEach(() => {
    localStorage.clear(); fieldRepository.refresh(); observationRepository.refresh(); useSelectedEntityStore.getState().clear()
    useMapLayersStore.getState().setVisible('observations', true)
  })

  it('renders a legacy-compatible marker beside FieldLayer, selects it, and shows stored inspector data', async () => {
    const field = await fieldRepository.create({ name: 'North', coordinates: [[34.65, 135.83], [34.65, 135.831], [34.651, 135.831], [34.65, 135.83]] })
    const observation = await observationRepository.create({ fieldId: field.id, fieldName: field.name, type: 'weed', severity: 'high', memo: 'north edge', coordinates: [34.6502, 135.8302], sourceType: 'manual_map_click' })
    const { container } = render(<><MapWorkspace><FieldLayer /><ObservationLayer /></MapWorkspace><InspectorPanel><div>workspace</div></InspectorPanel></>)
    const mapNode = container.querySelector('.leaflet-container')
    const marker = await waitFor(() => {
      const found = container.querySelector('path[fill="#65a30d"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(container.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(2)
    fireEvent.click(marker)
    await waitFor(() => expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'observation', id: observation.id }))
    expect(screen.getByRole('heading', { name: /雑草 Observation/ })).toBeInTheDocument()
    expect(screen.getByText('north edge')).toBeInTheDocument()
    expect(screen.getByText('North')).toBeInTheDocument()
    expect(container.querySelector('.leaflet-container')).toBe(mapNode)
  })
})
