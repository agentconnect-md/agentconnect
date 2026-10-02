import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isRuntimeHomeSeedFile } from './runtime-home.js'

/** What can hold a secret in a runtime's private state directory, beyond the top-level files seeded from the host. */
export const CODEX_STATE_SECRETS = ['auth.json', 'config.toml'] as const
export const CLAUDE_STATE_SECRETS = ['.credentials.json', 'backups'] as const

/** Directories among those secrets the runtime creates later: made now, so they are denied from the first launch. */
const LATER_SECRET_DIRS = new Set(['backups'])

export interface PrivateRuntimeState {
  /** The directory itself: read-only to the model's tools, which read back and run what the runtime put there. */
  readOnly: string[]
  /** What is denied outright: the seeded top-level files, the credential links, and copies of them. */
  secret: string[]
}

/**
 * Split a runtime's private state directory (a session HOME's `.codex` or `.claude`) for the model's own tools.
 * Denying it whole also denies what the runtime itself stores there for those tools — Codex's linux-sandbox
 * helper, which it execs through its own sandbox; Claude's saved tool results and synced skills — so the directory
 * is read-only instead, and only what can hold a secret is denied: every top-level file seeded from the host
 * (the same `isRuntimeHomeSeedFile` rule that copied it), and the named credential surfaces.
 */
export function privateRuntimeState(dir: string, secretNames: readonly string[]): PrivateRuntimeState {
  if (!existsSync(dir)) return { readOnly: [], secret: [] }
  const root = realpathSync(dir)
  for (const name of secretNames) {
    if (LATER_SECRET_DIRS.has(name)) mkdirSync(join(root, name), { recursive: true, mode: 0o700 })
  }
  const secret = new Set<string>()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if ((!entry.isDirectory() && isRuntimeHomeSeedFile(entry.name)) || secretNames.includes(entry.name)) {
      secret.add(deniablePath(join(root, entry.name)))
    }
  }
  return { readOnly: [root], secret: [...secret] }
}

/** A credential link is denied at the shared host file it points at, which may not exist yet. Not at the link:
 * it sits under the writable HOME, and a sandbox that masks a path refuses one crossing a symlink the sandboxed
 * process could swap (Codex's `cannot enforce sandbox deny-read path … crosses writable symlink`); the read-only
 * state directory keeps the link itself from changing, and reading through it reaches the denied target. */
function deniablePath(path: string): string {
  if (!lstatSync(path).isSymbolicLink()) return path
  try {
    return realpathSync(path)
  } catch {
    return resolve(dirname(path), readlinkSync(path))
  }
}
