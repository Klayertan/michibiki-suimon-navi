import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import L from 'leaflet'
import { MapWorkspace } from '../../MapWorkspace'
import { FieldLayer } from '../FieldLayer'
import { ObservationLayer } from '../ObservationLayer'
import { WaterControlLayer } from '../WaterControlLayer'
import { WaterMeasurementLayer } from '../WaterMeasurementLayer'
import { WaterPlacementLayer } from '../WaterPlacementLayer'
import { WaterWorkspace } from '../../../../features/water/WaterWorkspace'
import { fieldRepository } from '../../../../services/fields/legacyFieldRepository'
import { observationRepository } from '../../../../services/observations/legacyObservationRepository'
import { waterControlRepository } from '../../../../services/water/legacyWaterControlRepository'
import { recordedWaterMeasurementRepository } from '../../../../services/water/recordedWaterMeasurementRepository'
import { useActiveFieldStore } from '../../../../store/useActiveFieldStore'
import { useMapLayersStore } from '../../../../store/useMapLayersStore'
import { useSelectedEntityStore } from '../../../../store/useSelectedEntityStore'
import { useWaterPlacementStore } from '../../../../store/useWaterPlacementStore'
import type { WaterLevelMeasurement } from '../../../../domain/water/types'

const SQUARE: [number, number][] = [
  [35, 135],
  [35, 135.002],
  [35.002, 135.002],
  [35.002, 135],
]

function stubMeasurements(measurements: WaterLevelMeasurement[]) {
  vi.spyOn(recordedWaterMeasurementRepository, 'getSnapshot').mockReturnValue({
    measurements, loading: false, error: null,
  })
  vi.spyOn(recordedWaterMeasurementRepository, 'ensureLoaded').mockImplementation(() => {})
}

const MEASUREMENT: WaterLevelMeasurement = {
  id: 'mo-1', sessionId: 'rec-1', latitude: 35.001, longitude: 135.001,
  timestamp: '2026-08-09T00:00:00.000Z', waterLevel: 4.5, note: '', fieldId: 'f1',
  fixQuality: 2, satelliteCount: 10, hdop: 0.9, fixAugmented: true, positionSource: 'qz1_serial',
}

