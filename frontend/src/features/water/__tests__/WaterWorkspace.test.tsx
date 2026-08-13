import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InspectorPanel } from '../../../components/layout/InspectorPanel'
import { WaterWorkspace } from '../WaterWorkspace'
import { fieldRepository } from '../../../services/fields/legacyFieldRepository'
import { waterControlRepository } from '../../../services/water/legacyWaterControlRepository'
import { recordedWaterMeasurementRepository } from '../../../services/water/recordedWaterMeasurementRepository'
import { useActiveFieldStore } from '../../../store/useActiveFieldStore'
import { useLiveGnssStore } from '../../../store/useLiveGnssStore'
import { useSelectedEntityStore } from '../../../store/useSelectedEntityStore'
import { useWaterPlacementStore } from '../../../store/useWaterPlacementStore'
import type { WaterLevelMeasurement } from '../../../domain/water/types'

const SQUARE: [number, number][] = [
  [35, 135],
  [35, 135.002],
  [35.002, 135.002],
  [35.002, 135],
]

const MEASUREMENT: WaterLevelMeasurement = {
  id: 'mo-1', sessionId: 'rec-1', latitude: 35.001, longitude: 135.001,
  timestamp: '2026-08-09T00:00:00.000Z', waterLevel: 4.5, note: 'inlet corner', fieldId: 'f1',
  fixQuality: 2, satelliteCount: 10, hdop: 0.9, fixAugmented: true, positionSource: 'qz1_serial',
}

function stubMeasurements(measurements: WaterLevelMeasurement[]) {
  vi.spyOn(recordedWaterMeasurementRepository, 'getSnapshot').mockReturnValue({
    measurements, loading: false, error: null,
  })
  vi.spyOn(recordedWaterMeasurementRepository, 'ensureLoaded').mockImplementation(() => {})
}

async function activeField(name = '北田') {
  const field = await fieldRepository.create({ name, coordinates: SQUARE })
  useActiveFieldStore.getState().setActiveFieldId(field.id)
  return field
}

