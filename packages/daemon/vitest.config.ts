import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Keep process-heavy, integration-shaped unit files from oversubscribing
    // available test-worker resources.
    maxWorkers: 4,
    reporters: githubActionsReporters('daemon.md')
  }
})
