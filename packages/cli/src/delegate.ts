import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { currentEntry, currentLink } from './paths.js'
import { commandSelector } from './service/instance.js'

/**
 * Delegation (cli-daemon-split.md §4.2): the CLI owns lifecycle/version/upgrade
 * itself and hands every other subcommand (run/chat/agent/mcp-bridge/
 * git-credential/gh-token, plus any future/unknown daemon command) to the ACTIVE
 * daemon version by re-executing its bundle with the argv passed through
 * verbatim. The daemon's commander entry is unaware it was delegated to.
 */

export interface ChildResult {
  code: number | null
  signal: NodeJS.Signals | null
}

/**
 * Resolve the daemon entry to exec, or throw a human-readable error. Honors
 * `AGENTCONNECT_DAEMON_ENTRY` (via `currentEntry`) for in-repo dev; otherwise
 * requires `<root>/current` to be populated (P2 version management installs it).
 */
export function resolveDaemonEntry(root: string): string {
  const entry = currentEntry(root)
  if (!existsSync(entry)) {
    if (process.env.AGENTCONNECT_DAEMON_ENTRY) {
      throw new Error(`AGENTCONNECT_DAEMON_ENTRY points at a missing file: ${entry}`)
    }
    throw new Error(
      `no active daemon at ${currentLink(root)} — install one with \`agentconnect${commandSelector({ root })} install\` (or \`agentconnect${commandSelector({ root })} run\`, which auto-installs)`
    )
  }
  return entry
}

/**
 * Spawn the daemon bundle with inherited stdio and extra env, resolving with the
 * child's numeric exit code (or the signal it died from). Shared by `delegate`
 * (one-shot) and the `run` respawn shell.
 */
export function spawnDaemon(
  entry: string,
  argv: string[],
  extraEnv: Record<string, string> = {}
): { child: ReturnType<typeof spawn>; done: Promise<ChildResult> } {
  const child = spawn(process.execPath, [entry, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  })
  const done = new Promise<ChildResult>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
    child.on('error', (err) => {
      console.error(`agentconnect: failed to launch daemon (${entry}): ${(err as Error).message}`)
      resolve({ code: 1, signal: null })
    })
  })
  return { child, done }
}

/**
 * Terminate this process the way the child did, so the CLI is transparent to
 * whatever launched it. `cleanup` first removes our own signal listeners, then a
 * signaled child is reproduced by re-raising that signal under the DEFAULT
 * disposition (conventional 128+n status) — never reported as success — and a
 * normal exit propagates the child's code.
 */
export async function exitAsChild(result: ChildResult, cleanup: () => void): Promise<never> {
  cleanup()
  if (result.signal) {
    process.kill(process.pid, result.signal)
    // The re-raised signal terminates us; block in case it is momentarily
    // deferred so we never fall through to a misleading exit(0).
    await new Promise<never>(() => {})
  }
  process.exit(result.code ?? 0)
}

/**
 * One-shot delegation: exec the daemon entry with `argv` and exit this process
 * with whatever the child exited with. `argv` is passed through verbatim (it
 * still carries global flags like `--root`, which the daemon re-parses).
 *
 * Signals: a terminal SIGINT (Ctrl-C) reaches the child directly via the shared
 * process group, so we don't forward it (that would double-deliver). A
 * non-terminal SIGTERM targets only the CLI pid, so we forward it to the child —
 * otherwise a long-running delegated command (e.g. `chat`) would be orphaned.
 */
export async function delegate(root: string, argv: string[]): Promise<never> {
  const entry = resolveDaemonEntry(root)
  const { child, done } = spawnDaemon(entry, argv)
  const onTerm = (): void => {
    child.kill('SIGTERM')
  }
  const onInt = (): void => {
    // no-op: the child already receives terminal SIGINT via the shared pgroup;
    // handling it here just keeps us alive to reap the child.
  }
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)
  const result = await done
  return exitAsChild(result, () => {
    process.removeListener('SIGTERM', onTerm)
    process.removeListener('SIGINT', onInt)
  })
}
