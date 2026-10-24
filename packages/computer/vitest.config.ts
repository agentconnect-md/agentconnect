import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

// Unit tests (fake driver, license-scan fixtures); no desktop or Cua Driver binary needed. Xvfb: vitest.xvfb.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    reporters: githubActionsReporters('computer.md')
  }
})
