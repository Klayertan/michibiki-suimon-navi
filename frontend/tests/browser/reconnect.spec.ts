import { test, expect } from '@playwright/test'

const VALID_GGA = '$GNGGA,012345.00,3439.2705,N,13549.8410,E,2,14,0.9,45.0,M,30.0,M,,*44'

/**
 * Extends the same fake-SerialPort pattern gnss-recording.spec.ts already
 * uses (task section 25: "use the existing serial mocks/fakes and extend
 * them"), adding what Stage 5B needs: a real device-disconnect event, a way
 * to error/end the stream (Class B), and a way to make the next N open()
 * calls fail (to exercise bounded-retry exhaustion) -- all driven from the
 * Playwright side via small window hooks, mirroring window.__fakeSerialStop
 * from the legacy spec.
 */
function installFakeSerialPort(page: import('@playwright/test').Page) {
  return page.addInitScript((sentence) => {
    let failNextOpens = 0
    class FakeSerialPort {
      readable: ReadableStream<Uint8Array> | null = null
      controller: ReadableStreamDefaultController<Uint8Array> | null = null
      timer: ReturnType<typeof setInterval> | null = null
      getInfo() { return {} }
      async open() {
        if (failNextOpens > 0) {
          failNextOpens -= 1
          throw new Error('simulated open failure')
        }
        const encoder = new TextEncoder()
        this.readable = new ReadableStream({
          start: (controller) => {
            this.controller = controller
            this.timer = setInterval(() => controller.enqueue(encoder.encode(`${sentence}\r\n`)), 40)
          },
          cancel: () => { if (this.timer) clearInterval(this.timer); this.controller = null },
        })
      }
      async close() { this.readable = null; if (this.timer) clearInterval(this.timer) }
    }
    const port = new FakeSerialPort()
    const disconnectListeners = new Set<(event: Event) => void>()
    const fakeSerial = {
      granted: [port],
      async getPorts() { return this.granted },
      async requestPort() { return port },
      addEventListener(type: string, listener: (event: Event) => void) {
        if (type === 'disconnect') disconnectListeners.add(listener)
      },
    }
    Object.defineProperty(Navigator.prototype, 'serial', { configurable: true, get: () => fakeSerial })
    ;(window as unknown as Record<string, unknown>).__fakeSerial = {
      disconnect: () => disconnectListeners.forEach((listener) => listener({ target: port } as unknown as Event)),
      errorStream: (message: string) => port.controller?.error(new Error(message)),
      endStream: () => port.controller?.close(),
      failNextOpens: (count: number) => { failNextOpens = count },
      stopStream: () => { if (port.timer) clearInterval(port.timer) },
    }
  }, VALID_GGA)
}

function fakeSerialAction(page: import('@playwright/test').Page, action: string, ...args: unknown[]) {
  return page.evaluate(({ action, args }) => {
    const fake = (window as unknown as Record<string, { [key: string]: (...a: unknown[]) => unknown }>).__fakeSerial
    return fake[action](...args)
  }, { action, args })
}

test('an interrupted GNSS link automatically reconnects, recording remains open, and the completed session is exact', async ({ page }) => {
  await installFakeSerialPort(page)
  await page.goto('/survey')
  await page.getByRole('button', { name: 'Connect GNSS' }).click()
  await expect(page.getByRole('button', { name: 'Disconnect GNSS' })).toBeVisible()

  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect.poll(async () => Number(await page.locator('.survey-recording dd').nth(1).textContent())).toBeGreaterThan(0)
  const pointsBeforeLoss = Number(await page.locator('.survey-recording dd').nth(1).textContent())

  // Class A: device disconnect event, with the stream also erroring (a real
  // unplug does both) -- task section 3.
  await fakeSerialAction(page, 'errorStream', 'device removed')
  await fakeSerialAction(page, 'disconnect')

  await expect(page.getByText(/GNSS connection lost\. Attempting reconnect…/)).toBeVisible()
  await expect(page.getByText('Recording remains open.', { exact: false })).toBeVisible()
  // Never claims the recording stopped.
  await expect(page.getByLabel('GNSS recording').getByText('recording', { exact: true })).toBeVisible()

  // The bounded automatic retry (first attempt ~1s) reconnects on its own --
  // no picker, no permission prompt, same granted port.
  await expect(page.getByRole('button', { name: 'Disconnect GNSS' })).toBeVisible({ timeout: 5000 })
  await expect(page.getByText(/Attempting reconnect…/)).toHaveCount(0)

  await expect.poll(async () => Number(await page.locator('.survey-recording dd').nth(1).textContent())).toBeGreaterThan(pointsBeforeLoss)

  await page.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(page.getByLabel('GNSS recording').getByText('stopped', { exact: true })).toBeVisible()

  await page.reload()
  // No recovery prompt: the session was stopped normally, not interrupted.
  await expect(page.getByRole('heading', { name: /Unfinished recording/ })).toHaveCount(0)
  const selector = page.getByRole('combobox', { name: 'Select survey or session' })
  await expect.poll(async () => selector.locator('option').count()).toBeGreaterThan(1)

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
    const readByIndex = (storeName: string) => new Promise<Array<{ seq: number }>>((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).index('by_sessionId').getAll(session.sessionId)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const [lines, fixes] = await Promise.all([readByIndex('rawNmeaLines'), readByIndex('structuredFixes')])
    const seqValues = [...lines, ...fixes].map((r) => r.seq).sort((a, b) => a - b)
    return {
      status: session.status,
      lineCount: lines.length,
      uniqueSeqCount: new Set(seqValues).size,
      seqCount: seqValues.length,
      monotonic: seqValues.every((value, index) => index === 0 || value > seqValues[index - 1]),
    }
  })
  expect(persisted.status).toBe('stopped')
  // No seq collisions or gaps across the disconnect/reconnect boundary.
  expect(persisted.uniqueSeqCount).toBe(persisted.seqCount)
  expect(persisted.monotonic).toBe(true)
})

