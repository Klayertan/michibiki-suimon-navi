import { describe, expect, it } from 'vitest'
import { evaluateGate, finiteGateNumberOr, readGateNumberField } from '../decision'
import {
  AUTHORITATIVE_GATE_THRESHOLDS,
  DEFAULT_GATE_WEATHER,
  HARDCODED_DEFAULT_THRESHOLDS,
  HARDCODED_DEFAULT_WEATHER,
  resolveDefaultWeather,
  resolveGateThresholds,
} from '../gateRules'
import type { GateThresholds, GateWeatherInput } from '../decision'

// The legacy default thresholds (data/gate_rules.json / DEFAULT_GATE_RULES,
// index.html:2946-2954) -- used throughout as the reference rule set.
const THRESHOLDS: GateThresholds = { heavyRain24hMm: 20, lightRain24hMm: 5, forecastRainProbPct: 60, drySpellDays: 3 }

function weather(overrides: Partial<GateWeatherInput> = {}): GateWeatherInput {
  return { rain24hMm: 0, daysSinceRain: 0, forecastRainProbPct: 0, ...overrides }
}

describe('evaluateGate (verbatim port of index.html:3672-3710)', () => {
  it('has exactly the legacy (weather, thresholds) signature -- an accidental third parameter (e.g. a decision profile) must fail this test', () => {
    expect(evaluateGate.length).toBe(2)
  })

  it('reproduces the exact legacy branch outputs -- these strings are transcribed directly from index.html, not cross-executed, because evaluateGate has no export boundary to import through (see decision.ts header)', () => {
    expect(evaluateGate(weather({ rain24hMm: 25 }), THRESHOLDS)).toEqual({
      verdict: 'close',
      label: '閉める',
      reason: '直近24時間で25mmのまとまった降雨がありました。用水は足りているため、水門を閉めて入水を止めます。',
    })
    expect(evaluateGate(weather({ rain24hMm: 10 }), THRESHOLDS)).toEqual({
      verdict: 'hold',
      label: '様子見',
      reason: '直近24時間で10mmの降雨があり、当面の水は確保できています。現状を維持します。',
    })
    expect(evaluateGate(weather({ forecastRainProbPct: 75 }), THRESHOLDS)).toEqual({
      verdict: 'hold',
      label: '様子見',
      reason: '今後24時間の降水確率が75%と高いため、開放は降雨の結果を見てから判断します。',
    })
    expect(evaluateGate(weather({ daysSinceRain: 5 }), THRESHOLDS)).toEqual({
      verdict: 'open',
      label: '開ける',
      reason: '無降雨が5日続いており、乾燥が進んでいます。水門を開けて入水してください。',
    })
    expect(evaluateGate(weather(), THRESHOLDS)).toEqual({
      verdict: 'hold',
      label: '様子見',
      reason: 'しきい値に達した条件はありません。現状を維持します。',
    })
  })

  it('checks rules in legacy priority order: heavy rain wins even when a later rule would also fire', () => {
    // rain24hMm=25 alone would satisfy "light rain" (>=5) and daysSinceRain=10
    // alone would satisfy "dry spell" (>=3) -- heavy rain must still win.
    const decision = evaluateGate(weather({ rain24hMm: 25, daysSinceRain: 10 }), THRESHOLDS)
    expect(decision.verdict).toBe('close')
  })

  it('checks light-rain before forecast/dry-spell, and forecast before dry-spell', () => {
    const lightBeatsForecastAndDrySpell = evaluateGate(
      weather({ rain24hMm: 10, forecastRainProbPct: 90, daysSinceRain: 10 }),
      THRESHOLDS,
    )
    expect(lightBeatsForecastAndDrySpell.reason).toContain('降雨があり')

    const forecastBeatsDrySpell = evaluateGate(
      weather({ rain24hMm: 0, forecastRainProbPct: 90, daysSinceRain: 10 }),
      THRESHOLDS,
    )
    expect(forecastBeatsDrySpell.reason).toContain('降水確率')
  })

  describe('boundary semantics: every threshold comparison is inclusive (>=), never exclusive (>)', () => {
    it('heavyRain24hMm: 19.99 does not close, 20 closes, 20.01 closes', () => {
      expect(evaluateGate(weather({ rain24hMm: 19.99 }), THRESHOLDS).verdict).not.toBe('close')
      expect(evaluateGate(weather({ rain24hMm: 20 }), THRESHOLDS).verdict).toBe('close')
      expect(evaluateGate(weather({ rain24hMm: 20.01 }), THRESHOLDS).verdict).toBe('close')
    })

    it('lightRain24hMm: 4.99 falls through to the default hold, 5 and 5.01 trigger the light-rain hold', () => {
      const below = evaluateGate(weather({ rain24hMm: 4.99 }), THRESHOLDS)
      expect(below.verdict).toBe('hold')
      expect(below.reason).toBe('しきい値に達した条件はありません。現状を維持します。')

      const at = evaluateGate(weather({ rain24hMm: 5 }), THRESHOLDS)
      expect(at.verdict).toBe('hold')
      expect(at.reason).toContain('降雨があり')

      const above = evaluateGate(weather({ rain24hMm: 5.01 }), THRESHOLDS)
      expect(above.reason).toContain('降雨があり')
    })

    it('forecastRainProbPct: 59.99 falls through, 60 and 60.01 trigger the forecast hold', () => {
      const below = evaluateGate(weather({ forecastRainProbPct: 59.99 }), THRESHOLDS)
      expect(below.reason).toBe('しきい値に達した条件はありません。現状を維持します。')

      const at = evaluateGate(weather({ forecastRainProbPct: 60 }), THRESHOLDS)
      expect(at.reason).toContain('降水確率')

      const above = evaluateGate(weather({ forecastRainProbPct: 60.01 }), THRESHOLDS)
      expect(above.reason).toContain('降水確率')
    })

    it('drySpellDays: 2.99 falls through, 3 and 3.01 open the gate', () => {
      const below = evaluateGate(weather({ daysSinceRain: 2.99 }), THRESHOLDS)
      expect(below.verdict).toBe('hold')
      expect(below.reason).toBe('しきい値に達した条件はありません。現状を維持します。')

      const at = evaluateGate(weather({ daysSinceRain: 3 }), THRESHOLDS)
      expect(at.verdict).toBe('open')

      const above = evaluateGate(weather({ daysSinceRain: 3.01 }), THRESHOLDS)
      expect(above.verdict).toBe('open')
    })

    it('integer-adjacent boundaries (19/20/21, 2/3/4) behave identically to the epsilon cases', () => {
      expect(evaluateGate(weather({ rain24hMm: 19 }), THRESHOLDS).verdict).not.toBe('close')
      expect(evaluateGate(weather({ rain24hMm: 20 }), THRESHOLDS).verdict).toBe('close')
      expect(evaluateGate(weather({ rain24hMm: 21 }), THRESHOLDS).verdict).toBe('close')
      expect(evaluateGate(weather({ daysSinceRain: 2 }), THRESHOLDS).verdict).toBe('hold')
      expect(evaluateGate(weather({ daysSinceRain: 3 }), THRESHOLDS).verdict).toBe('open')
      expect(evaluateGate(weather({ daysSinceRain: 4 }), THRESHOLDS).verdict).toBe('open')
    })
  })

  it('handles an extremely large value the same as any other value that clears its threshold', () => {
    expect(evaluateGate(weather({ rain24hMm: 1_000_000 }), THRESHOLDS).verdict).toBe('close')
  })

  it('reproduces the real shipped defaults: data/weather.json + data/gate_rules.json today recommend opening the gate', () => {
    // rain24hMm 0 < heavy(20) and < light(5); forecastRainProbPct 20 < 60;
    // daysSinceRain 4 >= drySpellDays 3 -> open. If this ever fails, either
    // data/weather.json or data/gate_rules.json changed -- a real behavior
    // change to acknowledge, not a bug in this test.
    expect(DEFAULT_GATE_WEATHER).toEqual({ rain24hMm: 0, daysSinceRain: 4, forecastRainProbPct: 20 })
    expect(AUTHORITATIVE_GATE_THRESHOLDS).toEqual(THRESHOLDS)
    const decision = evaluateGate(DEFAULT_GATE_WEATHER, AUTHORITATIVE_GATE_THRESHOLDS)
    expect(decision).toEqual({
      verdict: 'open',
      label: '開ける',
      reason: '無降雨が4日続いており、乾燥が進んでいます。水門を開けて入水してください。',
    })
  })
})

