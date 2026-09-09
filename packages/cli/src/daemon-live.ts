/**
 * Is a daemon still executing a bundle out of this root? `<root>/daemon.lock`
 * holds the live daemon's pid (paths.ts); node resolves `current` to the real
 * `versions/<v>` path at load time, so a running daemon keeps needing the files
 * of whatever version it was LAUNCHED under — not whatever `current` points at
 * now. Automatic cleanup consults this before it may delete an in-use bundle.
 */
import { readFileSync } from 'node:fs'
import { daemonLockPath } from './paths.js'

/** The pid recorded in the daemon lock, or null when it is missing/unreadable/garbage. */
export function daemonLockPid(root: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(daemonLockPath(root), 'utf8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** The live daemon's pid, or null when no live daemon owns this root. ESRCH ⇒ dead; EPERM/other ⇒ alive. */
export function liveDaemonPid(root: string): number | null {
  const pid = daemonLockPid(root)
  if (pid === null) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH' ? null : pid
  }
}
