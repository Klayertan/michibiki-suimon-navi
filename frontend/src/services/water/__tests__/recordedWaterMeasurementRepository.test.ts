import { describe, expect, it } from 'vitest'
import { buildMarkedObservation } from '@legacy/recording/recording-core.js'
import {
  RecordedWaterMeasurementRepository,
  adaptWaterLevelMeasurement,
} from '../recordedWaterMeasurementRepository'

/** A record exactly as the unchanged legacy builder emits it. */
function legacyWaterLevelRecord(overrides: Record<string, unknown> = {}) {
  return {
    ...(buildMarkedObservation({
      id: 'mo-1',
      sessionId: 'rec-1',
      fix: { lat: 34.6548, lon: 135.83, altitude: 12.5, fixQuality: 2, satellites: 11, hdop: 0.9, augmented: true, rawLine: '$GPGGA,...' },
      fieldId: 'f1',
      observationType: 'water_level',
      note: 'inlet corner',
      waterLevel: 4.5,
      positionSource: 'qz1_serial',
      nowIso: '2026-08-09T00:00:00.000Z',
    } as never) as Record<string, unknown>),
    ...overrides,
  }
}

class FakeRecordingStore {
  // Explicit fields rather than TypeScript parameter properties: this project
  // builds with `erasableSyntaxOnly`.
  readonly records: unknown[]
  readonly failure?: Error

  constructor(records: unknown[], failure?: Error) {
    this.records = records
    this.failure = failure
  }

  async readAll(): Promise<unknown[]> {
    if (this.failure) throw this.failure
    return this.records
  }
}

describe('adaptWaterLevelMeasurement', () => {
  it('reads the legacy record with its named latitude/longitude, not a [lat, lon] tuple', () => {
    const measurement = adaptWaterLevelMeasurement(legacyWaterLevelRecord())
    expect(measurement).not.toBeNull()
    // This store uses a third coordinate convention, distinct from the
    // annotation tuple and from the live-fix lat/lon shape.
    expect(measurement?.latitude).toBe(34.6548)
    expect(measurement?.longitude).toBe(135.83)
    expect((measurement as unknown as { coordinates?: unknown }).coordinates).toBeUndefined()
    expect(measurement?.waterLevel).toBe(4.5)
    expect(measurement?.fieldId).toBe('f1')
    expect(measurement?.sessionId).toBe('rec-1')
    expect(measurement?.fixQuality).toBe(2)
    expect(measurement?.satelliteCount).toBe(11)
    expect(measurement?.hdop).toBe(0.9)
    expect(measurement?.fixAugmented).toBe(true)
    expect(measurement?.positionSource).toBe('qz1_serial')
    expect(measurement?.timestamp).toBe('2026-08-09T00:00:00.000Z')
  })

  it('ignores marked observations that are not water_level', () => {
    expect(adaptWaterLevelMeasurement(legacyWaterLevelRecord({ observationType: 'weed' }))).toBeNull()
    expect(adaptWaterLevelMeasurement(legacyWaterLevelRecord({ observationType: 'other' }))).toBeNull()
  })

  it('preserves a stored 0 rather than coercing it, because blank legacy input persists as 0', () => {
    // js/recording/recording-core.js:218 -- Number(null) === 0 passes the
    // finiteness check, so an empty 水位 field really does land as 0.
    const blankInput = buildMarkedObservation({
      id: 'mo-blank', sessionId: 'rec-1',
      fix: { lat: 34, lon: 135 },
      observationType: 'water_level', waterLevel: null, nowIso: '2026-08-09T00:00:00.000Z',
    } as never) as { waterLevel: unknown }
    expect(blankInput.waterLevel).toBe(0)
    expect(adaptWaterLevelMeasurement(blankInput)?.waterLevel).toBe(0)
  })

  it('also persists 0 when waterLevel is omitted entirely -- null is far rarer than it looks', () => {
    // The builder's default parameter is `waterLevel = null`, so omitting the
    // argument (or passing undefined) still reaches Number(null) === 0. A
    // stored null therefore only happens for a non-numeric value. Pinning this
    // so nobody later "fixes" the adapter to treat 0 as absent.
    const omitted = buildMarkedObservation({
      id: 'mo-2', sessionId: 'rec-1', fix: { lat: 34, lon: 135 },
      observationType: 'water_level', nowIso: '2026-08-09T00:00:00.000Z',
    } as never) as { waterLevel: unknown }
    expect(omitted.waterLevel).toBe(0)
    expect(adaptWaterLevelMeasurement(omitted)?.waterLevel).toBe(0)

    const nonNumeric = buildMarkedObservation({
      id: 'mo-3', sessionId: 'rec-1', fix: { lat: 34, lon: 135 },
      observationType: 'water_level', waterLevel: 'not a number', nowIso: '2026-08-09T00:00:00.000Z',
    } as never) as { waterLevel: unknown }
    expect(nonNumeric.waterLevel).toBeNull()
    expect(adaptWaterLevelMeasurement(nonNumeric)?.waterLevel).toBeNull()
  })

  it('rejects records with unusable coordinates or no id', () => {
    expect(adaptWaterLevelMeasurement({ observationType: 'water_level', id: 'x', latitude: 'a', longitude: 1 })).toBeNull()
    expect(adaptWaterLevelMeasurement({ observationType: 'water_level', latitude: 1, longitude: 1 })).toBeNull()
    expect(adaptWaterLevelMeasurement(null)).toBeNull()
    expect(adaptWaterLevelMeasurement('nope')).toBeNull()
  })
})

describe('RecordedWaterMeasurementRepository', () => {
  it('loads only water_level records across every session', async () => {
    const repository = new RecordedWaterMeasurementRepository(new FakeRecordingStore([
      legacyWaterLevelRecord(),
      legacyWaterLevelRecord({ id: 'mo-2', sessionId: 'rec-2', observationType: 'weed' }),
      legacyWaterLevelRecord({ id: 'mo-3', sessionId: 'rec-2' }),
    ]))
    await repository.refresh()
    const snapshot = repository.getSnapshot()
    expect(snapshot.loading).toBe(false)
    expect(snapshot.error).toBeNull()
    expect(snapshot.measurements.map((item) => item.id)).toEqual(['mo-1', 'mo-3'])
  })

  it('surfaces a read failure instead of looking like an empty store', async () => {
    const repository = new RecordedWaterMeasurementRepository(new FakeRecordingStore([], new Error('IDB unavailable')))
    await repository.refresh()
    expect(repository.getSnapshot()).toMatchObject({
      measurements: [],
      loading: false,
    })
    expect(repository.getSnapshot().error).toMatch(/could not be read/)
  })

  it('is read-only: no create, update or delete surface exists', () => {
    const repository = new RecordedWaterMeasurementRepository(new FakeRecordingStore([]))
    const candidate = repository as unknown as Record<string, unknown>
    expect(candidate.create).toBeUndefined()
    expect(candidate.update).toBeUndefined()
    expect(candidate.delete).toBeUndefined()
  })

  it('notifies subscribers when a refresh completes', async () => {
    const repository = new RecordedWaterMeasurementRepository(new FakeRecordingStore([legacyWaterLevelRecord()]))
    let notifications = 0
    const unsubscribe = repository.subscribe(() => { notifications += 1 })
    await repository.refresh()
    expect(notifications).toBeGreaterThan(0)
    unsubscribe()
  })
})
