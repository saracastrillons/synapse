import { expect, type Page } from '@playwright/test'

/** Boot the app, wait for the globe and descend into the Medellín twin. */
export async function enterCity(page: Page, path = '/', { tour = false } = {}) {
  // the guided tour auto-starts on a first visit; most tests start as a returning user
  if (!tour) await page.addInitScript(() => localStorage.setItem('synapse.tour.done', '1'))
  await page.goto(path)
  const descend = page.getByRole('button', { name: /Descend into Medellín/ })
  await expect(descend).toBeVisible({ timeout: 60_000 })
  await descend.click()
  await expect(page.locator('.topbar')).toBeVisible({ timeout: 60_000 })
}

export async function openPanel(page: Page, name: string) {
  await page.locator('.rail-btn', { hasText: name }).click()
}

export async function clockSeconds(page: Page) {
  const t = (await page.locator('.clock').textContent()) ?? '00:00:00'
  const [h, m, s] = t.split(':').map(Number)
  return h * 3600 + m * 60 + s - 7 * 3600
}
