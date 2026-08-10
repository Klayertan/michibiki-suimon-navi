import { test, expect } from '@playwright/test'

/**
 * Fakes the Screen Wake Lock API (task section 19/21: "Web Wake Lock support
 * will not necessarily exist... provide a testable abstraction; do not
 * require real hardware/host support"). Installed as an own property on
 * `navigator` so it shadows any real implementation Chromium may already
 * expose, exactly like the existing fake-serial specs shadow
 * `Navigator.prototype.serial`.
 */
function installFakeWakeLock(page: import('@playwright/test').Page) {
  return page.addInitScript(() => {
    class FakeSentinel extends EventTarget {
      released = false
      release() {
        if (!this.released) {
          this.released = true
          this.dispatchEvent(new Event('release'))
        }
        return Promise.resolve()
      }
    }
    let current: FakeSentinel | null = null
    let requestCount = 0
    const fakeWakeLock = {
      async request(_type: 'screen') {
        requestCount += 1
        current = new FakeSentinel()
        return current
      },
    }
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, get: () => fakeWakeLock })
    ;(window as unknown as Record<string, unknown>).__fakeWakeLock = {
      simulateExternalRelease: () => current?.dispatchEvent(new Event('release')),
      isActive: () => Boolean(current && !current.released),
      requestCount: () => requestCount,
    }
  })
}

function fakeWakeLockAction(page: import('@playwright/test').Page, action: string) {
  return page.evaluate((action) => {
    const fake = (window as unknown as Record<string, { [key: string]: (...a: unknown[]) => unknown }>).__fakeWakeLock
    return fake[action]()
  }, action)
}

function setVisibility(page: import('@playwright/test').Page, state: 'visible' | 'hidden') {
  return page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

function keepAwakeRow(page: import('@playwright/test').Page) {
  return page.locator('.survey-live__metrics div', { hasText: 'Keep screen awake' })
}

test('screen wake lock is acquired while recording, survives a visibility cycle, and releases on stop', async ({ page }) => {
  await installFakeWakeLock(page)
  await page.goto('/survey')

  // Idle: no lock has ever been requested.
  await expect(keepAwakeRow(page)).toContainText('—')
  expect(await fakeWakeLockAction(page, 'requestCount')).toBe(0)

  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(keepAwakeRow(page)).toContainText('● Active')
  expect(await fakeWakeLockAction(page, 'isActive')).toBe(true)

  // Tab hidden: the browser may take the lock away on its own.
  await setVisibility(page, 'hidden')
  await fakeWakeLockAction(page, 'simulateExternalRelease')
  await expect(keepAwakeRow(page)).toContainText('Reacquiring…')

  // Tab visible again while still recording: reacquire.
  await setVisibility(page, 'visible')
  await expect(keepAwakeRow(page)).toContainText('● Active')
  expect(await fakeWakeLockAction(page, 'requestCount')).toBe(2)

  await page.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(page.getByLabel('GNSS recording').getByText('stopped', { exact: true })).toBeVisible()
  await expect(keepAwakeRow(page)).toContainText('—')
  expect(await fakeWakeLockAction(page, 'isActive')).toBe(false)

  // Reload: no wake lock request while idle.
  await page.reload()
  await expect(keepAwakeRow(page)).toContainText('—')
  expect(await fakeWakeLockAction(page, 'requestCount')).toBe(0) // fresh page load resets the fake's own counter
})

test('a tab that hides and returns after recording already stopped does not reacquire the wake lock', async ({ page }) => {
  await installFakeWakeLock(page)
  await page.goto('/survey')

  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(keepAwakeRow(page)).toContainText('● Active')

  await setVisibility(page, 'hidden')
  await page.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(page.getByLabel('GNSS recording').getByText('stopped', { exact: true })).toBeVisible()

  await setVisibility(page, 'visible')
  await expect(keepAwakeRow(page)).toContainText('—')
  expect(await fakeWakeLockAction(page, 'isActive')).toBe(false)
})

test('an unsupported browser records normally with a clear, non-blocking notice', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, get: () => undefined })
  })
  await page.goto('/survey')

  // Unsupported is surfaced proactively, even before recording starts.
  await expect(keepAwakeRow(page)).toContainText('Unavailable')
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeEnabled()

  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(page.getByLabel('GNSS recording').getByText('recording', { exact: true })).toBeVisible()
  await expect(keepAwakeRow(page)).toContainText('Unavailable')
  await expect(page.getByText('Screen keep-awake unavailable. Recording will continue; prevent the device from sleeping manually.')).toBeVisible()

  await page.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(page.getByLabel('GNSS recording').getByText('stopped', { exact: true })).toBeVisible()
})

test('the Keep screen awake indicator fits every supported viewport without document scrolling or an enlarged control area', async ({ page }) => {
  await installFakeWakeLock(page)
  await page.goto('/survey')
  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(keepAwakeRow(page)).toContainText('● Active')

  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport)
    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      recordingHeight: document.querySelector('.survey-recording')!.getBoundingClientRect().height,
    }))
    expect(layout.scrollWidth).toBe(layout.clientWidth)
    expect(layout.scrollHeight).toBe(layout.clientHeight)
    // The existing recording section grew by one compact metrics row, not a
    // new panel -- a generous but bounded ceiling catches an accidental
    // full-panel addition without being brittle about exact pixel heights.
    expect(layout.recordingHeight).toBeLessThan(320)
    await expect(keepAwakeRow(page)).toBeVisible()
  }
})
