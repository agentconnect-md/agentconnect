// The `gh` wrapper text, shared by the daemon's `run/bin/gh` and the sandbox image's own copy (issue #457).
// gh reads a STATIC GH_TOKEN fixed at spawn and has no credential-helper hook, so the wrapper goes first on PATH.
// Thin on purpose: locate the real gh, forward the whole argv to the token command, exec gh with what it printed.
// Which repo that token names is decided by `cp/gh-target.ts` on the Node side — sh must not parse `gh api` paths.
// A user-supplied GH_TOKEN always wins, and when no token can be served the wrapper runs the real gh untouched.
// Secret-free (paths + agent id only): tokens transit a shell variable and the exec'd env, never argv, never disk.
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Single-quote a value for sh, escaping any quote it carries. */
const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`

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

SELF_DIR=${q(selfDir)}

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
_TOKEN=$(${tokenCommand})
_RC=$?
if [ "$_RC" -eq 2 ]; then
  exec "$REAL_GH" "$@"
fi
if [ -n "$_TOKEN" ]; then
  GH_TOKEN="$_TOKEN" exec "$REAL_GH" "$@"
fi
# Daemon couldn't serve one — let gh use any of its own configured auth.
exec "$REAL_GH" "$@"
`
}

export function ghShimDir(root: string): string {
  return join(root, 'run', 'bin')
}

/** (Re)write `run/bin/gh` and return the bin dir to prepend to agent PATHs. */
export function writeGhShim(root: string, cliEntry: string): string {
  const dir = ghShimDir(root)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700) // defeat a loose umask; best-effort on non-POSIX
  } catch {
    /* best-effort */
  }
  const executableEntry = existsSync(cliEntry) ? realpathSync(cliEntry) : cliEntry
  // Dev daemons run under tsx with a .ts argv[1] — route through the tsx CLI (the git-credential shim
  // precedent; plain `node entry.ts` dies on .js-suffixed imports).
  const argv = [q(realpathSync(process.execPath))]
  if (executableEntry.endsWith('.ts')) {
    const req = createRequire(import.meta.url)
    argv.push(q(req.resolve('tsx/cli')))
  }
  argv.push(q(executableEntry))
  const body = renderGhWrapper({
    selfDir: dir,
    tokenCommand: `AGENTCONNECT_ROOT=${q(root)} ${argv.join(' ')} gh-token "$AC_AGENT_ID" -- "$@"`
  })
  writeFileSync(join(dir, 'gh'), body, { mode: 0o755 })
  return dir
}
