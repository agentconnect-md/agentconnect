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

// Whole files the suite cannot run on Windows, excluded when the platform IS Windows so
// `vitest run` is green for a Windows contributor too. A single non-portable CASE belongs on
// `it.skipIf(process.platform === 'win32')` (the suite's existing idiom) — this list is only for
// files whose every case is POSIX-only. `test/windows-exclusions.test.ts` fails if an entry goes stale.
export const WINDOWS_EXCLUDED = [
  // A filesystem path handed to `net.Server.listen`; on Windows that argument is a named pipe name.
  'test/mcp-bridge-e2e.test.ts',
  'test/shim-gh-token.test.ts',
  'test/shim-tunnel.test.ts',
  'test/sandbox-credential-helper.test.ts',
  'test/gitlab-self-managed-host.test.ts',
  // `mode & 0o777` assertions throughout: Windows carries no POSIX mode bits to assert on.
  'test/config-file-env.test.ts',
  'test/evaluation-events.test.ts',
  'test/shim-channels.test.ts',
  'test/skills-cli-cell.test.ts',
  'test/runtime-launch.test.ts'
]

const platformExcluded = process.platform === 'win32' ? WINDOWS_EXCLUDED : []

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
          exclude: [...configDefaults.exclude, ...MOCKING_TESTS, ...platformExcluded],
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
          // Applied here too so one list governs both projects if a mocking file ever lands on it.
          exclude: [...configDefaults.exclude, ...platformExcluded],
          isolate: true
        }
      }
    ]
  }
})
