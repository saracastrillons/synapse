import { expect, test, type Route } from '@playwright/test'
import { enterCity, openPanel } from './helpers'

/**
 * Exercises the full LLM agent loop without a real model: the SYNAPSE API is mocked
 * so that "Gemini" first asks for the city state, then proposes a policy, then answers.
 * Verifies that the browser executes the tools, sends their results back, sanitises
 * model-supplied parameters and keeps the human in the loop for policy changes.
 */
test('Gemini agent: tool loop, evidence round-trip and human confirmation', async ({ page }) => {
  const requests: { contents: { role: string; parts: Record<string, unknown>[] }[] }[] = []
  await page.route('**/api/health', (route: Route) => route.fulfill({
    json: { status: 'ok', database: 'sqlite', events: 'in-process', postgis: false, pgrouting: false, copilot: { enabled: true, model: 'gemini-test' } },
  }))
  await page.route('**/api/copilot/step', async (route: Route) => {
    requests.push(route.request().postDataJSON())
    const step = requests.length
    const parts = step === 1
      ? [{ functionCall: { name: 'get_city_state', args: {} }, thoughtSignature: 'sig-1' }]
      : step === 2
        ? [{ functionCall: { name: 'propose_parameters', args: { label: 'Adaptive signals', params: { signals: 'adaptive', smartNav: 5, hacker: true } } } }]
        : [{ text: 'Traffic is stable.\n\n- **Recommendation:** keep adaptive signals\n- Evidence comes from the live twin' }]
    await route.fulfill({ json: { parts, model: 'gemini-test' } })
  })

  await enterCity(page)
  await openPanel(page, 'AI Command Center')
  await expect(page.getByRole('button', { name: /Gemini agent · gemini-test/ })).toHaveClass(/on/)

  await page.getByRole('button', { name: /Find the bottlenecks/ }).click()
  const answer = page.locator('.msg.ai').last()
  await expect(answer.locator('.answer')).toContainText('Recommendation:')
  await expect(answer.locator('.chip', { hasText: 'Gemini agent' })).toBeVisible()
  await expect(answer.locator('.step-name')).toHaveText(['get_city_state', 'propose_parameters'])

  // tool results were sent back to the model, with the thinking signature echoed verbatim
  const second = requests[1].contents
  expect(JSON.stringify(second)).toContain('sig-1')
  const response = second.at(-1)!.parts[0] as { functionResponse: { name: string; response: Record<string, unknown> } }
  expect(response.functionResponse.name).toBe('get_city_state')
  expect(response.functionResponse.response).toHaveProperty('speed')

  // parameters proposed by the model are sanitised (clamped, unknown keys dropped)
  await expect(answer.locator('.step', { hasText: 'propose_parameters' }).locator('.step-args')).toContainText('"smartNav":1')
  await expect(answer.locator('.step', { hasText: 'propose_parameters' }).locator('.step-args')).not.toContainText('hacker')

  // nothing changes until the user confirms
  const apply = answer.getByRole('button', { name: 'Apply "Adaptive signals"' })
  await apply.click()
  await expect(answer.getByRole('button', { name: /applied/ })).toBeDisabled()
})

test('falls back to the on-device planner when the LLM fails', async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({
    json: { status: 'ok', database: 'sqlite', events: 'in-process', copilot: { enabled: true, model: 'gemini-test' } },
  }))
  await page.route('**/api/copilot/step', (route) => route.fulfill({ status: 502, json: { detail: 'LLM provider error (503): overloaded' } }))
  await enterCity(page)
  await openPanel(page, 'AI Command Center')
  const box = page.getByPlaceholder(/Ask SYNAPSE/)
  await box.fill('Executive summary')
  await box.press('Enter')
  const answer = page.locator('.msg.ai').last()
  await expect(answer.locator('.notice')).toContainText('answered by the on-device planner')
  await expect(answer.locator('.answer')).toContainText('Executive summary')
  await expect(page.locator('.msg.user')).toHaveCount(1)
})
