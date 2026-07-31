/**
 * run/bin/gh — the gh wrapper shim (agent-multi-repo-authorization.md decision
 * 4, issue #457).
 *
 * `gh` has no credential-helper hook: it reads a STATIC `GH_TOKEN` fixed at
 * process spawn, which is why P2.5's injected token went stale after ≤1h and
 * could only ever name the workspace repo. The daemon prepends `run/bin` to
 * the agent runtime's PATH so every `gh …` the agent runs lands here first;
 * the wrapper resolves the TARGET repo (explicit argv → GH_REPO → cwd origin),
 * pulls that repo's fresh token through gitcred.sock (`agentconnect gh-token`,
 * same socket + cache as the git credential helper) and exec's the real gh
 * with GH_TOKEN set. Per-invocation fresh + per-repo correct.
 *
 * Precedence: a USER-supplied GH_TOKEN must win, so the wrapper defers whenever
 * one is already set. AgentConnect tokens are fetched only for this invocation;
 * they are no longer injected into the long-lived ACP runtime environment.
 * When the daemon can't serve a token (repo unauthorized, CP down) the wrapper
 * prints the daemon's actionable reason and runs the real gh without one.
 *
 * The script is SECRET-FREE (paths + agent id only) and regenerated every
 * daemon boot, like `git-credential-helper.sh`. Tokens transit a shell
 * variable and the exec'd process env — never argv, never disk.
 */
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

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
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  const executableEntry = existsSync(cliEntry) ? realpathSync(cliEntry) : cliEntry
  // Dev daemons run under tsx with a .ts argv[1] — route through the tsx CLI
  // (the git-credential shim precedent; plain `node entry.ts` dies on
  // .js-suffixed imports).
  const argv = [q(realpathSync(process.execPath))]
  if (executableEntry.endsWith('.ts')) {
    const req = createRequire(import.meta.url)
    argv.push(q(req.resolve('tsx/cli')))
  }
  argv.push(q(executableEntry))
  const cli = argv.join(' ')
  const body = `#!/bin/sh
# agentconnect gh wrapper — regenerated on daemon start; NO secrets.
# Per-repo, per-invocation GH_TOKEN via the daemon socket (issue #457).

SELF_DIR=${q(dir)}

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

# Target repo: -R/--repo argv (all spellings, last wins — matches gh's pflag),
# then a canonical positional repo on gh repo commands that target an existing
# repository, GH_REPO env, and finally the cwd origin remote. Do not scan every
# slash-bearing argument: jq/templates and read-file paths can look repo-like.
_REPO=""
_prev=""
for _a in "$@"; do
  case "$_prev" in
    -R|--repo) _REPO="$_a" ;;
  esac
  case "$_a" in
    --repo=*) _REPO="\${_a#--repo=}" ;;
    -R=*) _REPO="\${_a#-R=}" ;;
    -R?*) _REPO="\${_a#-R}" ;;
  esac
  _prev="$_a"
done
if [ -z "$_REPO" ]; then
  case "\${1-}:\${2-}" in
    repo:archive|repo:clone|repo:delete|repo:edit|repo:fork|repo:set-default|repo:sync|repo:unarchive|repo:view)
      _REPO_COMMAND="\${2-}"
      ;;
  esac
fi
if [ -z "$_REPO" ] && [ -n "$_REPO_COMMAND" ]; then
  _arg_index=0
  _skip_value=""
  for _a in "$@"; do
    _arg_index=$((_arg_index + 1))
    [ "$_arg_index" -le 2 ] && continue
    if [ -n "$_skip_value" ]; then
      _skip_value=""
      continue
    fi
    [ "$_a" = "--" ] && break
    case "$_REPO_COMMAND:$_a" in
      clone:-u|clone:--upstream-remote-name|edit:--add-topic|edit:--default-branch|edit:-d|edit:--description|edit:-h|edit:--homepage|edit:--remove-topic|edit:--squash-merge-commit-message|edit:--visibility|fork:--fork-name|fork:--org|fork:--remote-name|sync:-b|sync:--branch|sync:-s|sync:--source|view:-b|view:--branch|view:-q|view:--jq|view:--json|view:-t|view:--template)
        _skip_value=1
        continue
        ;;
    esac
    case "$_a" in
      --*=*|-*) continue ;;
    esac
    case "$_a" in
      */*) _REPO="$_a" ;;
    esac
    break
  done
fi
if [ -z "$_REPO" ]; then _REPO="$GH_REPO"; fi
if [ -z "$_REPO" ]; then
  _REPO=$(git remote get-url origin 2>/dev/null || true)
fi

# Fresh token from the daemon (stdout = token only; stderr passes through so
# the agent can read WHY a repo was refused). Exit 2 = "not ours" (non-github
# host) — run the real gh untouched.
_TOKEN=$(AGENTCONNECT_ROOT=${q(root)} ${cli} gh-token "$AC_AGENT_ID" "$_REPO")
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
  writeFileSync(join(dir, 'gh'), body, { mode: 0o755 })
  return dir
}
