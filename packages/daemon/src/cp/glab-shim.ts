// The `glab` wrapper text (gitlab-com-integration.md §13.3), the gh wrapper's GitLab twin.
// glab reads a STATIC GITLAB_TOKEN fixed at spawn and has no credential-helper hook, so the wrapper
// goes first on PATH. Thin on purpose: locate the real glab, forward the whole argv to the token
// command, exec glab with what it printed. Which project that token names is decided by
// `cp/glab-target.ts` on the Node side — sh must not parse glab argv. A user-supplied GITLAB_TOKEN
// always wins (the documented GH_TOKEN pass-through precedent), and when no token can be served the
// wrapper runs the real glab untouched. Secret-free (paths + agent id only).
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Single-quote a value for sh, escaping any quote it carries. */
const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`

export interface GlabWrapperSpec {
  /** The wrapper's own directory, skipped while it locates the real glab. */
  selfDir: string
  /** Command line printing a fresh READ token for THIS invocation; receives the agent's glab argv as `"$@"`. */
  tokenCommand: string
}

/** The wrapper script itself — ONE generator, so no second copy can drift. */
export function renderGlabWrapper({ selfDir, tokenCommand }: GlabWrapperSpec): string {
  return `#!/bin/sh
# agentconnect glab wrapper — generated, never edited; NO secrets.
# Per-invocation read-only GITLAB_TOKEN over the daemon's credential channel (gitlab-com-integration.md §13.3).

SELF_DIR=${q(selfDir)}

# The real glab: first one on PATH outside our own bin dir.
REAL_GLAB=""
_OLDIFS=$IFS; IFS=:
for _d in $PATH; do
  [ "$_d" = "$SELF_DIR" ] && continue
  if [ -x "$_d/glab" ]; then REAL_GLAB="$_d/glab"; break; fi
done
IFS=$_OLDIFS
if [ -z "$REAL_GLAB" ]; then
  echo "agentconnect: glab is not installed on this machine" >&2
  exit 127
fi

# A user-configured GITLAB_TOKEN always wins.
if [ -n "$GITLAB_TOKEN" ]; then
  exec "$REAL_GLAB" "$@"
fi
if [ -z "$AC_AGENT_ID" ]; then
  exec "$REAL_GLAB" "$@"
fi

# Fresh READ token from the daemon; stderr passes through so the agent can read
# WHY a project was refused. Exit 2 = "not ours" (non-gitlab host) — run the
# real glab untouched.
_TOKEN=$(${tokenCommand})
_RC=$?
if [ "$_RC" -eq 2 ]; then
  exec "$REAL_GLAB" "$@"
fi
if [ -n "$_TOKEN" ]; then
  GITLAB_TOKEN="$_TOKEN" exec "$REAL_GLAB" "$@"
fi
# Daemon couldn't serve one — let glab use any of its own configured auth.
exec "$REAL_GLAB" "$@"
`
}

export function glabShimDir(root: string): string {
  return join(root, 'run', 'bin')
}

/** (Re)write `run/bin/glab` and return the bin dir to prepend to agent PATHs. */
export function writeGlabShim(root: string, cliEntry: string): string {
  const dir = glabShimDir(root)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700) // defeat a loose umask; best-effort on non-POSIX
  } catch {
    /* best-effort */
  }
  const executableEntry = existsSync(cliEntry) ? realpathSync(cliEntry) : cliEntry
  // Dev daemons run under tsx with a .ts argv[1] — route through the tsx CLI
  // (the git-credential shim precedent).
  const argv = [q(realpathSync(process.execPath))]
  if (executableEntry.endsWith('.ts')) {
    const req = createRequire(import.meta.url)
    argv.push(q(req.resolve('tsx/cli')))
  }
  argv.push(q(executableEntry))
  const body = renderGlabWrapper({
    selfDir: dir,
    tokenCommand: `AGENTCONNECT_ROOT=${q(root)} ${argv.join(' ')} glab-token "$AC_AGENT_ID" -- "$@"`
  })
  writeFileSync(join(dir, 'glab'), body, { mode: 0o755 })
  return dir
}
