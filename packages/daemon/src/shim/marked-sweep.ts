import { readdir, readFile } from 'node:fs/promises'
import { SHIM_RUNTIME_MARK_ENV } from './protocol.js'

/** SIGKILL every process of this user whose environment carries exactly this mark; returns how many it signalled. */
// For crashes, not containment: runtimes lead their own groups, so a dead shim's group signal cannot reach them.
// A process that clears its environment and re-parents escapes, as it does from the daemon's own unsandboxed launch (architecture.md §9.1).
export async function sweepMarked(mark: string): Promise<number> {
  const entry = `${SHIM_RUNTIME_MARK_ENV}=${mark}`
  let killed = 0
  for (const name of await readdir('/proc').catch(() => [])) {
    const pid = Number(name)
    if (!Number.isInteger(pid) || pid === process.pid) continue
    try {
      // Read at kill time, so a recycled pid is never signalled; another user's process is unreadable and skipped.
      const environ = await readFile(`/proc/${pid}/environ`, 'latin1')
      if (!environ.split('\0').includes(entry)) continue
      // Field 5 of stat, counted after the parenthesised command, is the process group.
      const stat = await readFile(`/proc/${pid}/stat`, 'latin1')
      const pgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2])
      process.kill(pgid === pid ? -pid : pid, 'SIGKILL')
      killed++
    } catch {
      /* gone, or not ours to read */
    }
  }
  return killed
}

/** Sweep until a pass finds nothing: a match may have forked between the scan and its kill. */
export async function sweepMarkedUntilClear(mark: string): Promise<void> {
  for (let pass = 0; pass < 5 && (await sweepMarked(mark)) > 0; pass++);
}