describe('readGateNumberField (port of index.html:3560-3563, readNumberInput)', () => {
  it('parses a valid non-negative number', () => {
    expect(readGateNumberField('12.5', -1)).toBe(12.5)
    expect(readGateNumberField('0', -1)).toBe(0)
  })

  it('falls back on blank, whitespace, non-numeric, negative, and non-finite input', () => {
    expect(readGateNumberField('', 7)).toBe(7)
    expect(readGateNumberField('   ', 7)).toBe(7)
    expect(readGateNumberField('abc', 7)).toBe(7)
    expect(readGateNumberField('-5', 7)).toBe(7)
    expect(readGateNumberField('Infinity', 7)).toBe(7)
    expect(readGateNumberField('-Infinity', 7)).toBe(7)
  })

  it('matches parseFloat\'s leading-numeric-prefix quirk, since that is exactly what legacy does', () => {
    expect(readGateNumberField('12.5mm', -1)).toBe(12.5)
  })
})

describe('finiteGateNumberOr (port of index.html:3555-3558, finiteOr)', () => {
  it('accepts any finite number, including 0 and negatives -- unlike readGateNumberField, this is for trusted config, not live operator input', () => {
    expect(finiteGateNumberOr(0, 99)).toBe(0)
    expect(finiteGateNumberOr(-5, 99)).toBe(-5)
    expect(finiteGateNumberOr(20, 99)).toBe(20)
    expect(finiteGateNumberOr('20', 99)).toBe(20)
  })

  it('falls back on undefined, NaN and non-numeric strings', () => {
    expect(finiteGateNumberOr(undefined, 99)).toBe(99)
    expect(finiteGateNumberOr(Number.NaN, 99)).toBe(99)
    expect(finiteGateNumberOr('abc', 99)).toBe(99)
  })

  it('treats null and an empty string as 0, matching JavaScript\'s own Number(null)/Number("") coercion that legacy relies on -- the same quirk Stage 4A documented for the recording store\'s waterLevel', () => {
    expect(finiteGateNumberOr(null, 99)).toBe(0)
    expect(finiteGateNumberOr('', 99)).toBe(0)
  })
})

