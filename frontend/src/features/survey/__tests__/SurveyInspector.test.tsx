import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { surveyRepository } from '../../../services/surveys/legacySurveyRepository'
import { fieldRepository } from '../../../services/fields/legacyFieldRepository'
import { useActiveSurveyStore } from '../../../store/useActiveSurveyStore'
import { useSelectedEntityStore } from '../../../store/useSelectedEntityStore'
import { SurveyDetail } from '../SurveyDetail'
import { SurveyInspector } from '../SurveyInspector'

function seed(): void {
  window.localStorage.setItem('suimonNaviFieldAnnotationsV2', JSON.stringify({
    schemaVersion: 3,
    fields: [{ id: 'field-1', name: 'Linked rice field', coordinates: [], properties: {} }],
    boundaryTracks: [], waterControlPoints: [], fieldObservations: [], workflowState: {},
    surveySessions: [{
      id: 'session-1', name: 'Morning boundary', fieldId: 'field-1', sourceFileName: 'morning.nmea', measurementType: 'boundary_track',
      rawPoints: [
        { timestamp: '090000', lat: 34.65, lon: 135.83, satellites: 10, hdop: 0.8 },
        { timestamp: '090100', lat: 34.651, lon: 135.831, satellites: 12, hdop: 0.6 },
      ],
    }],
  }))
  surveyRepository.refresh()
  fieldRepository.refresh()
}

describe('Survey workspace and inspector', () => {
  beforeEach(() => {
    window.localStorage.clear()
    surveyRepository.refresh()
    fieldRepository.refresh()
    useActiveSurveyStore.getState().setActiveSurveyId(null)
    useSelectedEntityStore.getState().clear()
  })

  it('shows a proper empty state', () => {
    render(<SurveyInspector />)
    expect(screen.getByText(/No saved survey sessions/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /select survey/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Connect GNSS' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Stop Recording' })).toBeDisabled()
  })

  it('selects a saved session from the workspace selector', async () => {
    seed()
    render(<SurveyInspector />)
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: /select survey/i }), 'session-1')
    expect(useActiveSurveyStore.getState().activeSurveyId).toBe('session-1')
    expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'survey', id: 'session-1' })
  })

  it('shows authoritative point/time/HDOP/satellite/link information without quality invention', () => {
    seed()
    render(<SurveyDetail surveyId="session-1" onBack={() => undefined} />)
    expect(screen.getByRole('heading', { name: 'Morning boundary' })).toBeInTheDocument()
    expect(screen.getByText('090000 – 090100')).toBeInTheDocument()
    expect(screen.getByText('0.6 – 0.8')).toBeInTheDocument()
    expect(screen.getByText('10 – 12')).toBeInTheDocument()
    expect(screen.getByText('Linked rice field')).toBeInTheDocument()
    expect(screen.getByText(/QZ1 assurance is a separate legacy quality system/)).toBeInTheDocument()
  })
})
