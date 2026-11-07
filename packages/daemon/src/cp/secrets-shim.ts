// The `agentconnect-secrets` wrapper the daemon writes for its runtimes; secret-free (paths only).
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Single-quote a value for sh, escaping any quote it carries. */
export const shQuote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`

/** The `agentconnect-secrets` wrapper (capability-requests.md §4.9.2): it holds no policy and no secret, only where the helper lives. */
export function renderSecretsWrapper(command: string): string {
  return `#!/bin/sh
# agentconnect live secrets — generated, never edited; NO secrets.
exec ${command} "$@"
`
}

/** The wrapper's file name, on every PATH it is put on. */
export const SECRETS_WRAPPER_NAME = 'agentconnect-secrets'

/** The live secrets wrapper's own dir. */
export function secretsShimDir(root: string): string {
  return join(root, 'run', 'secrets-bin')
}

/** A wrapper dir private to this user. */
function makeShimDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700) // defeat a loose umask; best-effort on non-POSIX
  } catch {
    /* best-effort */
  }
}

/** The daemon CLI a wrapper runs, through tsx for a dev daemon's `.ts` entry (plain `node entry.ts` dies on `.js` imports). */
function daemonCliArgv(cliEntry: string): string {
  const executableEntry = existsSync(cliEntry) ? realpathSync(cliEntry) : cliEntry
  const argv = [shQuote(realpathSync(process.execPath))]
  if (executableEntry.endsWith('.ts')) {
    const req = createRequire(import.meta.url)
    argv.push(shQuote(req.resolve('tsx/cli')))
  }
  argv.push(shQuote(executableEntry))
  return argv.join(' ')
}

/** (Re)write `run/secrets-bin/agentconnect-secrets`, and return its dir to prepend to agent PATHs. */
export function writeSecretsShim(root: string, cliEntry: string): string {
  const dir = secretsShimDir(root)
  makeShimDir(dir)
  writeFileSync(
    join(dir, SECRETS_WRAPPER_NAME),
    renderSecretsWrapper(`env AGENTCONNECT_ROOT=${shQuote(root)} ${daemonCliArgv(cliEntry)} secrets`),
    { mode: 0o755 }
  )
  return dir
}
