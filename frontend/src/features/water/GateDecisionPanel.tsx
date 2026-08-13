import { useState } from 'react'
import { evaluateGate, readGateNumberField } from '../../domain/water/decision'
import { AUTHORITATIVE_GATE_THRESHOLDS, DEFAULT_GATE_WEATHER } from '../../domain/water/gateRules'
import './WaterWorkspace.css'

interface GateDecisionPanelProps {
  /**
   * How many water-level readings exist for the currently active field, so
   * this panel can show them as context without ever letting them influence
   * `evaluateGate()` -- see decision.ts's header and the Stage 4A/4B audits.
   * Passed in rather than read directly, so this component never needs to
   * know what "active field" means.
   */
  contextualMeasurementCount: number
}

/**
 * The gate open/hold/close recommendation, ported unmodified from
 * `evaluateGate()` (index.html:3672-3710). This panel is deliberately
 * **field-independent**: legacy's decision inputs are a single global
 * rain/threshold configuration (`data/gate_rules.json`, `fieldId:
 * "field-001"`), not one per registered field, so selecting a different field
 * elsewhere in this workspace does not change anything here.
 *
 * Two things are intentionally absent, both confirmed display-only or
 * out-of-scope by the Stage 4A/4B audits:
 *  - The legacy "判断プロファイル" (decision profile) selector never reaches
 *    `evaluateGate()` or its thresholds in the legacy app either (it only
 *    relabels an unrelated summary card, and a comment in index.html
 *    separately confirms it must never affect the proof/reliability card).
 *    Reproducing it here would misrepresent a no-op control as a real
 *    decision input, so it is omitted rather than faked.
 *  - Threshold values are shown read-only, sourced from `data/gate_rules.json`
 *    (the file legacy's own UI describes as the durable source of truth,
 *    with in-app edits explicitly temporary). Editable threshold overrides
 *    are not reproduced in this stage.
 */
export function GateDecisionPanel({ contextualMeasurementCount }: GateDecisionPanelProps) {
  const [rain24hMm, setRain24hMm] = useState(String(DEFAULT_GATE_WEATHER.rain24hMm))
  const [daysSinceRain, setDaysSinceRain] = useState(String(DEFAULT_GATE_WEATHER.daysSinceRain))
  const [forecastRainProbPct, setForecastRainProbPct] = useState(String(DEFAULT_GATE_WEATHER.forecastRainProbPct))

  const thresholds = AUTHORITATIVE_GATE_THRESHOLDS
  const weather = {
    rain24hMm: readGateNumberField(rain24hMm, 0),
    daysSinceRain: readGateNumberField(daysSinceRain, 0),
    forecastRainProbPct: readGateNumberField(forecastRainProbPct, 0),
  }
  const decision = evaluateGate(weather, thresholds)

  return (
    <section className="gate-decision" aria-label="Gate recommendation">
      <h3 className="water-section-title">Gate recommendation</h3>
      <p className="feature-placeholder__note">
        Independent of the field selected below — this reflects the single configured rule set (data/gate_rules.json).
      </p>

      <div className="gate-decision__inputs">
        <label>
          Rainfall, last 24h (mm)
          <input
            inputMode="decimal"
            value={rain24hMm}
            onChange={(event) => setRain24hMm(event.target.value)}
          />
        </label>
        <label>
          Days since rain
          <input
            inputMode="decimal"
            value={daysSinceRain}
            onChange={(event) => setDaysSinceRain(event.target.value)}
          />
        </label>
        <label>
          Forecast rain probability, next 24h (%)
          <input
            inputMode="decimal"
            value={forecastRainProbPct}
            onChange={(event) => setForecastRainProbPct(event.target.value)}
          />
        </label>
      </div>

      <dl className="water-detail">
        <div>
          <dt>Thresholds (data/gate_rules.json)</dt>
          <dd>
            heavy rain ≥ {thresholds.heavyRain24hMm}mm · light rain ≥ {thresholds.lightRain24hMm}mm · forecast ≥{' '}
            {thresholds.forecastRainProbPct}% · dry spell ≥ {thresholds.drySpellDays}d
          </dd>
        </div>
      </dl>

      <div className={`gate-verdict gate-verdict--${decision.verdict}`} aria-live="polite">
        <strong>{decision.label}</strong>
        <p>{decision.reason}</p>
      </div>

      {contextualMeasurementCount > 0 ? (
        <p className="feature-placeholder__note">
          {contextualMeasurementCount} water-level reading{contextualMeasurementCount === 1 ? '' : 's'} recorded for
          this field. Context only — not used by this recommendation.
        </p>
      ) : null}
    </section>
  )
}
