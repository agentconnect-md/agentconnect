import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    setupFiles: ['./src/i18n/test-setup.ts'],
    reporters: githubActionsReporters('web.md')
  }
})
