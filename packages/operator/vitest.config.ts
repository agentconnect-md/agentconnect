import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

// Vitest config for @agentconnect.md/operator — co-located src/**/*.test.ts
// unit tests against the k8s-client testing fake; no cluster required.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: githubActionsReporters('operator.md')
  }
})
