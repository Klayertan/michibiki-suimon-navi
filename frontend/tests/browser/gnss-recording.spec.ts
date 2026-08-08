import { test, expect } from '@playwright/test'

const VALID_GGA = '$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*44'

test.beforeEach(async ({ page }) => {
  await page.addInitScript((sentence) => {
    localStorage.setItem('suimonNaviFieldAnnotationsV2', JSON.stringify({
      schemaVersion: 3,
      fields: [{ id: 'field-1', name: 'Browser field', type: 'field', geometryType: 'Polygon', coordinates: [[34.654, 135.83], [34.654, 135.832], [34.656, 135.832]], properties: { memo: '', createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z' } }],
      boundaryTracks: [], waterControlPoints: [], surveySessions: [], fieldObservations: [], workflowState: {},
    }))
    class FakeSerialPort {
      readable: ReadableStream<Uint8Array> | null = null
      private timer: ReturnType<typeof setInterval> | null = null
      getInfo() { return {} }
      async open() {
        const encoder = new TextEncoder()
        this.readable = new ReadableStream({
          start: (controller) => {
            this.timer = setInterval(() => controller.enqueue(encoder.encode(`${sentence}\r\n`)), 40)
          },
          cancel: () => { if (this.timer) clearInterval(this.timer) },
        })
      }
      async close() { this.readable = null }
    }
    const fakeSerial = {
      granted: [] as FakeSerialPort[],
      async getPorts() { return this.granted },
      async requestPort() { const port = new FakeSerialPort(); this.granted.push(port); return port },
      addEventListener() {},
    }
    Object.defineProperty(Navigator.prototype, 'serial', { configurable: true, get: () => fakeSerial })
  }, VALID_GGA)
})

test('connects, records valid fixes, persists, lists the session, and reloads it', async ({ page }) => {
  await page.goto('/survey')
  await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(1)
  await page.getByRole('link', { name: 'Field' }).click()
  await page.getByRole('combobox', { name: 'Select field' }).selectOption('field-1')
  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByRole('link', { name: 'Survey' }).click()
  await page.getByRole('button', { name: 'Connect GNSS' }).click()
  await expect(page.getByRole('button', { name: 'Disconnect GNSS' })).toBeVisible()
  await expect(page.getByText('34.6545083')).toBeVisible()
  await expect(page.getByText('135.8306833')).toBeVisible()
  await expect(page.getByText('14', { exact: true })).toBeVisible()
  await expect(page.locator('path[stroke="#0369a1"]')).toBeVisible()
  await expect.poll(() => page.locator('.status-badge--connected .status-badge__label').allTextContents())
    .toEqual(expect.arrayContaining(['gnss', 'serial']))

  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(page.getByLabel('GNSS recording').getByText('recording', { exact: true })).toBeVisible()
  await expect.poll(async () => Number(await page.locator('.survey-recording dd').nth(1).textContent())).toBeGreaterThan(1)
  await expect(page.locator('path[stroke="#e11d48"]')).toBeAttached()
  await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(3)
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport)
    const layout = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      recordingVisible: Boolean(document.querySelector('.survey-recording')?.getBoundingClientRect().height),
    }))
    expect(layout).toEqual({ width: viewport.width, clientWidth: viewport.width, height: viewport.height, clientHeight: viewport.height, recordingVisible: true })
  }
  await page.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(page.getByText('stopped', { exact: true })).toBeVisible()

  const selector = page.getByRole('combobox', { name: 'Select survey or session' })
  await expect.poll(async () => selector.locator('option').count()).toBeGreaterThan(1)
  const savedLabel = await selector.locator('option').nth(1).textContent()
  expect(savedLabel).toContain('recording')

  const persisted = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('suimon-navi-recording', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const session = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = db.transaction('sessions', 'readonly').objectStore('sessions').getAll()
      request.onsuccess = () => resolve(request.result[0])
      request.onerror = () => reject(request.error)
    })
    return { stores: [...db.objectStoreNames], session }
  })
  expect(persisted.stores).toEqual(expect.arrayContaining(['sessions', 'rawNmeaLines', 'structuredFixes']))
  expect(persisted.session).toMatchObject({ status: 'stopped', fieldId: 'field-1', baudRate: 115200 })

  await page.reload()
  const reloadedSelector = page.getByRole('combobox', { name: 'Select survey or session' })
  await expect.poll(async () => reloadedSelector.locator('option').count()).toBeGreaterThan(1)
  await expect(reloadedSelector.locator('option').nth(1)).toContainText('recording')
})
