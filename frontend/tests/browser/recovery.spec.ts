import { test, expect } from '@playwright/test'

const VALID_GGA = '$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*44'

function installFakeSerialPort(page: import('@playwright/test').Page) {
  return page.addInitScript((sentence) => {
    class FakeSerialPort {
      readable: ReadableStream<Uint8Array> | null = null
      private timer: ReturnType<typeof setInterval> | null = null
      getInfo() { return {} }
      async open() {
        const encoder = new TextEncoder()
        this.readable = new ReadableStream({
          start: (controller) => {
            this.timer = setInterval(() => controller.enqueue(encoder.encode(`${sentence}\r\n`)), 40)
            ;(window as unknown as { __fakeSerialStop?: () => void }).__fakeSerialStop = () => { if (this.timer) clearInterval(this.timer) }
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
}

interface StoredSession {
  status: string
  [key: string]: unknown
}

async function readAllSessions(page: import('@playwright/test').Page): Promise<StoredSession[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('suimon-navi-recording', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return new Promise((resolve, reject) => {
      const request = db.transaction('sessions', 'readonly').objectStore('sessions').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  })
}

async function seedLegacyShapedUnfinishedSessions(page: import('@playwright/test').Page, sessionIds: string[]) {
  await page.evaluate(async (ids) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('suimon-navi-recording', 1)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains('sessions')) database.createObjectStore('sessions', { keyPath: 'sessionId' })
        if (!database.objectStoreNames.contains('rawNmeaLines')) {
          const store = database.createObjectStore('rawNmeaLines', { keyPath: 'id', autoIncrement: true })
          store.createIndex('by_sessionId', 'sessionId')
        }
        if (!database.objectStoreNames.contains('structuredFixes')) {
          const store = database.createObjectStore('structuredFixes', { keyPath: 'id', autoIncrement: true })
          store.createIndex('by_sessionId', 'sessionId')
        }
        if (!database.objectStoreNames.contains('markedObservations')) {
          const store = database.createObjectStore('markedObservations', { keyPath: 'id' })
          store.createIndex('by_sessionId', 'sessionId')
        }
        if (!database.objectStoreNames.contains('imageBlobs')) {
          const store = database.createObjectStore('imageBlobs', { keyPath: 'id' })
          store.createIndex('by_sessionId', 'sessionId')
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['sessions', 'rawNmeaLines', 'structuredFixes'], 'readwrite')
      // Shaped exactly like js/recording/recording-controller.js's startRecording()
      // + sessionCounterPatch() would have written it -- this fixture simulates a
      // session the *legacy* app created and crashed mid-recording, not one React
      // wrote, since both share the identical suimon-navi-recording v1 schema.
      for (const id of ids) {
        tx.objectStore('sessions').add({
          sessionId: id, startedAt: '2026-08-01T09:00:00.000Z', endedAt: null, status: 'recording',
          fieldId: null, fieldName: null, transportLabel: 'Bluetooth SPP', baudRate: 115200, deviceInfo: {},
          totalReceivedLines: 2, validFixCount: 1, checksumFailureCount: 0, malformedLineCount: 0,
          lastValidFix: { timestamp: '090500', lat: 34.65, lon: 135.83, fixQuality: 1 },
          notes: '', updatedAt: '2026-08-01T09:05:00.000Z',
        })
        tx.objectStore('rawNmeaLines').add({ sessionId: id, seq: 1, receivedAt: '2026-08-01T09:00:01.000Z', line: '$GNGGA,090000.00,3439.0000,N,13549.8000,E,0,00,0.0,0.0,M,0.0,M,,*00' })
        tx.objectStore('rawNmeaLines').add({ sessionId: id, seq: 2, receivedAt: '2026-08-01T09:05:00.000Z', line: '$GNGGA,090500.00,3439.0000,N,13549.8000,E,1,08,1.1,10.0,M,30.0,M,,*00' })
        tx.objectStore('structuredFixes').add({
          sessionId: id, seq: 3, receivedAt: '2026-08-01T09:05:00.000Z', timestamp: '090500',
          lat: 34.65, lon: 135.83, altitude: 10, fixQuality: 1, satellites: 8, hdop: 1.1,
          rawLine: '$GNGGA,090500.00,3439.0000,N,13549.8000,E,1,08,1.1,10.0,M,30.0,M,,*00',
        })
      }
      tx.oncomplete = () => resolve(undefined)
      tx.onerror = () => reject(tx.error)
    })
  }, sessionIds)
}

test('an interrupted recording survives a crash, resumes with sequence integrity intact, and finishes normally', async ({ page }) => {
  await installFakeSerialPort(page)
  await page.goto('/survey')
  await page.getByRole('button', { name: 'Connect GNSS' }).click()
  await expect(page.getByRole('button', { name: 'Disconnect GNSS' })).toBeVisible()

  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(page.getByLabel('GNSS recording').getByText('recording', { exact: true })).toBeVisible()
  await expect.poll(async () => Number(await page.locator('.survey-recording dd').nth(1).textContent())).toBeGreaterThan(1)
  // Freeze the stream before snapshotting "before crash" state -- otherwise a
  // sentence can land between the snapshot and the reload, racing the count.
  await page.evaluate(() => (window as unknown as { __fakeSerialStop?: () => void }).__fakeSerialStop?.())
  // Let the automatic flush drain the in-memory queue to disk before "crashing".
  await expect.poll(async () => page.locator('.survey-recording dd').nth(3).textContent()).toBe('0')
  const pointCountBeforeCrash = Number(await page.locator('.survey-recording dd').nth(1).textContent())

  // Simulate a crash: no Stop Recording, just an unannounced reload.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Unfinished recording found' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeDisabled()
  await expect(page.getByLabel('GNSS recording').getByText('recovery_available', { exact: true })).toBeVisible()
  // Serial was never auto-reconnected after the crash.
  await expect(page.getByRole('button', { name: 'Connect GNSS' })).toBeVisible()

  await page.getByRole('button', { name: 'Resume' }).click()
  await expect(page.getByLabel('GNSS recording').getByText('recording', { exact: true })).toBeVisible()
  // Resuming a recording must never, by itself, open the serial port.
  await expect(page.getByRole('button', { name: 'Connect GNSS' })).toBeVisible()
  expect(Number(await page.locator('.survey-recording dd').nth(1).textContent())).toBe(pointCountBeforeCrash)

  // GNSS reconnection remains a separate, explicit operator action.
  await page.getByRole('button', { name: 'Connect GNSS' }).click()
  await expect(page.getByRole('button', { name: 'Disconnect GNSS' })).toBeVisible()
  await expect.poll(async () => Number(await page.locator('.survey-recording dd').nth(1).textContent())).toBeGreaterThan(pointCountBeforeCrash)

  await page.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(page.getByLabel('GNSS recording').getByText('stopped', { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: /Unfinished recording/ })).toHaveCount(0)
  const selector = page.getByRole('combobox', { name: 'Select survey or session' })
  await expect.poll(async () => selector.locator('option').count()).toBeGreaterThan(1)

  const sessions = await readAllSessions(page)
  expect(sessions).toHaveLength(1)
  expect(sessions[0].status).toBe('stopped')

  const analysis = await page.evaluate(async (sessionId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('suimon-navi-recording', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const readByIndex = (storeName: string) => new Promise<Array<{ seq: number }>>((resolve, reject) => {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).index('by_sessionId').getAll(sessionId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const [lines, fixes] = await Promise.all([readByIndex('rawNmeaLines'), readByIndex('structuredFixes')])
    const seqValues = [...lines, ...fixes].map((record) => record.seq).sort((a, b) => a - b)
    return {
      uniqueSeqCount: new Set(seqValues).size,
      seqCount: seqValues.length,
      monotonic: seqValues.every((value, index) => index === 0 || value > seqValues[index - 1]),
    }
  }, sessions[0].sessionId as string)

  // No seq collisions and no gaps across the crash/resume boundary -- the
  // pre-crash and post-resume records coexist exactly once.
  expect(analysis.uniqueSeqCount).toBe(analysis.seqCount)
  expect(analysis.monotonic).toBe(true)
})

test('a legacy-shaped unfinished session is detected on load, and Finish & Save neither fabricates data nor gets the app stuck in recovery mode', async ({ page }) => {
  await page.goto('/survey')
  await seedLegacyShapedUnfinishedSessions(page, ['legacy-session-1'])

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Unfinished recording found' })).toBeVisible()
  await expect(page.getByText('Not linked')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeDisabled()

  await page.getByRole('button', { name: 'Finish & Save' }).click()
  await expect(page.getByRole('heading', { name: /Unfinished recording/ })).toHaveCount(0)
  // Resolving the only unfinished session must release the recovery-required
  // state entirely -- a new recording should be startable again immediately,
  // not permanently blocked because no session was ever "active" in this tab.
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await expect(page.getByLabel('GNSS recording').getByText('idle', { exact: true })).toBeVisible()

  const selector = page.getByRole('combobox', { name: 'Select survey or session' })
  await expect.poll(async () => selector.locator('option').count()).toBeGreaterThan(1)

  const sessions = await readAllSessions(page)
  const finalized = sessions.find((session) => session.sessionId === 'legacy-session-1')
  expect(finalized?.status).toBe('stopped')
  // No fabricated point or line: exactly what was there before finalize.
  const counts = await page.evaluate(async (sessionId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('suimon-navi-recording', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const countByIndex = (storeName: string) => new Promise<number>((resolve, reject) => {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).index('by_sessionId').count(sessionId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return { rawCount: await countByIndex('rawNmeaLines'), fixCount: await countByIndex('structuredFixes') }
  }, 'legacy-session-1')
  expect(counts.rawCount).toBe(2)
  expect(counts.fixCount).toBe(1)

  // Still readable and still resolved after another reload.
  await page.reload()
  await expect(page.getByRole('heading', { name: /Unfinished recording/ })).toHaveCount(0)
  const reloadedSelector = page.getByRole('combobox', { name: 'Select survey or session' })
  await expect.poll(async () => reloadedSelector.locator('option').count()).toBeGreaterThan(1)
})

test('multiple unfinished recordings stay usable at every supported viewport without document scrolling', async ({ page }) => {
  await page.goto('/survey')
  await seedLegacyShapedUnfinishedSessions(page, ['vp-1', 'vp-2'])
  await page.reload()
  await expect(page.getByRole('heading', { name: '2 unfinished recordings found' })).toBeVisible()

  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport)
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('.recovery-panel')!.getBoundingClientRect()
      const inspector = document.querySelector('.inspector-panel')?.getBoundingClientRect()
      const map = document.querySelector('.leaflet-container')!.getBoundingClientRect()
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        panelWidth: panel.width,
        panelRight: panel.right,
        inspectorRight: inspector ? inspector.right : null,
        mapArea: map.width * map.height,
        viewportArea: window.innerWidth * window.innerHeight,
      }
    })
    expect(layout.scrollWidth).toBe(layout.clientWidth)
    expect(layout.scrollHeight).toBe(layout.clientHeight)
    expect(layout.panelWidth).toBeGreaterThan(100)
    expect(layout.panelRight).toBeLessThanOrEqual(viewport.width + 1)
    if (layout.inspectorRight !== null) expect(layout.inspectorRight).toBeLessThanOrEqual(viewport.width + 1)
    // Survey stays map-first -- the recovery surface is a compact panel, not a
    // workflow page that displaces the map.
    expect(layout.mapArea / layout.viewportArea).toBeGreaterThan(0.4)
    for (const name of ['Resume', 'Finish & Save', 'Discard']) {
      await expect(page.getByRole('button', { name }).first()).toBeVisible()
    }
  }
})
