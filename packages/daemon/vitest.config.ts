import { defineConfig, configDefaults } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'
import { weightBalancedSequencer } from '../../scripts/vitest-shard-sequencer.js'
import { BASE_TEST_TIMEOUT } from '../../scripts/vitest-test-budget.js'

// The files that call `vi.mock`. A mock is registered per FILE but rewires a module in the registry,
// so under a shared registry it either misses (the real module was already imported by an earlier
// file) or leaks into a later one — `workspace.test.ts` mocking `simple-git` came out as "fatal: not
// a git repository" because real git ran. Nothing else in this suite is registry-sensitive, so these
// keep per-file isolation and everything else stops paying for it.
//
// `test/no-stray-vi-mock.test.ts` fails if this list drifts from what the suite actually mocks.
export const MOCKING_TESTS = [
  'test/cp/cp-integration.test.ts',
  'test/mcp-control-server.test.ts',
  'test/mcp-bridge-e2e.test.ts',
  'test/slack-upload-file.test.ts',
  'test/daemon-cp-onboarding.test.ts',
  'test/runtime-install-repair-collapse.test.ts',
  'test/skill-workspace-mutator.test.ts',
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
  'test/microsandbox-launch.test.ts',
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

// Seconds on the Windows runner, the mean of three runs. These 25 files are 78% of the suite's time, which is
// why weighing them alone balances the shards; everything else is the fallback below, and a new file needs an
// entry only once it grows into this tail. `test/shard-weights.test.ts` fails when an entry stops naming a file.
export const SHARD_WEIGHTS: Record<string, number> = {
  'test/workspace-session-clone.test.ts': 121,
  'test/workspace-secondary-roots.test.ts': 100,
  'test/daemon-message-agent.test.ts': 85,
  'test/daemon-lifecycle.test.ts': 73,
  'test/daemon-hook.test.ts': 68,
  'test/reconcile-watch.test.ts': 59,
  'test/daemon-duty-install.test.ts': 55,
  'test/cp/cp-agent-reconcile.test.ts': 50,
  'test/daemon-duty-drain.test.ts': 46,
  'test/daemon-commands.test.ts': 39,
  'test/daemon-webchat.test.ts': 39,
  'test/daemon-agent-mention-routing.test.ts': 31,
  'test/workspace-git-write.test.ts': 30,
  'test/daemon-duty-fence.test.ts': 30,
  'test/linear-ingress.test.ts': 30,
  'test/daemon-smoke.test.ts': 29,
  'test/daemon-session-hosts.test.ts': 28,
  'test/daemon-transcript.test.ts': 23,
  'test/durable-inbox.test.ts': 21,
  'test/telegram-threading.test.ts': 18,
  'test/daemon-duty-replacement.test.ts': 18,
  'test/session-manager.test.ts': 17,
  'test/daemon-serial-gate.test.ts': 14,
  'test/dream-runner.test.ts': 14,
  'test/orchestration.test.ts': 13
}

// The unlisted 326 files measured 0.88 s on average, and rounding that up costs the partition nothing.
export const SHARD_WEIGHT_FALLBACK = 1

const platformExcluded = process.platform === 'win32' ? WINDOWS_EXCLUDED : []

export default defineConfig({
  test: {
    environment: 'node',
    // Keep process-heavy, integration-shaped unit files from oversubscribing available test-worker
    // resources. Four on Windows too: the halving there bought time for inline per-test budgets that
    // no longer exist, and the polls those budgets never governed now scale in `test/wait-support.ts`.
    maxWorkers: 4,
    sequence: { sequencer: weightBalancedSequencer(SHARD_WEIGHTS, SHARD_WEIGHT_FALLBACK) },
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
