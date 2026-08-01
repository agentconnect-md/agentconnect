import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { daemonLockPath } from './paths.js'
import { loginShell, shellExecArgv } from './shell-exec.js'
import { spawnDaemon, type ChildResult } from './delegate.js'

/**
 * Service-mode daemon launch: run the daemon through the user's interactive
 * login shell (see shell-exec.ts) so it inherits a fresh terminal-equivalent
 * environment, with a readiness watchdog so a broken profile can never wedge
 * the service.
 *
 * Readiness: the daemon writes its pid to `<root>/daemon.lock` first thing in
 * `run`, and the shell `exec`s the daemon in-place (pid preserved) — so
 * "lock content == child pid" is a precise came-up signal. If it never appears
 * before the deadline while the child is still alive (an `.bashrc` that hangs
 * or `exec`s tmux), the child is killed and the result is marked not-ready;
 * the run shell then falls back to a plain direct spawn.
 */

export interface ServiceChildResult extends ChildResult {
  /** Did the daemon provably start under the login shell? False means the
   *  shell never reached the daemon (rc hang/exec hijack, profile error). */
  ready: boolean
}

const READY_TIMEOUT_MS = 30_000
const POLL_MS = 250

export function spawnDaemonViaLoginShell(
  root: string,
  entry: string,
  argv: string[],
  extraEnv: Record<string, string> = {},
  opts: { readyTimeoutMs?: number; pollMs?: number; shell?: string } = {}
): { child: ReturnType<typeof spawn>; done: Promise<ServiceChildResult> } {
  const shell = opts.shell ?? loginShell()
  const wrapped = shell ? shellExecArgv(shell, [process.execPath, entry, ...argv]) : undefined
  if (!wrapped) {
    // No usable login shell on this host — direct spawn, nothing to watchdog.
    const direct = spawnDaemon(entry, argv, extraEnv)
    return { child: direct.child, done: direct.done.then((r) => ({ ...r, ready: true })) }
  }

  const child = spawn(wrapped[0]!, wrapped.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  })

  let ready = false
  const lockFile = daemonLockPath(root)
  const clear = (): void => {
    clearInterval(poll)
    clearTimeout(deadline)
  }
  const poll = setInterval(() => {
    try {
      if (Number.parseInt(readFileSync(lockFile, 'utf8').trim(), 10) === child.pid) {
        ready = true
        clear()
      }
    } catch {
      // lock not written yet — keep polling
    }
  }, opts.pollMs ?? POLL_MS)
  const deadline = setTimeout(() => {
    clearInterval(poll)
    console.error(
      `agentconnect: daemon did not come up within ${Math.round((opts.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000)}s ` +
        `of a login-shell launch via ${shell} — a shell profile is likely hanging or exec-ing another program; killing it`
    )
    // SIGKILL: whatever the shell turned into (tmux, a stuck profile) may
    // ignore SIGTERM, and pid is still the direct child either way.
    child.kill('SIGKILL')
  }, opts.readyTimeoutMs ?? READY_TIMEOUT_MS)

  const done = new Promise<ServiceChildResult>((resolve) => {
    child.on('exit', (code, signal) => {
      clear()
      resolve({ code, signal, ready })
    })
    child.on('error', (err) => {
      clear()
      console.error(`agentconnect: failed to launch login shell ${shell}: ${(err as Error).message}`)
      resolve({ code: 1, signal: null, ready })
    })
  })
  return { child, done }
}
