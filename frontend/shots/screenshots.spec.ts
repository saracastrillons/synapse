import { expect, test, type Page } from '@playwright/test'
import { clockSeconds, enterCity, openPanel } from '../e2e/helpers'

/** Regenerates the README screenshots: `npx playwright test -c playwright.shots.config.ts` */
const OUT = '../docs/screenshots'
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 88 })

test('globe', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: /Descend into Medellín/ })).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(5000)
  await shot(page, '01-earth-command')
  await page.setViewportSize({ width: 1280, height: 640 })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${OUT}/social-preview.png` })
})

test('city, copilot and time machine', async ({ page }) => {
  await enterCity(page)
  await page.getByRole('button', { name: '10×' }).click()
  await expect.poll(() => clockSeconds(page), { timeout: 90_000 }).toBeGreaterThan(150)
  await shot(page, '02-city-twin')

  await openPanel(page, 'AI Command Center')
  await page.getByRole('button', { name: /Restore traffic after a crash/ }).click()
  await expect(page.locator('.xai')).toBeVisible({ timeout: 120_000 })
  await page.locator('.chat-log').evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
  await page.waitForTimeout(1500)
  await shot(page, '03-ai-command-center')

  await openPanel(page, 'City operations')
  const track = page.locator('.tm-track')
  const box = (await track.boundingBox())!
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height / 2)
  await page.waitForTimeout(12_000)
  await shot(page, '05-time-machine')
})

test('scenario lab and comparison', async ({ page }) => {
  await enterCity(page)
  await openPanel(page, 'Scenario Lab')
  const side = page.locator('.side')
  await side.getByRole('button', { name: /Storm & blackout/ }).click()
  await side.getByRole('button', { name: '5 min', exact: true }).click()
  await side.getByRole('button', { name: '3', exact: true }).click()
  await side.getByRole('button', { name: /Run A\/B/ }).click()
  await expect(side.getByText(/Results · Storm/i)).toBeVisible({ timeout: 180_000 })
  await side.getByText(/Results · Storm/i).scrollIntoViewIfNeeded()
  await page.waitForTimeout(1000)
  await shot(page, '04-scenario-lab')

  await side.getByRole('button', { name: /Heat wave/ }).click()
  await side.getByRole('button', { name: /Run A\/B/ }).click()
  await expect(side.getByText(/Results · Heat wave/i)).toBeVisible({ timeout: 180_000 })
  await side.locator('.alert-row').first().getByRole('button', { name: 'Compare' }).click()
  await side.getByRole('button', { name: 'Compare', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Compare experiments' })).toBeVisible()
  await page.waitForTimeout(800)
  await shot(page, '06-compare')
})

test.describe('phone', () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  test('mobile', async ({ page }) => {
    await enterCity(page)
    await page.waitForTimeout(6000)
    await shot(page, '07-mobile')
  })
})
