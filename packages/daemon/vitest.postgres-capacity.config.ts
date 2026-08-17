import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'postgres-capacity',
    environment: 'node',
    include: ['test/performance/postgres-capacity.bench.ts'],
    globalSetup: ['./test/performance/postgres-capacity-global-setup.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    disableConsoleIntercept: true,
    hookTimeout: 120_000,
    testTimeout: 1_800_000
  }
})
