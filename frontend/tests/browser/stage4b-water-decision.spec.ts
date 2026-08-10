import { test, expect } from '@playwright/test'

/**
 * Stage 4B: the gate open/hold/close recommendation, ported from
 * evaluateGate() (index.html:3672-3710). No localStorage/IndexedDB seeding is
 * needed -- the decision panel is field-independent and reads only the real
 * bundled data/gate_rules.json and data/weather.json (see
 * frontend/src/domain/water/gateRules.ts).
 */

test('shows the real shipped recommendation by default, recomputes live, and honors inclusive threshold boundaries', async ({ page }) => {
  await page.goto('/water')

  const panel = page.getByRole('region', { name: 'Gate recommendation' })
  await expect(panel).toBeVisible()

  // Real data/weather.json (0mm rain, 4 dry days, 20% forecast) against real
  // data/gate_rules.json (heavy 20 / light 5 / forecast 60 / dry-spell 3)
  // recommends opening the gate today.
  await expect(panel.getByText('開ける')).toBeVisible()
  await expect(panel.getByText('無降雨が4日続いており、乾燥が進んでいます。水門を開けて入水してください。')).toBeVisible()
  await expect(panel.getByText('heavy rain ≥ 20mm · light rain ≥ 5mm · forecast ≥ 60% · dry spell ≥ 3d')).toBeVisible()

  const rainInput = panel.getByLabel('Rainfall, last 24h (mm)')

  // 19mm is below the heavy-rain threshold (20mm) but already clears the
  // light-rain threshold (5mm, checked second): hold, not open.
  await rainInput.fill('19')
  await expect(panel.getByText('様子見')).toBeVisible()
  await expect(panel.getByText(/直近24時間で19mmの降雨があり/)).toBeVisible()

  // At the heavy-rain threshold: >= is inclusive, so this must already close.
  await rainInput.fill('20')
  await expect(panel.getByText('閉める')).toBeVisible()
  await expect(panel.getByText(/直近24時間で20mmのまとまった降雨がありました/)).toBeVisible()

  await rainInput.fill('21')
  await expect(panel.getByText('閉める')).toBeVisible()

  // Invalid input falls back to 0 rainfall, matching legacy's readNumberInput.
  await rainInput.fill('-5')
  await expect(panel.getByText('開ける')).toBeVisible()
})

test('viewports: the recommendation panel stays reachable with no document scroll, and coexists with Stage 4A water features', async ({ page }) => {
  await page.goto('/water')

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
    await expect(page.getByRole('region', { name: 'Gate recommendation' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add Water Point' })).toBeVisible()
    const layout = await page.evaluate(() => {
      const map = document.querySelector('.map-workspace')!.getBoundingClientRect()
      const inspector = document.querySelector('.inspector-panel')!.getBoundingClientRect()
      return { mapWidth: map.width, inspectorRight: inspector.right, innerWidth: window.innerWidth }
    })
    expect(layout.mapWidth).toBeGreaterThan(layout.innerWidth / 2)
    expect(Math.round(layout.inspectorRight)).toBeLessThanOrEqual(layout.innerWidth)
  }
})
