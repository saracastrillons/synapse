/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 2000 },
  test: { environment: 'node', testTimeout: 60_000, include: ['src/**/*.test.ts'] },
})
