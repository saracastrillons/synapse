import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// Screenshot generator for the README (not part of the test suite).
export default defineConfig({
  ...base,
  testDir: 'shots',
  timeout: 300_000,
  retries: 0,
  reporter: [['list']],
  projects: [{ name: 'shots', use: { viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 } }],
})
