/**
 * `<root>/cli-entry` self-heal — written on EVERY invocation so a service or
 * foreground daemon can locate this CLI to run an upgrade even when its PATH omits
 * npm's global bin (cli-daemon-split.md §3).
 *
 * Lives outside `index.ts` because that module executes `main()` on import; keeping
 * it here makes the root's permission handling directly testable.
 */
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { cliEntryPath } from './paths.js'

/**
 * Narrow an ALREADY-EXISTING root to 0700. `mkdirSync`'s `mode` applies only on
 * creation, so a root laid down earlier at 0755 — by an older CLI, a container image
 * build, or systemd `StateDirectory=` — has to be repaired rather than merely created
 * correctly. Mirrors `login.ts:protectCredentialsFile`, including leaving win32 alone
 * (no enforceable POSIX mode semantics there).
 */
export function protectRootDir(dir: string): void {
  if (process.platform === 'win32') return
  try {
    if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
  } catch {
    // best-effort: a root we cannot stat/chmod is not a reason to fail the command
  }
}

/**
 * Write `<root>/cli-entry` pointing at `entryPath`. Best-effort — the pointer is a
 * convenience for the daemon→CLI handoff, not a precondition for the command.
 *
 * This normally CREATES `<root>`, since it runs before anything else. With the
 * default umask that landed at 0755, while every other creator of the same directory
 * passes 0o700 (`login.ts`, the daemon's `config/load-config.ts`) — so the loose mode
 * is the one that persisted, leaving the transcript store and daemon logs beneath it
 * traversable by any other local user.
 */
export function selfHealCliEntry(root: string, entryPath: string): void {
  try {
    const p = cliEntryPath(root)
    const dir = dirname(p)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    protectRootDir(dir)
    writeFileSync(p, entryPath + '\n')
  } catch {
    // non-fatal: the pointer is a convenience for daemon→CLI handoff
  }
}
