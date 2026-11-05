import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // the integration test waits for BullMQ retries (backoff) against a real Redis
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
