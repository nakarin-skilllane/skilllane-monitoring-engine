import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // the integration test seeds ClickHouse and builds a report
    testTimeout: 60_000,
  },
})