describe('resolveGateThresholds (port of index.html:3541-3553, thresholds())', () => {
  it('passes a complete, valid thresholds object through unchanged', () => {
    expect(resolveGateThresholds({ thresholds: { heavyRain24hMm: 30, lightRain24hMm: 8, forecastRainProbPct: 70, drySpellDays: 5 } }))
      .toEqual({ heavyRain24hMm: 30, lightRain24hMm: 8, forecastRainProbPct: 70, drySpellDays: 5 })
  })

  it('falls back to the hardcoded defaults for a missing/non-object thresholds key, or a missing/null/non-object source', () => {
    expect(resolveGateThresholds({})).toEqual(HARDCODED_DEFAULT_THRESHOLDS)
    expect(resolveGateThresholds({ thresholds: 'not an object' })).toEqual(HARDCODED_DEFAULT_THRESHOLDS)
    expect(resolveGateThresholds({ thresholds: null })).toEqual(HARDCODED_DEFAULT_THRESHOLDS)
    expect(resolveGateThresholds(null)).toEqual(HARDCODED_DEFAULT_THRESHOLDS)
    expect(resolveGateThresholds(undefined)).toEqual(HARDCODED_DEFAULT_THRESHOLDS)
    expect(resolveGateThresholds('not an object')).toEqual(HARDCODED_DEFAULT_THRESHOLDS)
  })

  it('merges per-field: a malformed or missing individual field falls back alone, siblings are unaffected', () => {
    expect(resolveGateThresholds({ thresholds: { heavyRain24hMm: 30 } })).toEqual({
      ...HARDCODED_DEFAULT_THRESHOLDS,
      heavyRain24hMm: 30,
    })
    expect(resolveGateThresholds({ thresholds: { heavyRain24hMm: 'not a number', lightRain24hMm: 9 } })).toEqual({
      ...HARDCODED_DEFAULT_THRESHOLDS,
      lightRain24hMm: 9,
    })
  })
})

describe('resolveDefaultWeather (port of the per-field fallback in index.html:3565-3576, populateDecisionInputs)', () => {
  it('passes a complete, valid weather object through unchanged', () => {
    expect(resolveDefaultWeather({ rain24hMm: 3, daysSinceRain: 2, forecastRainProbPct: 40 }))
      .toEqual({ rain24hMm: 3, daysSinceRain: 2, forecastRainProbPct: 40 })
  })

  it('falls back to 0 per missing/malformed field -- not to HARDCODED_DEFAULT_WEATHER\'s per-field values', () => {
    expect(resolveDefaultWeather({})).toEqual({ rain24hMm: 0, daysSinceRain: 0, forecastRainProbPct: 0 })
    expect(resolveDefaultWeather({ daysSinceRain: 'not a number' })).toEqual({ rain24hMm: 0, daysSinceRain: 0, forecastRainProbPct: 0 })
    expect(resolveDefaultWeather(null)).toEqual({ rain24hMm: 0, daysSinceRain: 0, forecastRainProbPct: 0 })
    // Documents the deliberate divergence: HARDCODED_DEFAULT_WEATHER.daysSinceRain
    // is 4, but that constant is never used as a per-field fallback here.
    expect(HARDCODED_DEFAULT_WEATHER.daysSinceRain).toBe(4)
  })
})
