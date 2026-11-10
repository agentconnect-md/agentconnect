import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

// The computer image end to end (COMPUTER_IMAGE=<tag>): its Chromium, the form-fill extension and the daemon in Docker.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/form-fill-image.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    reporters: githubActionsReporters('computer-image.md')
  }
})
