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
  'test/runtime-launch.test.ts',
  // The sandbox-pod plane. A pod is always Linux, so its coordinates, its shim and its confined
  // `gh`/`glab` shells are POSIX by construction — a Windows daemon never stands one up. A new suite
  // over that plane belongs here; the ones absent from this list do pass on Windows today.
  'test/cluster-workspace-prepare.test.ts',
  'test/shim-workspace-files.test.ts',
  'test/shim-skill-handler.test.ts',
  'test/shim-cancellation.test.ts',
  'test/shim-exec-handler.test.ts',
  'test/shim-dial-in.test.ts',
  'test/shim-handshake.test.ts',
  'test/k8s-runtime-plane.test.ts',
  'test/cp/gh-shim.test.ts',
  'test/gitlab-self-managed-git.test.ts',
  // Every case stands up a second daemon on one root, which EADDRINUSEs on Windows: `start()` clears
  // a stale UDS before listening and a named pipe has no equivalent. Restore once that is fixed.
  // `orchestration.test.ts` is NOT here: only its pool-duty describe opens a root twice.
  'test/schedule-catchup.test.ts',
  'test/daemon-session-metadata-outbox-pool.test.ts',
  'test/daemon-session-sweeps-pool.test.ts',
  'test/daemon-loop-guard-pool.test.ts'
]

const platformExcluded = process.platform === 'win32' ? WINDOWS_EXCLUDED : []

// The budget every test gets before the platform scaling below. A per-test override can only
// SHORTEN what this grants, never extend it, so one written at or under this value is dead weight
// that fails first on the slowest platform. `test/no-shortened-test-budget.test.ts` rejects those.
export const BASE_TEST_TIMEOUT = 30_000

export default defineConfig({
  test: {
    environment: 'node',
    // Keep process-heavy, integration-shaped unit files from oversubscribing available test-worker
    // resources. Four on Windows too: the halving there bought time for inline per-test budgets that
    // no longer exist, and the polls those budgets never governed now scale in `test/wait-support.ts`.
    // MEASUREMENT ONLY — not for merge.
    maxWorkers: Number(process.env.AGENTCONNECT_MEASURE_WORKERS ?? 4),
    // The async store pays a microtask hop per statement; on a loaded CI box the IO-heavy store files
    // drift past vitest's 5 s default without being hung. Windows I/O is slower again by enough that
    // the same files need double the budget.
    testTimeout: process.platform === 'win32' ? BASE_TEST_TIMEOUT * 2 : BASE_TEST_TIMEOUT,
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
