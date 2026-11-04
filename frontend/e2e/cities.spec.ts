import { expect, test } from '@playwright/test'
import { enterCity } from './helpers'

test('switch to New York from the globe', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('synapse.tour.done', '1'))
  await page.goto('/')
  await page.locator('.city-item', { hasText: 'New York' }).click()
  await expect(page.locator('.topbar')).toBeVisible({ timeout: 90_000 })
  await expect(page.locator('.crumbs')).toContainText('New York · Lower Manhattan')
  await expect(page.locator('.kpi', { hasText: 'Rail riders/h' })).toBeVisible()
  // stations of the real subway with their line badges
  await expect(page.locator('.label3d.station', { hasText: 'Wall Street' }).first()).toBeAttached()
})

test('rail outage and time of day in Medellín', async ({ page }) => {
  await enterCity(page)
  const side = page.locator('.side')
  await expect(side).toContainText('Rail transit')
  await expect(side.locator('.line-badge', { hasText: 'T-A' }).first()).toBeVisible()
  await side.getByRole('button', { name: /Suspend rail service/ }).click()
  await expect(page.locator('.toast').filter({ hasText: 'Rail service suspended' })).toBeVisible()
  await expect(page.locator('.kpi', { hasText: 'Rail riders/h' })).toContainText(/^Rail riders\/h0$/)
  await side.getByRole('button', { name: /Restore full service/ }).click()

  await side.getByRole('button', { name: 'Night' }).click()
  await expect(page.locator('.timechip')).toContainText('Night')
  await expect(page.locator('.clock')).toContainText(/^23:3/)
  // at night the demand model keeps few cars on the road
  await expect.poll(async () => Number((await page.locator('.kpi', { hasText: 'Agents' }).textContent())?.replace(/\D/g, '')), { timeout: 20_000 }).toBeLessThan(400)
})

test('Bogotá shows its metro line as under construction', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('synapse.tour.done', '1'))
  await page.goto('/')
  await page.locator('.city-item', { hasText: 'Bogotá' }).click()
  await expect(page.locator('.topbar')).toBeVisible({ timeout: 90_000 })
  await expect(page.locator('.side')).toContainText('under construction')
  await expect(page.locator('.kpi', { hasText: 'Rail riders/h' })).toHaveCount(0)
  await page.locator('.rail-btn', { hasText: 'Scenario Lab' }).click()
  await expect(page.locator('.side .scn', { hasText: 'Rail outage' })).toHaveCount(0)
  await expect(page.locator('.side .scn', { hasText: 'Accident · Avenida Carrera 10' })).toBeVisible()
})

test('a shared Lab link opens in the city it was made in', async ({ page }) => {
  const p = { seed: 3, vehicles: 1300, capacity: 1, smartNav: 0.35, signals: 'adaptive', preemption: true, storm: 0, powerDemand: 1, repairCrews: 2, ambulances: 1, incidentRate: 4, startHour: 7.25, dynamicDemand: true, metro: 1 }
  const setup = { city: 'newyork', scenario: 'metro', a: p, b: { ...p, smartNav: 0.8 }, labelB: 'Live navigation', duration: 300, reps: 1 }
  await page.goto(`/#lab=${Buffer.from(JSON.stringify(setup)).toString('base64')}`)
  await expect(page.locator('.crumbs')).toContainText('New York', { timeout: 90_000 })
  await expect(page.locator('.side .scn.on')).toContainText('Rail outage at rush hour')
})