describe('water map layers', () => {
  beforeEach(() => {
    window.localStorage.clear()
    fieldRepository.refresh?.()
    observationRepository.refresh()
    waterControlRepository.refresh()
    useActiveFieldStore.getState().setActiveFieldId(null)
    useSelectedEntityStore.getState().clear()
    useWaterPlacementStore.getState().cancel()
    useMapLayersStore.setState((state) => ({
      visibility: { ...state.visibility, 'water-points': true, 'water-measurements': true },
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not throw when mounted with no map and no data', () => {
    stubMeasurements([])
    expect(() => render(<WaterControlLayer />)).not.toThrow()
    expect(() => render(<WaterMeasurementLayer />)).not.toThrow()
    expect(() => render(<WaterPlacementLayer />)).not.toThrow()
  })

  it('renders one marker per persisted water point, and clicking it selects that point', async () => {
    stubMeasurements([])
    const field = await fieldRepository.create({ name: '北田', coordinates: SQUARE })
    const point = await waterControlRepository.create({
      type: 'gate', fieldId: field.id, fieldName: field.name,
      coordinates: [35.001, 135.001], sourceType: 'manual_map_click',
    })

    const { container } = render(
      <MapWorkspace>
        <WaterControlLayer />
      </MapWorkspace>,
    )

    const symbol = await waitFor(() => {
      const found = container.querySelector('.water-symbol--control')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    // Not color-only: the glyph identifies the type as well as the fill does.
    expect(symbol.textContent).toBe('G')
    expect(symbol.className).toContain('water-symbol--gate')

    fireEvent.click(symbol)
    await waitFor(() => {
      expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'waterControl', id: point.id })
    })
  })

  it('renders water-level readings with a different symbol and its own selected-entity type', async () => {
    stubMeasurements([MEASUREMENT])

    const { container } = render(
      <MapWorkspace>
        <WaterMeasurementLayer />
      </MapWorkspace>,
    )

    const symbol = await waitFor(() => {
      const found = container.querySelector('.water-symbol--measurement')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(container.querySelector('.water-symbol--control')).toBeNull()

    fireEvent.click(symbol)
    await waitFor(() => {
      expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'waterMeasurement', id: 'mo-1' })
    })
  })

  it('hides each water layer independently when its visibility flag is off', async () => {
    stubMeasurements([MEASUREMENT])
    const field = await fieldRepository.create({ name: '北田', coordinates: SQUARE })
    await waterControlRepository.create({
      type: 'gate', fieldId: field.id, fieldName: field.name,
      coordinates: [35.001, 135.001], sourceType: 'manual_map_click',
    })

    const { container } = render(
      <MapWorkspace>
        <WaterControlLayer />
        <WaterMeasurementLayer />
      </MapWorkspace>,
    )
    await waitFor(() => expect(container.querySelector('.water-symbol--control')).not.toBeNull())

    useMapLayersStore.getState().setVisible('water-points', false)
    await waitFor(() => expect(container.querySelector('.water-symbol--control')).toBeNull())
    expect(container.querySelector('.water-symbol--measurement')).not.toBeNull()
  })

  it('coexists with the field, observation and other layers on one map, and never recreates it', async () => {
    stubMeasurements([MEASUREMENT])
    const field = await fieldRepository.create({ name: '北田', coordinates: SQUARE })
    useActiveFieldStore.getState().setActiveFieldId(field.id)
    await observationRepository.create({
      fieldId: field.id, fieldName: field.name, type: 'weed', severity: 'medium',
      coordinates: [35.0005, 135.0005], sourceType: 'manual_map_click',
    })
    await waterControlRepository.create({
      type: 'outlet', fieldId: field.id, fieldName: field.name,
      coordinates: [35.001, 135.001], sourceType: 'manual_map_click',
    })
    const layerGroupSpy = vi.spyOn(L, 'layerGroup')

    const { container, rerender } = render(
      <MapWorkspace>
        <FieldLayer />
        <ObservationLayer />
        <WaterControlLayer />
        <WaterMeasurementLayer />
      </MapWorkspace>,
    )

    const mapNode = await waitFor(() => {
      const node = container.querySelector('.leaflet-container')
      expect(node).not.toBeNull()
      return node
    })
    await waitFor(() => {
      // Field polygon + observation circle are SVG paths; water uses div icons.
      expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(2)
      expect(container.querySelector('.water-symbol--control')).not.toBeNull()
      expect(container.querySelector('.water-symbol--measurement')).not.toBeNull()
    })
    const groupsAfterFirstRender = layerGroupSpy.mock.calls.length

    // Adding a water point must update only the water layer, in place.
    await waterControlRepository.create({
      type: 'inlet', fieldId: field.id, fieldName: field.name,
      coordinates: [35.0015, 135.0015], sourceType: 'manual_map_click',
    })
    await waitFor(() => {
      expect(container.querySelectorAll('.water-symbol--control').length).toBe(2)
    })

    // Simulating a workspace switch must not tear the map down either.
    rerender(
      <MapWorkspace>
        <FieldLayer />
        <ObservationLayer />
        <WaterControlLayer />
        <WaterMeasurementLayer />
      </MapWorkspace>,
    )
    expect(container.querySelector('.leaflet-container')).toBe(mapNode)
    expect(container.querySelector('.water-symbol--measurement')).not.toBeNull()
    // No new LayerGroup was constructed for any layer.
    expect(layerGroupSpy.mock.calls.length).toBe(groupsAfterFirstRender)
  })

  it('creates nothing on an ordinary map click, captures exactly one click when armed, and cancels on Escape', async () => {
    stubMeasurements([])
    const field = await fieldRepository.create({ name: '北田', coordinates: SQUARE })
    useActiveFieldStore.getState().setActiveFieldId(field.id)

    const { container } = render(
      <MapWorkspace>
        <WaterPlacementLayer />
      </MapWorkspace>,
    )
    const mapNode = await waitFor(() => {
      const node = container.querySelector('.leaflet-container')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.click(mapNode)
    expect(useWaterPlacementStore.getState().candidate).toBeNull()

    useWaterPlacementStore.getState().beginMapPlacement('gate')
    await waitFor(() => expect(mapNode.className).toContain('map-workspace--placing'))
    fireEvent.click(mapNode)
    await waitFor(() => expect(useWaterPlacementStore.getState().candidate).not.toBeNull())
    // One-shot: placement disarms itself after the first click.
    expect(useWaterPlacementStore.getState().mapPlacementActive).toBe(false)

    await waitFor(() => expect(container.querySelector('.water-symbol--candidate')).not.toBeNull())

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(useWaterPlacementStore.getState().candidate).toBeNull()
      expect(container.querySelector('.water-symbol--candidate')).toBeNull()
    })
  })

  it('Stage 4B: editing the gate-decision rainfall input never recreates the map or disturbs the water layers', async () => {
    stubMeasurements([])
    const field = await fieldRepository.create({ name: '北田', coordinates: SQUARE })
    useActiveFieldStore.getState().setActiveFieldId(field.id)
    await waterControlRepository.create({
      type: 'gate', fieldId: field.id, fieldName: field.name,
      coordinates: [35.001, 135.001], sourceType: 'manual_map_click',
    })
    const layerGroupSpy = vi.spyOn(L, 'layerGroup')
    const user = userEvent.setup()

    const { container } = render(
      <MapWorkspace>
        <WaterControlLayer />
        <WaterMeasurementLayer />
      </MapWorkspace>,
    )
    // GateDecisionPanel is a plain form, not a map layer -- it lives inside
    // the inspector-panel content, rendered separately from MapWorkspace, but
    // sharing the same document, exactly as it does in the real AppShell.
    render(<WaterWorkspace />)

    const mapNode = await waitFor(() => {
      const node = container.querySelector('.leaflet-container')
      expect(node).not.toBeNull()
      return node
    })
    await waitFor(() => expect(container.querySelector('.water-symbol--control')).not.toBeNull())
    const groupsBeforeTyping = layerGroupSpy.mock.calls.length

    const rainInput = screen.getByLabelText('Rainfall, last 24h (mm)')
    await user.clear(rainInput)
    await user.type(rainInput, '25')
    expect(screen.getByText('閉める')).toBeInTheDocument()

    expect(container.querySelector('.leaflet-container')).toBe(mapNode)
    expect(container.querySelector('.water-symbol--control')).not.toBeNull()
    expect(layerGroupSpy.mock.calls.length).toBe(groupsBeforeTyping)
  })
})