test('when automatic reconnect is exhausted, a manual Reconnect still succeeds', async ({ page }) => {
  test.setTimeout(45_000)
  await installFakeSerialPort(page)
  await page.goto('/survey')
  await page.getByRole('button', { name: 'Connect GNSS' }).click()
  await expect(page.getByRole('button', { name: 'Disconnect GNSS' })).toBeVisible()

  // Fail every one of the four bounded automatic attempts.
  await fakeSerialAction(page, 'failNextOpens', 4)
  await fakeSerialAction(page, 'errorStream', 'device removed')
  await fakeSerialAction(page, 'disconnect')

  const banner = page.getByLabel('GNSS reconnect status')
  await expect(banner.getByText('Automatic reconnect unsuccessful.')).toBeVisible({ timeout: 20_000 })
  // Never gets stuck showing "Attempting reconnect…" forever (task section 22).
  await expect(page.getByText(/Attempting reconnect…/)).toHaveCount(0)
  // The explicit escape hatch remains available and labeled for the moment.
  await expect(page.getByRole('button', { name: 'Reconnect GNSS' })).toBeVisible()

  await page.getByRole('button', { name: 'Reconnect now' }).click()
  await expect(page.getByRole('button', { name: 'Disconnect GNSS' })).toBeVisible()
  await expect(banner).toHaveCount(0)
})

