import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

// Co-located src/**/*.test.ts unit tests against a fake driver; no desktop or Cua Driver binary needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: githubActionsReporters('desktop.md')
  }
})
