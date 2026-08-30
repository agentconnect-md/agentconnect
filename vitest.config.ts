import { defineConfig } from 'vitest/config'
import { BASE_TEST_TIMEOUT } from './packages/daemon/vitest.config.js'

// `eval:gates` and its four siblings run daemon test files with `vitest run` from HERE, where
// nothing set a budget — so the same file got vitest's 5 s default instead of the 30 s its own
// package grants it, and `daemon-evaluation.test.ts` timed out on a loaded runner starting a daemon.
export default defineConfig({ test: { testTimeout: BASE_TEST_TIMEOUT } })
