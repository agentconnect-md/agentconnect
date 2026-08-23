import { defineConfig, configDefaults } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

// The files that call `vi.mock`. A mock is registered per FILE but rewires a module in the registry,
// so under a shared registry it either misses (the real module was already imported by an earlier
// file) or leaks into a later one — `workspace.test.ts` mocking `simple-git` came out as "fatal: not
// a git repository" because real git ran. Nothing else in this suite is registry-sensitive, so these
// keep per-file isolation and everything else stops paying for it.
//
// `test/no-stray-vi-mock.test.ts` fails if this list drifts from what the suite actually mocks.
export const MOCKING_TESTS = [
  'test/cp/cp-integration.test.ts',
  'test/slack-upload-file.test.ts',
  'test/daemon-cp-onboarding.test.ts',
  'test/runtime-install-repair-collapse.test.ts',
  'test/telegram-connection.test.ts',
  'test/workspace-git.test.ts',
  'test/workspace.test.ts'
]

export default defineConfig({
  test: {
    environment: 'node',
    // Keep process-heavy, integration-shaped unit files from oversubscribing
    // available test-worker resources.
    maxWorkers: 4,
    // The async store pays a microtask hop per statement; on a loaded CI box the
    // IO-heavy store files drift past vitest's 5 s default without being hung.
    testTimeout: 30_000,
    reporters: githubActionsReporters('daemon.md'),
    projects: [
      {
        extends: true,
        test: {
          name: 'daemon',
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...MOCKING_TESTS],
          // Execute each module once per worker instead of once per FILE. Module-level state is
          // shared as a result, which is why the workspace execution plane had to become per-daemon
          // instance state first — see `WorkspaceManager`.
          isolate: false
        }
      },
      {
        extends: true,
        test: {
          name: 'daemon-mocked',
          include: MOCKING_TESTS,
          isolate: true
        }
      }
    ]
  }
})
