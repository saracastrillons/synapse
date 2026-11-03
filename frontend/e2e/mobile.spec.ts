import { expect, test } from '@playwright/test'
import { enterCity } from './helpers'

test('phone layout: full-screen map, panels one tap away', async ({ page }) => {
  await enterCity(page)
  await expect(page.locator('.side')).toHaveCount(0)
  const rail = await page.locator('.rail').boundingBox()
  const vh = page.viewportSize()!.height
  expect(rail!.y).toBeGreaterThan(vh * 0.8)
  await page.locator('.rail-btn', { hasText: 'Scenario Lab' }).click()
  await expect(page.locator('.side')).toContainText('Scenario Lab')
  // tools are hidden while a panel is open so nothing overlaps
  await expect(page.locator('.tools')).toBeHidden()
  // no horizontal scroll
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
