import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type L from 'leaflet'
import { fieldRepository } from '../../../services/fields/legacyFieldRepository'
import { observationRepository } from '../../../services/observations/legacyObservationRepository'
import { surveyRepository } from '../../../services/surveys/legacySurveyRepository'
import { useActiveFieldStore } from '../../../store/useActiveFieldStore'
import { useLiveGnssStore } from '../../../store/useLiveGnssStore'
import { useObservationPlacementStore } from '../../../store/useObservationPlacementStore'
import { useSelectedEntityStore } from '../../../store/useSelectedEntityStore'
import type { SurveyRecord } from '../../../domain/surveys/types'
import { MapWorkspace } from '../../../components/map/MapWorkspace'
import { useMapInstance } from '../../../components/map/MapContext'
import { FieldLayer } from '../../../components/map/layers/FieldLayer'
import { ObservationPlacementLayer } from '../../../components/map/layers/ObservationPlacementLayer'
import { SurveyBoundaryPreviewLayer } from '../../../components/map/layers/SurveyBoundaryPreviewLayer'
import { ObservationComposer } from '../ObservationComposer'
import { SurveyFieldRegistration } from '../SurveyFieldRegistration'
import { getBoundaryAreaAvailability } from '../../../domain/fields/area'
import { formatAreaSquareMeters } from '../../../domain/fields/selectors'
import { prepareSurveyBoundary } from '../../../domain/surveys/surveyBoundary'

let mapInstance: L.Map | null = null
function MapProbe() { mapInstance = useMapInstance(); return null }

const record: SurveyRecord = {
  id: 'session-1', name: 'Morning walk', fieldId: null,
  session: { id: 'session-1', name: 'Morning walk', fieldId: null, sourceFileName: 'walk.nmea', measurementType: 'boundary_track', createdAt: null, uploadedAt: null, rawNmeaStored: false, rawNmeaLineCount: 4, points: [] },
  track: { id: 'track-1', name: 'Boundary', fieldId: null, sourceSessionId: 'session-1', createdAt: null, fixQualitySummary: null, coordinates: [[34.65, 135.83], [34.65, 135.831], [34.651, 135.831], [34.65001, 135.83001]] },
  displayCoordinates: [],
}

