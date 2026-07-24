/**
 * Root-scoped inter-process writer lock for the version store (cli-daemon-split.md
 * §5.5). Every MUTATING version command (install / use / prune / upgrade), whether
 * a local invocation or the CLI a daemon spawns for a remote upgrade, holds this
 * lock across its whole transaction so they can't corrupt `current` /
 * `versions.json` by interleaving.
 *
 * Distinct from the daemon singleton lock (packages/daemon/src/lock.ts): that one
 * is held by a running daemon (and is held during a remote upgrade), whereas this
 * guards the version store — different resources, different locks.
 *
 * Stale recovery: holder LIVENESS is the only preemption criterion — never lock
 * age. `kill(pid, 0)` → ESRCH means dead; any other errno means alive. A recorded
 * process start time guards against PID reuse (a live PID whose start time no
 * longer matches is a different process, so the lock is stale).
 */
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { versionsLockPath } from './paths.js'

interface LockContent {
  pid: number
  op: string
  startedAt: string
  /** Holder's process start time (`ps -o lstart=`); '' if unavailable. */
  procStart: string
}

/** Best-effort process start time, to distinguish a reused PID. Empty on failure. */
function procStartTime(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/** True if the PID is a live process. ESRCH ⇒ dead; EPERM/other ⇒ alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** A held lock is stale (safe to preempt) only if its holder process is gone or
 *  its PID has been reused by a different process. */
function isStale(holder: LockContent): boolean {
  if (!isAlive(holder.pid)) return true
  // PID is alive — only a start-time MISMATCH proves reuse. If either side's
  // start time is unknown, err on the side of NOT preempting a live process.
  const now = procStartTime(holder.pid)
  if (holder.procStart && now && holder.procStart !== now) return true
  return false
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const POLL_MS = 500
const DEFAULT_WAIT_MS = 15 * 60_000 // generous: a slow install/download can legitimately hold it
const STALE_WARN_MS = 30 * 60_000

function tryClaim(path: string, op: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx') // O_CREAT | O_EXCL — atomic
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  const content: LockContent = {
    pid: process.pid,
    op,
    startedAt: new Date().toISOString(),
    procStart: procStartTime(process.pid)
  }
  try {
    writeSync(fd, JSON.stringify(content))
  } finally {
    closeSync(fd)
  }
  return true
}

function readHolder(path: string): LockContent | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockContent>
    if (typeof raw.pid !== 'number') return null
    return {
      pid: raw.pid,
      op: typeof raw.op === 'string' ? raw.op : 'unknown',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      procStart: typeof raw.procStart === 'string' ? raw.procStart : ''
    }
  } catch {
    return null // corrupt/partial lock ⇒ treat as reclaimable
  }
}

/** Atomically move a stale lock aside so a fresh claim can be made. Racing
 *  preemptors are fine: the rename or the subsequent O_EXCL claim decides one winner. */
function preempt(path: string): void {
  try {
    renameSync(path, `${path}.stale`)
  } catch {
    // already moved/removed by a racing preemptor — fine
  }
}

/**
 * Run `fn` while holding the version-store lock. `wait: true` blocks (polling)
 * until the lock frees or `waitMs` elapses; `wait: false` fails fast if a live
 * process holds it. The lock is always released if we own it.
 */
export async function withVersionLock<T>(
  root: string,
  op: string,
  fn: () => Promise<T> | T,
  opts: { wait?: boolean; waitMs?: number } = {}
): Promise<T> {
  const path = versionsLockPath(root)
  const wait = opts.wait ?? false
  const deadline = Date.now() + (opts.waitMs ?? DEFAULT_WAIT_MS)
  let warned = false

  for (;;) {
    if (tryClaim(path, op)) break

    const holder = readHolder(path)
    if (!holder || isStale(holder)) {
      preempt(path)
      continue
    }

    // Held by a live process.
    if (!wait) {
      throw new Error(
        `another version operation is in progress (pid ${holder.pid}, op ${holder.op}, since ${holder.startedAt}) — retry once it finishes`
      )
    }
    if (!warned && Date.now() - new Date(holder.startedAt).getTime() > STALE_WARN_MS) {
      console.error(`agentconnect: waiting on a long-running version lock (pid ${holder.pid}, op ${holder.op})`)
      warned = true
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the version lock held by pid ${holder.pid} (op ${holder.op})`)
    }
    await delay(POLL_MS)
  }

  try {
    return await fn()
  } finally {
    // Release only if the lock is still ours (a preemptor may have taken over if
    // we were wrongly judged dead — never delete someone else's lock).
    const holder = readHolder(path)
    if (holder?.pid === process.pid) {
      try {
        unlinkSync(path)
      } catch {
        // already gone — fine
      }
    }
  }
}
