import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

export default defineConfig({
  test: {
    environment: 'node',
    // Beside the source, which is where these tests were before the extraction
    // and where the control plane still keeps its own.
    include: ['src/**/*.test.ts'],
    reporters: githubActionsReporters('observability.md')
  }
})
