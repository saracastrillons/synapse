import { defineConfig, devices } from '@playwright/test'

const CI = !!process.env.CI

// WebGL in headless Chromium runs on SwiftShader (software rendering)
const gl = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: { args: gl },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile/ },
  ],
  webServer: {
    command: 'npm run build:e2e && npx vite preview --outDir dist-e2e --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !CI,
    timeout: 180_000,
  },
})
