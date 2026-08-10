import { test, expect } from '@playwright/test'

const VALID_GGA = '$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*44'
const KEY = 'suimonNaviFieldAnnotationsV2'

/** A field whose boundary contains the fake fix at 34.654508, 135.830683. */
const FIELD_BOUNDARY = [
  [34.6535, 135.8295],
  [34.6535, 135.8320],
  [34.6555, 135.8320],
  [34.6555, 135.8295],
]

/** A byte-accurate legacy water point, written by the legacy builder's own shape. */
const LEGACY_POINT = {
  id: 'wcp-legacy-1',
  name: '既存圃場 水門1',
  type: 'water_gate',
  relatedFieldId: 'paddy-001',
  geometryType: 'Point',
  coordinates: [34.6540, 135.8305],
  properties: {
    memo: 'written by the legacy app',
    sourceType: 'manual_map_click',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ sentence, key, boundary, legacyPoint }) => {
    // addInitScript runs before *every* navigation, including page.reload().
    // Seeding unconditionally would silently restore the fixture and hide
    // whether data actually persisted, so seed only an empty origin.
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({
      schemaVersion: 3,
      fields: [{
        id: 'paddy-001', name: '既存圃場', type: 'field', geometryType: 'Polygon',
        coordinates: boundary, sourceSessionId: null,
        properties: {
          memo: '', sourceType: 'QZ1_NMEA', sourceFileName: null,
          createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
          areaM2: 1234, closureGapM: 0, closedManually: false, sourcePointCount: 4, fixQualitySummary: null,
        },
      }],
      boundaryTracks: [],
      waterControlPoints: [legacyPoint],
      surveySessions: [],
      fieldObservations: [],
      workflowState: { lastExportedAt: null },
    }))

    class FakeSerialPort {
      readable: ReadableStream<Uint8Array> | null = null
      timer: ReturnType<typeof setInterval> | null = null
      getInfo() { return {} }
      async open() {
        const encoder = new TextEncoder()
        this.readable = new ReadableStream({
          start: (controller) => { this.timer = setInterval(() => controller.enqueue(encoder.encode(`${sentence}\r\n`)), 60) },
          cancel: () => { if (this.timer) clearInterval(this.timer) },
        })
      }
      async close() { if (this.timer) clearInterval(this.timer); this.readable = null }
    }
    const fakeSerial = {
      granted: [] as FakeSerialPort[],
      async getPorts() { return this.granted },
      async requestPort() { const port = new FakeSerialPort(); this.granted.push(port); return port },
      addEventListener() {},
    }
    Object.defineProperty(Navigator.prototype, 'serial', { configurable: true, get: () => fakeSerial })
  }, { sentence: VALID_GGA, key: KEY, boundary: FIELD_BOUNDARY, legacyPoint: LEGACY_POINT })
})

