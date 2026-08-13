import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import L from 'leaflet'
import { fieldRepository } from '../../../../services/fields/legacyFieldRepository'
import { surveyRepository } from '../../../../services/surveys/legacySurveyRepository'
import { useActiveSurveyStore } from '../../../../store/useActiveSurveyStore'
import { useSelectedEntityStore } from '../../../../store/useSelectedEntityStore'
import { MapWorkspace } from '../../MapWorkspace'
import { FieldLayer } from '../FieldLayer'
import { SurveyLayer } from '../SurveyLayer'
import { toLeafletLatLngs } from '../surveyCoordinates'

function seedSurvey(): void {
  window.localStorage.setItem('suimonNaviFieldAnnotationsV2', JSON.stringify({
    schemaVersion: 3, fields: [], waterControlPoints: [], fieldObservations: [], workflowState: {},
    surveySessions: [{ id: 'session-1', name: 'Stored survey', rawPoints: [{ lat: 34.65, lon: 135.83 }, { lat: 34.651, lon: 135.832 }] }],
    boundaryTracks: [],
  }))
  surveyRepository.refresh()
}

describe('SurveyLayer', () => {
  beforeEach(() => {
    window.localStorage.clear()
    surveyRepository.refresh()
    useActiveSurveyStore.getState().setActiveSurveyId(null)
    useSelectedEntityStore.getState().clear()
  })

  it('converts only at the Leaflet boundary without swapping coordinate order', () => {
    expect(toLeafletLatLngs([[34.65, 135.83]])).toEqual([[34.65, 135.83]])
  })

  it('renders a saved track, selects it on click, and keeps the map instance', async () => {
    seedSurvey()
    const { container } = render(<MapWorkspace><SurveyLayer /></MapWorkspace>)
    const mapNode = container.querySelector('.leaflet-container')
    const path = await waitFor(() => {
      const found = container.querySelector('path[stroke="#b45309"]')
      expect(found).not.toBeNull()
      return found!
    })
    fireEvent.click(path)
    await waitFor(() => {
      expect(useActiveSurveyStore.getState().activeSurveyId).toBe('session-1')
      expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'survey', id: 'session-1' })
    })
    expect(container.querySelector('.leaflet-container')).toBe(mapNode)
  })

  it('coexists with FieldLayer and creates one persistent group per layer', async () => {
    seedSurvey()
    await fieldRepository.create({ name: 'Field', coordinates: [[34.65, 135.83], [34.65, 135.84], [34.66, 135.84]] })
    surveyRepository.refresh()
    const layerGroupSpy = vi.spyOn(L, 'layerGroup')
    const { container, rerender } = render(<MapWorkspace><FieldLayer /><SurveyLayer /></MapWorkspace>)
    const mapNode = container.querySelector('.leaflet-container')
    await waitFor(() => expect(container.querySelectorAll('.leaflet-overlay-pane path')).toHaveLength(2))
    rerender(<MapWorkspace><FieldLayer /><SurveyLayer /></MapWorkspace>)
    expect(container.querySelector('.leaflet-container')).toBe(mapNode)
    expect(layerGroupSpy).toHaveBeenCalledTimes(2)
  })
})
