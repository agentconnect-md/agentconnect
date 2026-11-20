import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

// Vitest config for @agentconnect.md/email-worker — the email handler against a fake message and a fake relay.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: githubActionsReporters('email-worker.md')
  }
})
