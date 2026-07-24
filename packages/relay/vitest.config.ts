import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

// Vitest config for @agentconnect.md/relay — co-located src/**/*.test.ts unit
// tests. The relay CP client FSM is driven through a fake Transport + FakeClock
// (no real socket, no Docker), mirroring the daemon's CpClient tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: githubActionsReporters('relay.md')
  }
})
