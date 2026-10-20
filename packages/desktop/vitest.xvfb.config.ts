import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

// The Xvfb integration suite: the bundled daemon with the real Cua Driver and ffmpeg on a live X display.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    reporters: githubActionsReporters('desktop-xvfb.md')
  }
})