test('repeated disconnect/reconnect cycles while recording never duplicate points and finalize with sequence integrity', async ({ page }) => {
  test.setTimeout(30_000)
  await installFakeSerialPort(page)
  await page.goto('/survey')
  await page.getByRole('button', { name: 'Connect GNSS' }).click()
  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect.poll(async () => Number(await page.locator('.survey-recording dd').nth(1).textContent())).toBeGreaterThan(0)

  for (let cycle = 0; cycle < 2; cycle += 1) {
    const before = Number(await page.locator('.survey-recording dd').nth(1).textContent())
    await fakeSerialAction(page, 'errorStream', `cycle ${cycle} removed`)
    await fakeSerialAction(page, 'disconnect')
    await expect(page.getByText(/Attempting reconnect…/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Disconnect GNSS' })).toBeVisible({ timeout: 5000 })
    await expect.poll(async () => Number(await page.locator('.survey-recording dd').nth(1).textContent())).toBeGreaterThan(before)
  }

  await page.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(page.getByLabel('GNSS recording').getByText('stopped', { exact: true })).toBeVisible()

  const sessionId = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('suimon-navi-recording', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const sessions = await new Promise<Array<{ sessionId: string }>>((resolve, reject) => {
      const req = db.transaction('sessions', 'readonly').objectStore('sessions').getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return sessions[0]?.sessionId
  })
  expect(sessionId).toBeTruthy()

  const analysis = await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('suimon-navi-recording', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const readByIndex = (storeName: string) => new Promise<Array<{ seq: number }>>((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).index('by_sessionId').getAll(id)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const [lines, fixes] = await Promise.all([readByIndex('rawNmeaLines'), readByIndex('structuredFixes')])
    const seqValues = [...lines, ...fixes].map((r) => r.seq).sort((a, b) => a - b)
    return { uniqueSeqCount: new Set(seqValues).size, seqCount: seqValues.length }
  }, sessionId)
  expect(analysis.uniqueSeqCount).toBe(analysis.seqCount)

  // One session throughout the whole test -- never a second one created by
  // any of the reconnect cycles.
  const sessionCount = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('suimon-navi-recording', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const req = db.transaction('sessions', 'readonly').objectStore('sessions').count()
    return new Promise<number>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
  })
  expect(sessionCount).toBe(1)
})

test('recovery + reconnect integration: resuming an unfinished session, then a real disconnect/reconnect, finalizes with all points exactly once', async ({ page }) => {
  test.setTimeout(30_000)
  await installFakeSerialPort(page)
  await page.goto('/survey')

  // Seed a legacy-shaped unfinished session directly -- Stage 5A's own
  // fixture pattern -- so recovery is required before any serial action.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('suimon-navi-recording', 1)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains('sessions')) database.createObjectStore('sessions', { keyPath: 'sessionId' })
        if (!database.objectStoreNames.contains('rawNmeaLines')) { const s = database.createObjectStore('rawNmeaLines', { keyPath: 'id', autoIncrement: true }); s.createIndex('by_sessionId', 'sessionId') }
        if (!database.objectStoreNames.contains('structuredFixes')) { const s = database.createObjectStore('structuredFixes', { keyPath: 'id', autoIncrement: true }); s.createIndex('by_sessionId', 'sessionId') }
        if (!database.objectStoreNames.contains('markedObservations')) { const s = database.createObjectStore('markedObservations', { keyPath: 'id' }); s.createIndex('by_sessionId', 'sessionId') }
        if (!database.objectStoreNames.contains('imageBlobs')) { const s = database.createObjectStore('imageBlobs', { keyPath: 'id' }); s.createIndex('by_sessionId', 'sessionId') }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['sessions', 'rawNmeaLines'], 'readwrite')
      tx.objectStore('sessions').add({
        sessionId: 'recover-then-reconnect', startedAt: '2026-08-01T09:00:00.000Z', endedAt: null, status: 'recording',
        fieldId: null, fieldName: null, transportLabel: null, baudRate: 115200, deviceInfo: {},
        totalReceivedLines: 1, validFixCount: 0, checksumFailureCount: 0, malformedLineCount: 0,
        lastValidFix: null, notes: '', updatedAt: '2026-08-01T09:05:00.000Z',
      })
      tx.objectStore('rawNmeaLines').add({ sessionId: 'recover-then-reconnect', seq: 1, receivedAt: '2026-08-01T09:00:01.000Z', line: '$GPTXT,seed*00' })
      tx.oncomplete = () => resolve(undefined)
      tx.onerror = () => reject(tx.error)
    })
  })

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Unfinished recording found' })).toBeVisible()
  await page.getByRole('button', { name: 'Resume' }).click()
  await expect(page.getByLabel('GNSS recording').getByText('recording', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Connect GNSS' }).click()
  await expect.poll(async () => Number(await page.locator('.survey-recording dd').nth(1).textContent())).toBeGreaterThan(0)

  await fakeSerialAction(page, 'errorStream', 'lost after resume')
  await fakeSerialAction(page, 'disconnect')
  await expect(page.getByText(/Attempting reconnect…/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Disconnect GNSS' })).toBeVisible({ timeout: 5000 })

  await page.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(page.getByLabel('GNSS recording').getByText('stopped', { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: /Unfinished recording/ })).toHaveCount(0)

  const analysis = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('suimon-navi-recording', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const readByIndex = (storeName: string) => new Promise<Array<{ seq: number }>>((resolve, reject) => {
      const req = db.transaction(storeName, 'readonly').objectStore(storeName).index('by_sessionId').getAll('recover-then-reconnect')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const [lines, fixes] = await Promise.all([readByIndex('rawNmeaLines'), readByIndex('structuredFixes')])
    const seqValues = [...lines, ...fixes].map((r) => r.seq).sort((a, b) => a - b)
    return { uniqueSeqCount: new Set(seqValues).size, seqCount: seqValues.length, lineCount: lines.length }
  })
  // The seeded pre-crash line (seq 1) plus everything ingested after Resume
  // and after the later reconnect all coexist exactly once.
  expect(analysis.uniqueSeqCount).toBe(analysis.seqCount)
  expect(analysis.lineCount).toBeGreaterThan(1)
})

test('the reconnect banner stays usable at every supported viewport with no document scrolling', async ({ page }) => {
  await installFakeSerialPort(page)
  await page.goto('/survey')
  await page.getByRole('button', { name: 'Connect GNSS' }).click()
  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect.poll(async () => Number(await page.locator('.survey-recording dd').nth(1).textContent())).toBeGreaterThan(0)

  await fakeSerialAction(page, 'stopStream') // freeze delivery so the banner's attempt count doesn't advance mid-check
  await fakeSerialAction(page, 'errorStream', 'viewport check disconnect')
  await fakeSerialAction(page, 'disconnect')
  await expect(page.getByLabel('GNSS reconnect status')).toBeVisible()

  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport)
    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      mapArea: document.querySelector('.leaflet-container')!.getBoundingClientRect().width
        * document.querySelector('.leaflet-container')!.getBoundingClientRect().height,
      viewportArea: window.innerWidth * window.innerHeight,
    }))
    expect(layout.scrollWidth).toBe(layout.clientWidth)
    expect(layout.scrollHeight).toBe(layout.clientHeight)
    expect(layout.mapArea / layout.viewportArea).toBeGreaterThan(0.4)
    await expect(page.getByRole('button', { name: 'Reconnect now' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible()
  }
})
