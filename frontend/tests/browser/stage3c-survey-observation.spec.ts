import { test, expect } from '@playwright/test'

const VALID_GGA = '$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*44'

test.beforeEach(async ({ page }) => {
  await page.addInitScript((sentence) => {
    const coordinates = [[34.654, 135.83], [34.654, 135.832], [34.656, 135.832], [34.65401, 135.83001]]
    localStorage.setItem('suimonNaviFieldAnnotationsV2', JSON.stringify({
      schemaVersion: 3, fields: [], waterControlPoints: [], fieldObservations: [], workflowState: {},
      surveySessions: [{ id: 'survey-1', name: 'Legacy boundary walk', fieldId: null, measurementType: 'boundary_track', rawPoints: coordinates.map(([lat, lon]) => ({ lat, lon, fixValid: true })) }],
      boundaryTracks: [{ id: 'track-1', name: 'Legacy boundary', type: 'field_boundary_track', geometryType: 'LineString', fieldId: null, sourceSessionId: 'survey-1', coordinates, properties: { createdAt: '2026-08-09T00:00:00.000Z', fixQualitySummary: null } }],
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
    const fakeSerial = { granted: [] as FakeSerialPort[], async getPorts() { return this.granted }, async requestPort() { const port = new FakeSerialPort(); this.granted.push(port); return port }, addEventListener() {} }
    Object.defineProperty(Navigator.prototype, 'serial', { configurable: true, get: () => fakeSerial })
  }, VALID_GGA)
})

test('registers a saved boundary and creates a legacy-compatible field observation', async ({ page }) => {
  await page.goto('/survey')
  const selector = page.getByRole('combobox', { name: 'Select survey or session' })
  await selector.selectOption('survey-1')
  await page.getByRole('button', { name: 'Back' }).click()

  await page.getByRole('button', { name: 'Use as Field Boundary' }).click()
  await expect(page.getByText(/4 points · source: boundary_track/)).toBeVisible()
  await expect(page.locator('path[stroke="#f59e0b"]')).toBeVisible()
  await page.getByLabel('Field name').fill('React registered field')
  await page.getByRole('button', { name: 'Register Field' }).click()
  await expect(page.getByRole('heading', { name: 'React registered field' })).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByRole('link', { name: 'Field' }).click()
  await expect(page.getByRole('combobox', { name: 'Select field' }).locator('option', { hasText: 'React registered field' })).toHaveCount(1)
  await page.getByRole('link', { name: 'Survey' }).click()

  await page.getByRole('button', { name: 'Connect GNSS' }).click()
  await expect(page.getByText('34.6545083')).toBeVisible()
  await page.getByRole('button', { name: 'Add Observation' }).click()
  await page.getByLabel('Type').selectOption('weed')
  await page.getByLabel('Severity').selectOption('high')
  await page.getByLabel('Notes').fill('legacy-compatible weed note')
  await page.getByRole('button', { name: 'Use Current GNSS' }).click()
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport)
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, height: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight }))
    expect(dimensions).toEqual({ width: viewport.width, clientWidth: viewport.width, height: viewport.height, clientHeight: viewport.height })
    await expect(page.getByRole('button', { name: 'Place on Map' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Disconnect GNSS' })).toBeVisible()
  }
  await page.getByRole('button', { name: 'Save Observation' }).click()

  await expect(page.getByRole('heading', { name: /雑草 Observation/ })).toBeVisible()
  await expect(page.getByText('legacy-compatible weed note')).toBeVisible()
  await expect(page.locator('path[fill="#65a30d"]')).toBeAttached()

  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('suimonNaviFieldAnnotationsV2')!))
  expect(persisted.schemaVersion).toBe(3)
  expect(Object.keys(persisted).sort()).toEqual(['schemaVersion', 'fields', 'boundaryTracks', 'waterControlPoints', 'surveySessions', 'fieldObservations', 'workflowState'].sort())
  expect(persisted.fields[0]).toMatchObject({ name: 'React registered field', type: 'field', geometryType: 'Polygon', sourceSessionId: 'survey-1' })
  expect(persisted.fields[0].coordinates[0]).toEqual([34.654, 135.83])
  expect(persisted.surveySessions[0].fieldId).toBe(persisted.fields[0].id)
  expect(persisted.fieldObservations[0]).toMatchObject({ fieldId: persisted.fields[0].id, type: 'weed', geometryType: 'Point', properties: { severity: 'high', memo: 'legacy-compatible weed note', sourceType: 'qz1_current_position' } })
  expect(persisted.fieldObservations[0].coordinates[0]).toBeCloseTo(34.6545083, 7)
  expect(persisted.fieldObservations[0].coordinates[1]).toBeCloseTo(135.8306833, 7)
})
