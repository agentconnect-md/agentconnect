import { RESERVED_RESTART_CODE } from '@agentconnect.md/protocol'
import { exitAsChild, resolveDaemonEntry, spawnDaemon } from './delegate.js'
import { versionInstall } from './version-commands.js'
import { currentVersion, readMeta } from './version-store.js'

/**
 * Onboarding safety net for `run` (and the `login` foreground handoff, which runs
 * through here): if no daemon version is active yet — a fresh host where the user
 * ran `run`/`login` without a prior `agentconnect install` — pull the channel's
 * latest and activate it, so the daemon starts out of the box instead of erroring
 * with "no active daemon". Two short-circuits: an already-active `current`, and
 * dev mode (`AGENTCONNECT_DAEMON_ENTRY` points the CLI at an in-repo entry,
 * bypassing the version store entirely).
 *
 * Channel resolution is delegated to `versionInstall`, which reads `readMeta` — a
 * stored channel preference wins, else the CLI-derived default (`defaultChannel`).
 * We deliberately DON'T pass an explicit `channel`: this bootstrap is not a user
 * choice, and `versionInstall` only persists `channel` when one is passed, so a
 * bare install here never turns the default into a stored preference. First
 * install on an empty store also activates it, so the spawn below resolves
 * `<root>/current`.
 */
export async function ensureDaemonInstalled(root: string): Promise<void> {
  if (process.env.AGENTCONNECT_DAEMON_ENTRY) return
  if (currentVersion(root)) return
  console.error(`agentconnect: no daemon installed — installing the latest ${readMeta(root).channel} version…`)
  await versionInstall(root, {})
}

/**
 * Foreground `run` respawn shell (cli-daemon-split.md §6.1). Unlike the service
 * path (launchd/systemd is the supervisor), a foreground `run` has no external
 * supervisor — but the CLI process itself is already resident here, so it acts
 * as one. It spawns the daemon, and when the daemon exits with the reserved
 * restart code (a planned restart/upgrade), it re-resolves `<root>/current` and
 * respawns the (possibly upgraded) bundle. Any other exit is propagated.
 *
 * The child runs with AGENTCONNECT_SUPERVISOR=cli so the daemon knows it is
 * shell-supervised and accepts CP-commanded restart/upgrade (§7.1).
 *
 * Signals: the child shares this process's foreground process group, so the
 * terminal delivers SIGINT (Ctrl-C) to the child directly — we must NOT forward
 * it (that would double-deliver). We stay alive to reap the child and decide
 * whether to respawn. A non-terminal SIGTERM is forwarded to the child once.
 * When we finally stop, `exitAsChild` removes these handlers before re-raising a
 * signaled child's signal, so a signal (e.g. Ctrl-C during startup, before the
 * daemon installs its own handlers) is reproduced faithfully rather than being
 * reported as a clean exit.
 */
export async function runShell(root: string, argv: string[]): Promise<never> {
  await ensureDaemonInstalled(root)

  let current: ReturnType<typeof spawnDaemon>['child'] | undefined

  const onInt = (): void => {
    // no-op: the child receives terminal SIGINT directly via the shared pgroup.
  }
  const onTerm = (): void => {
    current?.kill('SIGTERM')
  }
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  const cleanup = (): void => {
    process.removeListener('SIGINT', onInt)
    process.removeListener('SIGTERM', onTerm)
  }

  for (;;) {
    const entry = resolveDaemonEntry(root)
    const { child, done } = spawnDaemon(entry, argv, { AGENTCONNECT_SUPERVISOR: 'cli' })
    current = child
    const result = await done
    current = undefined
    if (result.code === RESERVED_RESTART_CODE) continue // planned restart/upgrade — respawn current
    return exitAsChild(result, cleanup)
  }
}
