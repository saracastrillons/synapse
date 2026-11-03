import { expect, test } from '@playwright/test'
import { enterCity } from './helpers'

test('first visit: the guided tour walks through the whole story', async ({ page }) => {
  await enterCity(page, '/', { tour: true })
  const tour = page.getByRole('dialog', { name: /Guided tour/ })
  await expect(tour).toContainText('Welcome to SYNAPSE', { timeout: 20_000 })
  await tour.getByRole('button', { name: 'Start the tour' }).click()

  await expect(tour).toContainText('A city that is alive')
  await tour.getByRole('button', { name: 'Next' }).click()

  await expect(tour).toContainText('Meet an agent')
  await expect(page.locator('.inspector')).toBeVisible()
  await expect(page.locator('.inspector')).toContainText('Decision log')
  await tour.getByRole('button', { name: 'Next' }).click()

  await expect(tour).toContainText('Now, break something')
  await tour.getByRole('button', { name: 'Block Avenida Oriental' }).click()
  await expect(tour.getByRole('button', { name: /Accident created/ })).toBeDisabled()
  await tour.getByRole('button', { name: 'Next' }).click()

  await expect(tour).toContainText('Ask the AI what to do')
  await expect(page.locator('.side')).toContainText('AI Command Center')
  await tour.getByRole('button', { name: 'Ask the copilot' }).click()
  await expect(page.locator('.msg.user')).toContainText('Avenida Oriental')
  await expect(page.locator('.msg.ai .elapsed').first()).toBeVisible()
  await tour.getByRole('button', { name: 'Next' }).click()

  await expect(tour).toContainText('Rewind time')
  await tour.getByRole('button', { name: 'Rewind 2 minutes' }).click()
  await expect(page.locator('.tm')).toContainText('Timeline B')
  await tour.getByRole('button', { name: 'Next' }).click()

  await expect(tour).toContainText('Your turn')
  await tour.getByRole('button', { name: 'Start exploring' }).click()
  await expect(tour).toBeHidden()

  // returning visitors are not interrupted again
  await page.reload()
  await page.getByRole('button', { name: /Descend into Medellín/ }).click()
  await expect(page.locator('.topbar')).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(6000)
  await expect(page.getByRole('dialog', { name: /Guided tour/ })).toHaveCount(0)
})

test('the tour can be replayed from the globe and closed with Escape', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('synapse.tour.done', '1'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Take the 60-second tour' }).click()
  const tour = page.getByRole('dialog', { name: /Guided tour/ })
  await expect(tour).toContainText('Welcome to SYNAPSE', { timeout: 60_000 })
  await page.keyboard.press('Escape')
  await expect(tour).toBeHidden()
})
