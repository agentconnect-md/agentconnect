import { RESERVED_RESTART_CODE } from '@agentconnect.md/protocol'
import { exitAsChild, resolveDaemonEntry, spawnDaemon, type ChildResult } from './delegate.js'
import { runRecoveryFlow, shouldOfferRecovery } from './run-recovery.js'
import { spawnDaemonViaLoginShell } from './service-spawn.js'
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
 * respawns the (possibly upgraded) bundle. Any other exit is propagated — except
 * an interactive startup failure, where the recovery prompt (run-recovery.ts)
 * may switch versions and respawn instead.
 *
 * The child runs with AGENTCONNECT_SUPERVISOR=cli so the daemon knows it is
 * shell-supervised and accepts CP-commanded restart/upgrade (§7.1).
 *
 * Service mode (AGENTCONNECT_SUPERVISOR=service in OUR env — the unit launched
 * this CLI): the daemon is spawned through the user's interactive login shell
 * so it inherits a fresh terminal-equivalent environment instead of the
 * service manager's minimal one (service-spawn.ts). If the login shell never
 * reaches the daemon (broken/hanging profile), we drop to plain direct spawns
 * for the rest of this process's life rather than crash-looping through the
 * broken shell. Foreground runs never wrap: the env is already the user's, and
 * an extra `-i` shell would fight the terminal for the process group.
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
/** What the respawn loop does after a child exits. Pure so the shutdown race
 *  (stop requested before the login-shell attempt reached readiness) is
 *  regression-testable without spawning processes. */
export function decideNext(
  result: ChildResult & { ready?: boolean },
  state: { viaShell: boolean; stopRequested: boolean }
): 'exit' | 'fallback-direct' | 'respawn' {
  // A requested stop beats everything: the exit we just observed is the stop
  // being honored (the forwarded TERM may have hit a not-yet-ready login
  // shell), and launching ANY replacement would leave a daemon running — or
  // starting — after the service manager asked us to stop.
  if (state.stopRequested) return 'exit'
  if (state.viaShell && result.ready === false) return 'fallback-direct'
  if (result.code === RESERVED_RESTART_CODE) return 'respawn'
  return 'exit'
}

export async function runShell(root: string, argv: string[]): Promise<never> {
  await ensureDaemonInstalled(root)

  let current: ReturnType<typeof spawnDaemon>['child'] | undefined
  let stopRequested = false

  const onInt = (): void => {
    // no-op: the child receives terminal SIGINT directly via the shared pgroup.
  }
  const onTerm = (): void => {
    stopRequested = true
    current?.kill('SIGTERM')
  }
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  const cleanup = (): void => {
    process.removeListener('SIGINT', onInt)
    process.removeListener('SIGTERM', onTerm)
  }

  let viaShell = process.env.AGENTCONNECT_SUPERVISOR === 'service'
  for (;;) {
    const entry = resolveDaemonEntry(root)
    const spawnedAt = Date.now()
    const { child, done } = viaShell
      ? spawnDaemonViaLoginShell(root, entry, argv, { AGENTCONNECT_SUPERVISOR: 'cli' })
      : spawnDaemon(entry, argv, { AGENTCONNECT_SUPERVISOR: 'cli' })
    current = child
    const result = await done
    current = undefined
    const next = decideNext(result, { viaShell, stopRequested })
    if (next === 'fallback-direct') {
      // The login shell exited/was killed before the daemon ever wrote its
      // lock — profile problem, not a daemon problem. Retry without the shell;
      // a genuine daemon startup error will then surface and propagate.
      console.error('agentconnect: login-shell launch never reached the daemon — falling back to direct spawn')
      viaShell = false
      continue
    }
    if (next === 'respawn') continue // planned restart/upgrade — respawn current
    // Startup failure in an interactive foreground run: offer rollback /
    // re-download / manual version selection instead of just dying (run-recovery.ts).
    const recoverable = shouldOfferRecovery(result, {
      stopRequested,
      supervised: process.env.AGENTCONNECT_SUPERVISOR === 'service',
      devEntry: Boolean(process.env.AGENTCONNECT_DAEMON_ENTRY),
      interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
      elapsedMs: Date.now() - spawnedAt
    })
    if (recoverable && (await runRecoveryFlow(root, result)) === 'respawn') continue
    return exitAsChild(result, cleanup)
  }
}