describe('Stage 3C survey and observation workflows', () => {
  beforeEach(() => {
    localStorage.clear(); fieldRepository.refresh(); surveyRepository.refresh(); observationRepository.refresh()
    useActiveFieldStore.getState().setActiveFieldId(null); useSelectedEntityStore.getState().clear(); useObservationPlacementStore.getState().cancel()
    useLiveGnssStore.getState().applySnapshot({ connectionState: 'connected', currentFix: null, baudRate: 115200, lineCount: 0, malformedLineCount: 0, message: null, transportLabel: 'test', reconnectAttempt: 0, reconnectMaxAttempts: 0 })
    mapInstance = null
  })

  it('previews and registers a survey boundary through FieldRepository, updates active state, and renders immediately', async () => {
    localStorage.setItem('suimonNaviFieldAnnotationsV2', JSON.stringify({ schemaVersion: 3, fields: [], boundaryTracks: [{ id: 'track-1', sourceSessionId: 'session-1', fieldId: null, coordinates: record.track!.coordinates }], waterControlPoints: [], surveySessions: [{ id: 'session-1', fieldId: null, rawPoints: [{ lat: 34.65, lon: 135.83 }] }], fieldObservations: [], workflowState: { lastExportedAt: null } }))
    fieldRepository.refresh(); surveyRepository.refresh()
    const { container } = render(<><MapWorkspace><FieldLayer /><SurveyBoundaryPreviewLayer /></MapWorkspace><SurveyFieldRegistration survey={record} /></>)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Use as Field Boundary' }))
    expect(screen.getByText(/4 points/)).toBeInTheDocument()

    // Area is shown in the preview, before the field is saved (task section
    // 6), computed from the same coordinates that will be persisted.
    const previewAreaAvailability = getBoundaryAreaAvailability(prepareSurveyBoundary(record).coordinates)
    expect(previewAreaAvailability.status).toBe('ok')
    const previewAreaM2 = previewAreaAvailability.status === 'ok' ? previewAreaAvailability.areaM2 : NaN
    expect(screen.getByText(formatAreaSquareMeters(previewAreaM2))).toBeInTheDocument()

    await waitFor(() => expect(container.querySelector('path[stroke="#f59e0b"]')).not.toBeNull())
    await userEvent.setup().click(screen.getByRole('button', { name: 'Register Field' }))
    await waitFor(() => expect(useActiveFieldStore.getState().activeFieldId).not.toBeNull())
    const fieldId = useActiveFieldStore.getState().activeFieldId!
    expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'field', id: fieldId })
    await waitFor(() => expect(container.querySelector('path[stroke="#facc15"]')).not.toBeNull())
    const raw = JSON.parse(localStorage.getItem('suimonNaviFieldAnnotationsV2')!)
    expect(raw.fields[0].coordinates[0]).toEqual([34.65, 135.83])
    expect(raw.fields[0].sourceSessionId).toBe('session-1')
    expect(raw.surveySessions[0].rawPoints).toEqual([{ lat: 34.65, lon: 135.83 }])
    expect(raw.surveySessions[0].fieldId).toBe(fieldId)
    // Preview area === resulting saved field area (task section 10).
    expect(raw.fields[0].properties.areaM2).toBe(previewAreaM2)
  })

  it('creates an observation from current GNSS and requires explicit Save Anyway outside the active field', async () => {
    const field = await fieldRepository.create({ name: 'North', coordinates: record.track!.coordinates as [number, number][] })
    useActiveFieldStore.getState().setActiveFieldId(field.id)
    useLiveGnssStore.getState().applySnapshot({ connectionState: 'connected', currentFix: { id: 'live', lat: 35, lon: 136, timestamp: null, timestampUtcMs: null, fixQuality: 2, fixValid: true, satellites: 12, hdop: .7, altitudeMsl: null, augmented: true, receivedAtMs: Date.now(), rawLine: '$GNGGA' }, baudRate: 115200, lineCount: 1, malformedLineCount: 0, message: null, transportLabel: 'test', reconnectAttempt: 0, reconnectMaxAttempts: 0 })
    render(<ObservationComposer />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add Observation' }))
    await user.selectOptions(screen.getByLabelText('Type'), 'insect')
    await user.selectOptions(screen.getByLabelText('Severity'), 'high')
    await user.type(screen.getByLabelText('Notes'), 'outside check')
    await user.click(screen.getByRole('button', { name: 'Use Current GNSS' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/outside the active field/)
    await user.click(screen.getByRole('button', { name: 'Save Anyway' }))
    const stored = observationRepository.getSnapshot().observations[0]
    expect(stored).toMatchObject({ fieldId: field.id, type: 'insect', coordinates: [35, 136], properties: { severity: 'high', memo: 'outside check', sourceType: 'qz1_current_position' } })
  })

  it('refuses "Use Current GNSS" for a stale fix even though one was received (Stage 5B)', async () => {
    const field = await fieldRepository.create({ name: 'North', coordinates: record.track!.coordinates as [number, number][] })
    useActiveFieldStore.getState().setActiveFieldId(field.id)
    // A fix older than the legacy DEFAULT_FIX_STALE_MS (10s) -- this is
    // exactly the shape a 'stalled' GNSS link leaves behind: currentFix is
    // still non-null (task section 11: "preserve the last known fix"), but
    // it must no longer be usable as "current".
    useLiveGnssStore.getState().applySnapshot({
      connectionState: 'stalled', currentFix: { id: 'live', lat: 35, lon: 136, timestamp: null, timestampUtcMs: null, fixQuality: 2, fixValid: true, satellites: 12, hdop: .7, altitudeMsl: null, augmented: true, receivedAtMs: Date.now() - 15_000, rawLine: '$GNGGA' },
      baudRate: 115200, lineCount: 1, malformedLineCount: 0, message: null, transportLabel: 'test', reconnectAttempt: 0, reconnectMaxAttempts: 0,
    })
    render(<ObservationComposer />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add Observation' }))
    expect(screen.getByRole('button', { name: 'Use Current GNSS' })).toBeDisabled()
    expect(screen.getByText(/stale/i)).toBeInTheDocument()
    expect(screen.getByText(/not producing new fixes/i)).toBeInTheDocument()
    expect(useObservationPlacementStore.getState().candidate).toBeNull()
  })

  it('arms map placement explicitly, consumes one map click, and Escape cancels without saving', async () => {
    const field = await fieldRepository.create({ name: 'North', coordinates: record.track!.coordinates as [number, number][] })
    useActiveFieldStore.getState().setActiveFieldId(field.id)
    render(<><ObservationComposer /><MapWorkspace><ObservationPlacementLayer /><MapProbe /></MapWorkspace></>)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add Observation' }))
    await user.click(screen.getByRole('button', { name: 'Place on Map' }))
    expect(useObservationPlacementStore.getState().mapPlacementActive).toBe(true)
    await act(() => { mapInstance!.fire('click', { latlng: { lat: 34.6502, lng: 135.8302 } }) })
    expect(useObservationPlacementStore.getState().candidate).toMatchObject({ coordinates: [34.6502, 135.8302], sourceType: 'manual_map_click', outsideField: false })
    useObservationPlacementStore.getState().beginMapPlacement()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useObservationPlacementStore.getState()).toMatchObject({ mapPlacementActive: false, candidate: null })
    expect(observationRepository.getSnapshot().observations).toHaveLength(0)
  })
})
