import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

// Vitest config for @agentconnect.md/connection — co-located src/**/*.test.ts
// unit tests only (the primitives here are pure logic + a fake-socket seam, no
// real I/O). Mirrors the daemon/protocol single-project shape.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: githubActionsReporters('connection.md')
  }
})
