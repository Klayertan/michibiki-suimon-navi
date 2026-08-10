import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GateDecisionPanel } from '../GateDecisionPanel'

describe('GateDecisionPanel', () => {
  it('prefills from the real shipped data/weather.json and shows the resulting recommendation', () => {
    render(<GateDecisionPanel contextualMeasurementCount={0} />)

    expect(screen.getByLabelText('Rainfall, last 24h (mm)')).toHaveValue('0')
    expect(screen.getByLabelText('Days since rain')).toHaveValue('4')
    expect(screen.getByLabelText('Forecast rain probability, next 24h (%)')).toHaveValue('20')
    expect(screen.getByText('開ける')).toBeInTheDocument()
    expect(screen.getByText(/無降雨が4日続いており/)).toBeInTheDocument()
  })

  it('shows the real data/gate_rules.json thresholds, read-only (no threshold input exists)', () => {
    render(<GateDecisionPanel contextualMeasurementCount={0} />)
    expect(screen.getByText('heavy rain ≥ 20mm · light rain ≥ 5mm · forecast ≥ 60% · dry spell ≥ 3d')).toBeInTheDocument()
    expect(screen.queryByLabelText(/threshold/i)).not.toBeInTheDocument()
    // Only the three weather fields are editable.
    expect(screen.getAllByRole('textbox')).toHaveLength(3)
  })

  it('recomputes the verdict live as rainfall crosses the heavy-rain threshold', async () => {
    const user = userEvent.setup()
    render(<GateDecisionPanel contextualMeasurementCount={0} />)

    const rainInput = screen.getByLabelText('Rainfall, last 24h (mm)')
    await user.clear(rainInput)
    await user.type(rainInput, '25')

    expect(screen.getByText('閉める')).toBeInTheDocument()
    expect(screen.getByText(/直近24時間で25mmのまとまった降雨がありました/)).toBeInTheDocument()
    expect(screen.queryByText('開ける')).not.toBeInTheDocument()
  })

  it('treats an invalid rainfall entry as 0, matching legacy readNumberInput fallback semantics', async () => {
    const user = userEvent.setup()
    render(<GateDecisionPanel contextualMeasurementCount={0} />)

    const rainInput = screen.getByLabelText('Rainfall, last 24h (mm)')
    await user.clear(rainInput)
    await user.type(rainInput, '-5')

    // -5 falls back to 0; with rain=0, forecast=20 and daysSinceRain=4 (default,
    // untouched by this edit) the gate should still recommend opening.
    expect(screen.getByText('開ける')).toBeInTheDocument()
  })

  it('is exactly at the boundary when rainfall equals the heavy-rain threshold (>= is inclusive)', async () => {
    const user = userEvent.setup()
    render(<GateDecisionPanel contextualMeasurementCount={0} />)

    const rainInput = screen.getByLabelText('Rainfall, last 24h (mm)')
    await user.clear(rainInput)
    await user.type(rainInput, '20')

    expect(screen.getByText('閉める')).toBeInTheDocument()
  })

  it('shows the field-independence note, so operators do not assume this changes per selected field', () => {
    render(<GateDecisionPanel contextualMeasurementCount={0} />)
    expect(screen.getByText(/Independent of the field selected below/)).toBeInTheDocument()
  })

  it('shows recorded water-level readings as context only, and never lets them influence the verdict', () => {
    const { rerender } = render(<GateDecisionPanel contextualMeasurementCount={0} />)
    expect(screen.queryByText(/Context only/)).not.toBeInTheDocument()
    const decisionWithNoReadings = screen.getByText('開ける').textContent

    rerender(<GateDecisionPanel contextualMeasurementCount={3} />)
    expect(screen.getByText('3 water-level readings recorded for this field. Context only — not used by this recommendation.')).toBeInTheDocument()
    // Same weather/thresholds -> identical verdict regardless of reading count.
    expect(screen.getByText('開ける').textContent).toBe(decisionWithNoReadings)
  })

  it('uses singular wording for exactly one reading', () => {
    render(<GateDecisionPanel contextualMeasurementCount={1} />)
    expect(screen.getByText(/^1 water-level reading recorded/)).toBeInTheDocument()
  })
})