test('reads a legacy water point, creates a legacy-compatible one from live GNSS, and stays usable at every required viewport', async ({ page }) => {
  await page.goto('/water')

  // --- direction 1: legacy bytes -> React, with no write ------------------
  await page.getByRole('link', { name: 'Field' }).click()
  await page.getByRole('combobox', { name: 'Select field' }).selectOption('paddy-001')
  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByRole('link', { name: 'Water' }).click()

  await expect(page.getByText('Water points · 1')).toBeVisible()
  await expect(page.locator('.water-symbol--gate')).toBeVisible()
  await page.getByRole('button', { name: /既存圃場 水門1/ }).click()
  await expect(page.getByRole('heading', { name: '既存圃場 水門1' })).toBeVisible()
  await expect(page.getByText('written by the legacy app')).toBeVisible()
  await expect(page.getByText('water_gate')).toBeVisible()
  await expect(page.getByText('34.6540000, 135.8305000')).toBeVisible()

  const afterRead = await page.evaluate((key) => localStorage.getItem(key), KEY)
  expect(JSON.parse(afterRead!).waterControlPoints).toEqual([LEGACY_POINT])
  await page.getByRole('button', { name: 'Back' }).click()

  // --- viewports, with the composer open ----------------------------------
  // GNSS is connected from the Survey workspace, which owns that control.
  await page.getByRole('link', { name: 'Survey' }).click()
  await page.getByRole('button', { name: 'Connect GNSS' }).click()
  await expect(page.getByText('34.6545083')).toBeVisible()
  await page.getByRole('link', { name: 'Water' }).click()
  await page.getByRole('button', { name: 'Add Water Point' }).click()

  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport)
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }))
    expect(dimensions).toEqual({
      width: viewport.width, clientWidth: viewport.width,
      height: viewport.height, clientHeight: viewport.height,
    })
    await expect(page.getByRole('button', { name: 'Use Current GNSS' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Place on Map' })).toBeVisible()
    // The map stays the dominant surface and the inspector stays in bounds.
    const layout = await page.evaluate(() => {
      const map = document.querySelector('.map-workspace')!.getBoundingClientRect()
      const inspector = document.querySelector('.inspector-panel')!.getBoundingClientRect()
      return { mapWidth: map.width, inspectorRight: inspector.right, innerWidth: window.innerWidth }
    })
    expect(layout.mapWidth).toBeGreaterThan(layout.innerWidth / 2)
    expect(Math.round(layout.inspectorRight)).toBeLessThanOrEqual(layout.innerWidth)
  }
  await page.setViewportSize({ width: 1366, height: 768 })

  // --- direction 2: React creates -> exact legacy shape --------------------
  await page.getByLabel('Type').selectOption('outlet')
  await page.getByLabel('Notes').fill('created in React')
  await page.getByRole('button', { name: 'Use Current GNSS' }).click()
  await expect(page.getByText(/Preview: 34\.6545083/)).toBeVisible()
  await page.getByRole('button', { name: 'Save Water Point' }).click()

  await expect(page.getByRole('heading', { name: '既存圃場 排水口1' })).toBeVisible()
  await expect(page.locator('.water-symbol--outlet')).toBeVisible()

  const persisted = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY)
  expect(persisted.schemaVersion).toBe(3)
  expect(Object.keys(persisted).sort()).toEqual(
    ['schemaVersion', 'fields', 'boundaryTracks', 'waterControlPoints', 'surveySessions', 'fieldObservations', 'workflowState'].sort(),
  )
  // The pre-existing legacy record is byte-identical, and sibling datasets survived.
  expect(persisted.waterControlPoints[0]).toEqual(LEGACY_POINT)
  expect(persisted.fields[0].id).toBe('paddy-001')
  expect(persisted.workflowState).toEqual({ lastExportedAt: null })

  const created = persisted.waterControlPoints[1]
  expect(Object.keys(created)).toEqual(['id', 'name', 'type', 'relatedFieldId', 'geometryType', 'coordinates', 'properties'])
  expect(Object.keys(created.properties)).toEqual(['memo', 'sourceType', 'createdAt', 'updatedAt'])
  expect(created.type).toBe('water_outlet')
  expect(created.relatedFieldId).toBe('paddy-001')
  expect(created.geometryType).toBe('Point')
  expect(created.properties.sourceType).toBe('qz1_current_position')
  expect(created.properties.memo).toBe('created in React')
  // [lat, lon] order: latitude ~34.65, longitude ~135.83, never swapped.
  expect(created.coordinates[0]).toBeCloseTo(34.6545083, 5)
  expect(created.coordinates[1]).toBeCloseTo(135.8306833, 5)
  expect(created.label).toBeUndefined()

  // Surviving a reload proves it round-trips through the same reader.
  await page.reload()
  await page.getByRole('link', { name: 'Water' }).click()
  await expect(page.locator('.water-symbol--control')).toHaveCount(2)
})

test('an ordinary map click never creates a water point, and Escape cancels armed placement', async ({ page }) => {
  await page.goto('/field')
  await page.getByRole('combobox', { name: 'Select field' }).selectOption('paddy-001')
  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByRole('link', { name: 'Water' }).click()

  const map = page.locator('.map-workspace')
  await map.click({ position: { x: 220, y: 220 } })
  let count = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).waterControlPoints.length, KEY)
  expect(count).toBe(1)

  await page.getByRole('button', { name: 'Add Water Point' }).click()
  await page.getByRole('button', { name: 'Place on Map' }).click()
  await expect(page.getByRole('button', { name: 'Click the map…' })).toBeVisible()
  await page.keyboard.press('Escape')

  await map.click({ position: { x: 240, y: 240 } })
  count = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).waterControlPoints.length, KEY)
  expect(count).toBe(1)
})
