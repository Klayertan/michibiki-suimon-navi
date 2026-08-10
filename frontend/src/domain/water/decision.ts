/**
 * Gate open/hold/close recommendation — a typed, hand-ported copy of the
 * legacy `evaluateGate()`.
 *
 * Unlike every other Stage 2-4A domain wrapper, this is **not** an import of
 * an existing module: `evaluateGate` lives inline inside `index.html`'s
 * ~3,270-line monolithic `<script>` (index.html:3672-3710), which has no
 * export boundary to import through. It is otherwise exactly the kind of
 * function this migration prefers to wrap unmodified (pure, no DOM, two
 * plain objects in) — so it is transcribed here verbatim rather than
 * redesigned, and pinned by tests that reproduce the legacy source's exact
 * branch order, `>=` comparisons, and Japanese strings
 * (see __tests__/decision.test.ts). Do not "clean up" the wording, reorder
 * the branches, or change any comparison operator: those are the algorithm.
 *
 * Confirmed by the Stage 4A/4B audits, and preserved here:
 *  - The only inputs are 24h rainfall, days since rain, and forecast rain
 *    probability, each compared against one threshold. Nothing else is
 *    consulted -- not a measured water level (Stage 4A's WaterLevelMeasurement),
 *    not the active field, not water control points, not an AI signal.
 *  - `evaluateGate` itself never fetches weather or reads storage; the legacy
 *    app's Open-Meteo auto-fetch (`fetchLiveWeather()`, index.html:3639) is a
 *    separate, DOM-coupled concern this stage does not reproduce (see
 *    docs/HANDOFF.md's Stage 4B section for why).
 *  - The "判断プロファイル" (decision profile) selector never reaches this
 *    function or its thresholds -- it is a display-only label elsewhere in
 *    the legacy UI (index.html:3798, and independently confirmed never to
 *    affect `renderProofCard()` either, per the comment at index.html:5036-5038).
 *    There is deliberately no profile parameter here; `evaluateGate.length`
 *    is pinned at 2 by a test so an accidental future parameter is caught.
 */

export type GateVerdict = 'open' | 'hold' | 'close'

/** Everything `evaluateGate` reads. Units: mm, whole days, percent -- exactly as legacy's `weatherData`/`weatherInputs`. */
export interface GateWeatherInput {
  rain24hMm: number
  daysSinceRain: number
  forecastRainProbPct: number
}

/** The four rules from `data/gate_rules.json`. Units match the input they gate. */
export interface GateThresholds {
  heavyRain24hMm: number
  lightRain24hMm: number
  forecastRainProbPct: number
  drySpellDays: number
}

export interface GateDecision {
  verdict: GateVerdict
  /** The exact Japanese label legacy shows on the verdict badge (開ける/様子見/閉める). */
  label: string
  /** The exact Japanese sentence legacy shows as the reason, including the triggering value. */
  reason: string
}

/**
 * Verbatim port of index.html:3672-3710. Four rules checked in this exact
 * order, each `>=` (inclusive at the boundary); the first that matches wins.
 * No condition met -> "様子見" (hold), the same fallback legacy returns.
 */
export function evaluateGate(weather: GateWeatherInput, thresholds: GateThresholds): GateDecision {
  if (weather.rain24hMm >= thresholds.heavyRain24hMm) {
    return {
      verdict: 'close',
      label: '閉める',
      reason: `直近24時間で${weather.rain24hMm}mmのまとまった降雨がありました。用水は足りているため、水門を閉めて入水を止めます。`,
    }
  }

  if (weather.rain24hMm >= thresholds.lightRain24hMm) {
    return {
      verdict: 'hold',
      label: '様子見',
      reason: `直近24時間で${weather.rain24hMm}mmの降雨があり、当面の水は確保できています。現状を維持します。`,
    }
  }

  if (weather.forecastRainProbPct >= thresholds.forecastRainProbPct) {
    return {
      verdict: 'hold',
      label: '様子見',
      reason: `今後24時間の降水確率が${weather.forecastRainProbPct}%と高いため、開放は降雨の結果を見てから判断します。`,
    }
  }

  if (weather.daysSinceRain >= thresholds.drySpellDays) {
    return {
      verdict: 'open',
      label: '開ける',
      reason: `無降雨が${weather.daysSinceRain}日続いており、乾燥が進んでいます。水門を開けて入水してください。`,
    }
  }

  return {
    verdict: 'hold',
    label: '様子見',
    reason: 'しきい値に達した条件はありません。現状を維持します。',
  }
}

/**
 * Parses one editable decision-input field exactly like legacy's
 * `readNumberInput()` (index.html:3560-3563): blank, non-numeric, and
 * **negative** values all fall back rather than reaching `evaluateGate` --
 * legacy has no rainfall/day-count field that is meaningfully negative.
 */
export function readGateNumberField(rawValue: string, fallback: number): number {
  const value = Number.parseFloat(rawValue)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Legacy's `finiteOr()` (index.html:3555-3558): used to merge a loaded JSON
 * document over hardcoded defaults, field by field. Unlike
 * `readGateNumberField`, this does **not** reject negative numbers -- legacy
 * never applies that check when reading configuration, only when reading a
 * live operator-editable input box.
 */
export function finiteGateNumberOr(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
