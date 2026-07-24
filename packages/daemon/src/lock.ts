import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { lockPath } from './paths.js'

/**
 * Thrown when a foreground daemon is started while another live daemon already
 * holds the per-root lock. Two daemons sharing one Slack app token each open a
 * Socket Mode connection; Slack round-robins events across connections (it does
 * not broadcast), so each instance receives only a fraction of messages and the
 * rest appear silently dropped — no error, no log on the instance you're watching.
 */
export class DaemonAlreadyRunningError extends Error {
  constructor(
    readonly pid: number,
    readonly lockFile: string
  ) {
    super(
      `another agentconnect daemon is already running (pid ${pid}; lock ${lockFile}). ` +
        `Stop it first — two daemons sharing one Slack app token split Socket Mode ` +
        `events between them, so messages appear to be silently dropped.`
    )
    this.name = 'DaemonAlreadyRunningError'
  }
}

export interface DaemonLock {
  release(): void
}

/** True if a process with `pid` exists. EPERM ⇒ it exists but is owned by another user. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Best-effort single-instance guard for the foreground daemon, keyed by `root`.
 * A lock file holding a live pid blocks (throws DaemonAlreadyRunningError); a
 * stale lock (dead pid, garbage, or absent) is reclaimed. `release()` removes the
 * file only if we still own it. There is a small TOCTOU window — this guards
 * against accidental double-starts (the launchd service + a manual `run`), not a
 * determined concurrent race.
 *
 * Scoped per-root, not per-app-token: the common collision is two daemons sharing
 * one `~/.agentconnect`. Distinct roots that happen to carry the same token would
 * still collide on Slack but not here.
 */
export function acquireSingletonLock(root: string, deps: { pid?: number } = {}): DaemonLock {
  const file = lockPath(root)
  const myPid = deps.pid ?? process.pid
  try {
    const prev = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
    if (Number.isInteger(prev) && prev !== myPid && pidAlive(prev)) {
      throw new DaemonAlreadyRunningError(prev, file)
    }
  } catch (err) {
    if (err instanceof DaemonAlreadyRunningError) throw err
    // ENOENT / unreadable / unparseable → no live holder, reclaim below.
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${myPid}\n`, 'utf8')

  let released = false
  return {
    release() {
      if (released) return
      released = true
      try {
        if (Number.parseInt(readFileSync(file, 'utf8').trim(), 10) === myPid) unlinkSync(file)
      } catch {
        // already removed, or no longer ours — nothing to do.
      }
    }
  }
}
