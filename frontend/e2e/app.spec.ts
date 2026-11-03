import { expect, test } from '@playwright/test'
import { clockSeconds, enterCity, openPanel } from './helpers'

test.describe('SYNAPSE · core journeys', () => {
  test('boots, shows the globe and descends into a live city', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'SYNAPSE' })).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.city-item.on')).toContainText('Medellín')
    await enterCity(page)
    await expect(page.locator('.kpi', { hasText: 'Agents' })).toContainText(/1[.,]?3\d\d/)
    await expect(page.getByText('Medellín · Centro')).toBeVisible()
    // the simulation is running: the clock moves forward
    const t0 = await clockSeconds(page)
    await expect.poll(() => clockSeconds(page), { timeout: 30_000 }).toBeGreaterThan(t0)
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('on-device copilot answers with tool calls and evidence', async ({ page }) => {
    await enterCity(page)
    await openPanel(page, 'AI Command Center')
    // no API in this build → the planner is the active engine
    await expect(page.getByRole('button', { name: 'On-device planner' })).toHaveClass(/on/)
    const box = page.getByPlaceholder(/Ask SYNAPSE/)
    await box.fill('A* vs Dijkstra')
    await box.press('Enter')
    await expect(page.locator('.step-name', { hasText: 'compare_algorithms' })).toBeVisible()
    await expect(page.locator('.msg.ai .answer')).toContainText('same optimal cost')
  })

  test('Scenario Lab runs an A/B experiment, exports CSV and compares two runs', async ({ page }) => {
    await enterCity(page)
    await openPanel(page, 'Scenario Lab')
    const side = page.locator('.side')
    await side.getByRole('button', { name: '5 min', exact: true }).click()
    await side.getByRole('button', { name: '1', exact: true }).click()
    await side.getByRole('button', { name: /Run A\/B/ }).click()
    await expect(side.getByText(/Results · Baseline/i)).toBeVisible({ timeout: 180_000 })
    await expect(side.locator('table.cmp')).toContainText('Mean speed')

    const download = page.waitForEvent('download')
    await side.getByRole('button', { name: 'CSV', exact: true }).click()
    expect((await download).suggestedFilename()).toMatch(/^synapse-baseline-\d+\.csv$/)

    // second experiment on another situation, then compare both intervention arms
    await side.getByRole('button', { name: /Traffic demand \+40%/ }).click()
    await side.getByRole('button', { name: /Run A\/B/ }).click()
    await expect(side.getByText(/Results · Traffic demand/i)).toBeVisible({ timeout: 180_000 })
    await side.locator('.alert-row').first().getByRole('button', { name: 'Compare' }).click()
    await side.getByRole('button', { name: 'Compare', exact: true }).first().click()
    const modal = page.locator('.modal')
    await expect(modal.getByRole('heading', { name: 'Compare experiments' })).toBeVisible()
    await expect(modal).toContainText('Different scenarios')
    await expect(modal.locator('table.cmp tbody tr')).toHaveCount(8)
    await modal.getByRole('button', { name: 'Done' }).click()
    await expect(modal).toBeHidden()
  })

  test('Time Machine rewinds and forks a new branch', async ({ page }) => {
    await enterCity(page)
    await page.getByRole('button', { name: '25×' }).click()
    await expect.poll(() => clockSeconds(page), { timeout: 60_000 }).toBeGreaterThan(70)
    const track = page.locator('.tm-track')
    const box = (await track.boundingBox())!
    await page.mouse.click(box.x + box.width * 0.04, box.y + box.height / 2)
    await expect(page.locator('.tm')).toContainText('Timeline B')
    expect(await clockSeconds(page)).toBeLessThan(70)
  })

  test('shared Lab setup links open the right scenario', async ({ page }) => {
    const setup = { scenario: 'storm', a: { seed: 7, vehicles: 900, capacity: 1, smartNav: 0.35, signals: 'adaptive', preemption: true, storm: 0, powerDemand: 1, repairCrews: 2, ambulances: 1, incidentRate: 6 }, b: { seed: 7, vehicles: 900, capacity: 1, smartNav: 0.35, signals: 'adaptive', preemption: true, storm: 0, powerDemand: 1, repairCrews: 4, ambulances: 1, incidentRate: 6 }, labelB: 'Four crews', duration: 300, reps: 3 }
    const hash = Buffer.from(JSON.stringify(setup)).toString('base64')
    await page.goto(`/#lab=${hash}`)
    const side = page.locator('.side')
    await expect(side.getByText('Scenario Lab')).toBeVisible({ timeout: 60_000 })
    await expect(side.locator('.scn.on')).toContainText('Storm & blackout')
    await expect(side.getByRole('button', { name: /Run A\/B · 6 simulations × 5 min/ })).toBeVisible()
  })

  test('cloud workspace explains offline mode when the API is down', async ({ page }) => {
    await enterCity(page)
    await openPanel(page, 'Cloud workspace')
    await expect(page.locator('.side')).toContainText('Offline demo mode')
  })
})