describe('Water workspace', () => {
  beforeEach(() => {
    window.localStorage.clear()
    fieldRepository.refresh?.()
    waterControlRepository.refresh()
    useActiveFieldStore.getState().setActiveFieldId(null)
    useSelectedEntityStore.getState().clear()
    useWaterPlacementStore.getState().cancel()
    useLiveGnssStore.setState({ currentFix: null })
    stubMeasurements([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prompts for a field rather than erroring when none is active', () => {
    render(<WaterWorkspace />)
    expect(screen.getByText('Select a field to see and add its water points.')).toBeInTheDocument()
  })

  it('shows an empty state for a field with no water points', async () => {
    await activeField()
    render(<WaterWorkspace />)
    expect(screen.getByText(/No water points on this field yet/)).toBeInTheDocument()
  })

  it('lists only the active field’s points, and selecting one opens its inspector', async () => {
    const field = await activeField()
    const mine = await waterControlRepository.create({
      type: 'gate', fieldId: field.id, fieldName: field.name,
      coordinates: [35.001, 135.001], sourceType: 'manual_map_click', memo: 'main intake',
    })
    await waterControlRepository.create({
      type: 'inlet', fieldId: 'someone-else', fieldName: 'Other',
      coordinates: [35.001, 135.001], sourceType: 'manual_map_click',
    })

    const user = userEvent.setup()
    render(
      <InspectorPanel>
        <WaterWorkspace />
      </InspectorPanel>,
    )

    expect(screen.getByText('Water points · 1')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /水門/ }))

    expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'waterControl', id: mine.id })
    expect(await screen.findByRole('heading', { name: mine.name })).toBeInTheDocument()
    expect(screen.getByText('main intake')).toBeInTheDocument()
    expect(screen.getByText('water_gate')).toBeInTheDocument()
  })

  it('creates a point from the current GNSS fix and selects it', async () => {
    const field = await activeField()
    useLiveGnssStore.setState({ currentFix: { lat: 35.001, lon: 135.001, receivedAtMs: Date.now() } as never })
    const user = userEvent.setup()
    render(<WaterWorkspace />)

    await user.click(screen.getByRole('button', { name: 'Add Water Point' }))
    await user.selectOptions(screen.getByLabelText('Type'), 'inlet')
    await user.click(screen.getByRole('button', { name: 'Use Current GNSS' }))
    expect(screen.getByText(/Preview: 35\.0010000, 135\.0010000/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save Water Point' }))

    await waitFor(async () => {
      const points = await waterControlRepository.list()
      expect(points).toHaveLength(1)
      expect(points[0]).toMatchObject({
        type: 'water_inlet',
        relatedFieldId: field.id,
        coordinates: [35.001, 135.001],
        properties: { sourceType: 'qz1_current_position' },
      })
    })
    const [saved] = await waterControlRepository.list()
    expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'waterControl', id: saved.id })
  })

  it('refuses "Use Current GNSS" for a stale fix even though one was received (Stage 5B)', async () => {
    await activeField()
    // Older than the legacy DEFAULT_FIX_STALE_MS (10s) -- exactly what a
    // 'stalled' link leaves behind: currentFix stays non-null but aged out.
    useLiveGnssStore.setState({ connectionState: 'stalled', currentFix: { lat: 35.001, lon: 135.001, receivedAtMs: Date.now() - 15_000 } as never })
    const user = userEvent.setup()
    render(<WaterWorkspace />)
    await user.click(screen.getByRole('button', { name: 'Add Water Point' }))
    expect(screen.getByRole('button', { name: 'Use Current GNSS' })).toBeDisabled()
    expect(screen.getByText(/stale/i)).toBeInTheDocument()
    expect(screen.getByText(/not producing new fixes/i)).toBeInTheDocument()
    expect(useWaterPlacementStore.getState().candidate).toBeNull()
  })

  it('disables Use Current GNSS with no fix and both position buttons with no field', async () => {
    const user = userEvent.setup()
    render(<WaterWorkspace />)
    await user.click(screen.getByRole('button', { name: 'Add Water Point' }))
    expect(screen.getByRole('button', { name: 'Use Current GNSS' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Place on Map' })).toBeDisabled()
    expect(screen.getByText('Select an active field before adding a water point.')).toBeInTheDocument()
  })

  it('arms one-shot map placement and cancels cleanly without saving', async () => {
    await activeField()
    const user = userEvent.setup()
    render(<WaterWorkspace />)

    await user.click(screen.getByRole('button', { name: 'Add Water Point' }))
    await user.click(screen.getByRole('button', { name: 'Place on Map' }))
    expect(useWaterPlacementStore.getState().mapPlacementActive).toBe(true)
    expect(useWaterPlacementStore.getState().pendingType).toBe('gate')
    expect(screen.getByRole('button', { name: 'Click the map…' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useWaterPlacementStore.getState().mapPlacementActive).toBe(false)
    expect(useWaterPlacementStore.getState().candidate).toBeNull()
    expect(await waterControlRepository.list()).toEqual([])
  })

  it('reports an outside-field position but still saves it, matching legacy which never blocks water points', async () => {
    const field = await activeField()
    // Far outside SQUARE.
    useLiveGnssStore.setState({ currentFix: { lat: 36, lon: 136, receivedAtMs: Date.now() } as never })
    const user = userEvent.setup()
    render(<WaterWorkspace />)

    await user.click(screen.getByRole('button', { name: 'Add Water Point' }))
    await user.click(screen.getByRole('button', { name: 'Use Current GNSS' }))
    expect(screen.getByText(/outside the active field boundary/)).toBeInTheDocument()
    // Deliberately NOT a "Save Anyway" gate -- legacy applies no boundary check
    // to water points, so the normal save action stays enabled.
    const save = screen.getByRole('button', { name: 'Save Water Point' })
    expect(save).toBeEnabled()

    await user.click(save)
    await waitFor(async () => {
      const points = await waterControlRepository.list()
      expect(points).toHaveLength(1)
      expect(points[0].relatedFieldId).toBe(field.id)
      expect(points[0].coordinates).toEqual([36, 136])
    })
  })

  it('blocks saving and shows the read error when the store is unreadable', async () => {
    await activeField()
    useLiveGnssStore.setState({ currentFix: { lat: 35.001, lon: 135.001, receivedAtMs: Date.now() } as never })
    const user = userEvent.setup()
    render(<WaterWorkspace />)
    await user.click(screen.getByRole('button', { name: 'Add Water Point' }))
    await user.click(screen.getByRole('button', { name: 'Use Current GNSS' }))

    window.localStorage.setItem('suimonNaviFieldAnnotationsV2', '{broken')
    waterControlRepository.refresh()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save Water Point' })).toBeDisabled()
    })
    expect(screen.getAllByText(/malformed/).length).toBeGreaterThan(0)
  })

  it('lists read-only water-level readings and opens a reading inspector that never asserts a unit', async () => {
    const field = await activeField()
    stubMeasurements([{ ...MEASUREMENT, fieldId: field.id }])
    const user = userEvent.setup()
    render(
      <InspectorPanel>
        <WaterWorkspace />
      </InspectorPanel>,
    )

    expect(screen.getByText('Water levels · 1')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /水位/ }))

    expect(useSelectedEntityStore.getState().selectedEntity).toEqual({ type: 'waterMeasurement', id: 'mo-1' })
    expect(await screen.findByRole('heading', { name: '水位 / Water level' })).toBeInTheDocument()
    expect(screen.getByText('4.5 (unit not recorded)')).toBeInTheDocument()
    expect(screen.getByText('inlet corner')).toBeInTheDocument()
    expect(screen.getByText(/Read-only/)).toBeInTheDocument()
    expect(screen.queryByText(/4\.5 cm|4\.5 mm/)).not.toBeInTheDocument()
  })

  it('explains an ambiguous stored zero instead of showing it as a measured depth', async () => {
    const field = await activeField()
    stubMeasurements([{ ...MEASUREMENT, fieldId: field.id, waterLevel: 0 }])
    const user = userEvent.setup()
    render(
      <InspectorPanel>
        <WaterWorkspace />
      </InspectorPanel>,
    )
    await user.click(screen.getByRole('button', { name: /水位/ }))
    expect(await screen.findByText(/may mean the legacy field was left blank/)).toBeInTheDocument()
  })

  it('surfaces orphaned points separately and explains that reports omit them', async () => {
    const field = await activeField()
    const point = await waterControlRepository.create({
      type: 'gate', fieldId: field.id, fieldName: field.name,
      coordinates: [35.001, 135.001], sourceType: 'manual_map_click',
    })
    // Simulate the legacy field-delete cascade, which unlinks rather than deletes.
    const raw = JSON.parse(window.localStorage.getItem('suimonNaviFieldAnnotationsV2')!)
    raw.waterControlPoints = raw.waterControlPoints.map((item: { id: string }) =>
      item.id === point.id ? { ...item, relatedFieldId: null } : item)
    window.localStorage.setItem('suimonNaviFieldAnnotationsV2', JSON.stringify(raw))
    waterControlRepository.refresh()

    render(<WaterWorkspace />)
    expect(await screen.findByText('Unlinked · 1')).toBeInTheDocument()
    expect(screen.getByText(/still appear on the map but are omitted/)).toBeInTheDocument()
  })

  it('renders the Stage 4B gate recommendation alongside the Stage 4A sections, and it stays independent of field selection', async () => {
    render(<WaterWorkspace />)
    expect(screen.getByRole('region', { name: 'Gate recommendation' })).toBeInTheDocument()
    expect(screen.getByText('開ける')).toBeInTheDocument()

    await activeField()
    // Selecting a field must not perturb the decision -- it has no per-field input.
    expect(screen.getByText('開ける')).toBeInTheDocument()
  })

  it('passes the active field\'s reading count into the decision panel as context, and 0 for no active field', async () => {
    render(<WaterWorkspace />)
    expect(screen.queryByText(/Context only/)).not.toBeInTheDocument()

    const field = await activeField()
    stubMeasurements([{ ...MEASUREMENT, fieldId: field.id }])
    render(<WaterWorkspace />)
    expect(await screen.findByText(/1 water-level reading recorded for this field\. Context only/)).toBeInTheDocument()
  })
})
