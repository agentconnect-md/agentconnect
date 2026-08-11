import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

// Vitest config for @agentconnect.md/k8s-client — co-located src/**/*.test.ts
// unit tests against an in-process fake API server (src/testing), no cluster.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: githubActionsReporters('k8s-client.md')
  }
})
