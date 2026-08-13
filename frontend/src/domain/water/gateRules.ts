import gateRulesJson from '@data/gate_rules.json'
import weatherJson from '@data/weather.json'
import { finiteGateNumberOr } from './decision'
import type { GateThresholds, GateWeatherInput } from './decision'

/**
 * Same literal fallback as legacy's `DEFAULT_GATE_RULES.thresholds`
 * (index.html:2946-2954), used only when `data/gate_rules.json` is missing a
 * field or is malformed -- not as the everyday value, which comes from the
 * JSON file itself.
 */
const HARDCODED_DEFAULT_THRESHOLDS: GateThresholds = {
  heavyRain24hMm: 20,
  lightRain24hMm: 5,
  forecastRainProbPct: 60,
  drySpellDays: 3,
}

/** Same literal fallback as legacy's `DEFAULT_WEATHER` (index.html:2955-2961). */
const HARDCODED_DEFAULT_WEATHER: GateWeatherInput = {
  rain24hMm: 0,
  daysSinceRain: 4,
  forecastRainProbPct: 20,
}

/**
 * Mirrors legacy's `thresholds()` (index.html:3541-3553): merge whatever
 * `.thresholds` object is present, field by field, over the hardcoded
 * default. `source` defaults to the real imported `data/gate_rules.json` but
 * is a parameter so tests can exercise malformed input without touching the
 * module-level singleton below.
 */
export function resolveGateThresholds(source: unknown = gateRulesJson): GateThresholds {
  const candidate = source as { thresholds?: unknown } | null | undefined
  const raw = candidate && typeof candidate === 'object' && typeof candidate.thresholds === 'object' && candidate.thresholds !== null
    ? (candidate.thresholds as Record<string, unknown>)
    : {}
  return {
    heavyRain24hMm: finiteGateNumberOr(raw.heavyRain24hMm, HARDCODED_DEFAULT_THRESHOLDS.heavyRain24hMm),
    lightRain24hMm: finiteGateNumberOr(raw.lightRain24hMm, HARDCODED_DEFAULT_THRESHOLDS.lightRain24hMm),
    forecastRainProbPct: finiteGateNumberOr(raw.forecastRainProbPct, HARDCODED_DEFAULT_THRESHOLDS.forecastRainProbPct),
    drySpellDays: finiteGateNumberOr(raw.drySpellDays, HARDCODED_DEFAULT_THRESHOLDS.drySpellDays),
  }
}

/**
 * Mirrors the per-field fallback legacy's `populateDecisionInputs()` actually
 * applies when filling the weather input boxes (`finiteOr(weatherData.X, 0)`,
 * index.html:3567-3569) -- **0**, not `HARDCODED_DEFAULT_WEATHER`'s per-field
 * value. `HARDCODED_DEFAULT_WEATHER` plays a different role in legacy (the
 * whole-object fallback used only when the `data/weather.json` *fetch itself*
 * fails, e.g. under `file://`); a bundled JSON import cannot fail that way, so
 * that branch cannot occur here and is not reproduced. See
 * docs/FRONTEND_ARCHITECTURE.md's Stage 4B section for the full reasoning.
 */
export function resolveDefaultWeather(source: unknown = weatherJson): GateWeatherInput {
  const raw = source && typeof source === 'object' ? (source as Record<string, unknown>) : {}
  return {
    rain24hMm: finiteGateNumberOr(raw.rain24hMm, 0),
    daysSinceRain: finiteGateNumberOr(raw.daysSinceRain, 0),
    forecastRainProbPct: finiteGateNumberOr(raw.forecastRainProbPct, 0),
  }
}

/** The thresholds this build actually ships with, computed once from `data/gate_rules.json`. */
export const AUTHORITATIVE_GATE_THRESHOLDS: GateThresholds = resolveGateThresholds()

/** The weather values the decision panel prefills, computed once from `data/weather.json`. */
export const DEFAULT_GATE_WEATHER: GateWeatherInput = resolveDefaultWeather()

export { HARDCODED_DEFAULT_THRESHOLDS, HARDCODED_DEFAULT_WEATHER }
