import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

// Vitest config for @agentconnect.md/object-store — pure signing and parsing, plus local HTTP fixtures.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: githubActionsReporters('object-store.md')
  }
})
