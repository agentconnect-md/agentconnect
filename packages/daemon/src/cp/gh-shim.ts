// The `gh` wrapper text, shared by the daemon's `run/bin/gh` and the sandbox image's own copy (issue #457).
// gh reads a STATIC GH_TOKEN fixed at spawn and has no credential-helper hook, so the wrapper goes first on PATH.
// Thin on purpose: locate the real gh, forward the whole argv to the token command, exec gh with what it printed.
// Which repo that token names is decided by `cp/gh-target.ts` on the Node side — sh must not parse `gh api` paths.
// A user-supplied GH_TOKEN always wins; a refused repository stops here, an unreachable daemon runs the real gh untouched.
// Secret-free (paths + agent id only): tokens transit a shell variable and the exec'd env, never argv, never disk.
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Single-quote a value for sh, escaping any quote it carries. */
export const shQuote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`

export interface GhWrapperSpec {
  /** The wrapper's own directory, skipped while it locates the real gh. */
  selfDir: string
  /** Command line printing a fresh token for THIS invocation; it receives the agent's gh argv as `"$@"`. */
  tokenCommand: string
}

/** The wrapper script itself — ONE generator, so the daemon's copy and the runtime image's cannot drift. */
export function renderGhWrapper({ selfDir, tokenCommand }: GhWrapperSpec): string {
  return `#!/bin/sh
# agentconnect gh wrapper — generated, never edited; NO secrets.
# Per-repo, per-invocation GH_TOKEN over the daemon's credential channel (issue #457).

SELF_DIR=${shQuote(selfDir)}

# The real gh: first one on PATH outside our own bin dir.
REAL_GH=""
_OLDIFS=$IFS; IFS=:
for _d in $PATH; do
  [ "$_d" = "$SELF_DIR" ] && continue
  if [ -x "$_d/gh" ]; then REAL_GH="$_d/gh"; break; fi
done
IFS=$_OLDIFS
if [ -z "$REAL_GH" ]; then
  echo "agentconnect: gh is not installed on this machine" >&2
  exit 127
fi

# A user-configured GH_TOKEN always wins.
if [ -n "$GH_TOKEN" ]; then
  exec "$REAL_GH" "$@"
fi
if [ -z "$AC_AGENT_ID" ]; then
  exec "$REAL_GH" "$@"
fi

# Fresh token from the daemon; it resolves the target repo from the argv forwarded below
# (stdout = token only; stderr passes through so the agent can read WHY a repo was refused).
# Exit 2 = "not ours" (non-github host) — run the real gh untouched.
# Exit 3 = refused — stop, since gh without a token would only add "not logged in" advice to the reason.
_TOKEN=$(${tokenCommand})
_RC=$?
if [ "$_RC" -eq 2 ]; then
  exec "$REAL_GH" "$@"
fi
if [ "$_RC" -eq 3 ]; then
  exit 1
fi
if [ -n "$_TOKEN" ]; then
  GH_TOKEN="$_TOKEN" exec "$REAL_GH" "$@"
fi
# Daemon couldn't serve one — let gh use any of its own configured auth.
exec "$REAL_GH" "$@"
`
}

/** The `agentconnect-secrets` wrapper (capability-requests.md §4.9.2): it holds no policy and no secret, only where the helper lives. */
export function renderSecretsWrapper(command: string): string {
  return `#!/bin/sh
# agentconnect live secrets — generated, never edited; NO secrets.
exec ${command} "$@"
`
}

/** The wrapper's file name, on every PATH it is put on. */
export const SECRETS_WRAPPER_NAME = 'agentconnect-secrets'

export function ghShimDir(root: string): string {
  return join(root, 'run', 'bin')
}

/** The live secrets wrapper's own dir, apart from the token wrappers so a proxied session keeps it without them. */
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

/** (Re)write `run/bin/gh`, and return the bin dir to prepend to agent PATHs. */
export function writeGhShim(root: string, cliEntry: string): string {
  const dir = ghShimDir(root)
  makeShimDir(dir)
  const body = renderGhWrapper({
    selfDir: dir,
    tokenCommand: `AGENTCONNECT_ROOT=${shQuote(root)} ${daemonCliArgv(cliEntry)} gh-token "$AC_AGENT_ID" -- "$@"`
  })
  writeFileSync(join(dir, 'gh'), body, { mode: 0o755 })
  return dir
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
