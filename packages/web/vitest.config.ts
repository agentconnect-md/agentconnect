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
    // Reuse DOM dependencies while keeping each file's module mocks and globals in its own VM.
    pool: 'vmForks',
    vmMemoryLimit: '512MiB',
    environment: 'node',
    setupFiles: ['./src/i18n/test-setup.ts'],
    reporters: githubActionsReporters('web.md')
  }
})
