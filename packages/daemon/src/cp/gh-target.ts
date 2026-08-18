/**
 * Target-repo resolution for the `run/bin/gh` wrapper (agent-multi-repo-authorization.md
 * decision 4, issue #457).
 *
 * The generated sh wrapper only locates the real `gh` and forwards argv; picking the repo
 * whose installation token must be minted happens HERE, as a pure function the hidden
 * `gh-token` CLI calls. Resolution order matches gh's own flag > command > environment >
 * current checkout precedence: the last `-R/--repo`, then the target the command already
 * names (a `gh repo <sub>` positional, the `gh api` endpoint path, a pull/issue URL),
 * then `GH_REPO`, then the cwd origin remote. Nothing left ⇒ the workspace token.
 */
import { gitRepoLabel } from '@agentconnect.md/protocol'

// `gh repo` subcommands whose first positional names an EXISTING repository.
const REPO_SUBCOMMANDS = new Set([
  'archive',
  'clone',
  'delete',
  'edit',
  'fork',
  'set-default',
  'sync',
  'unarchive',
  'view'
])

// Per-subcommand flags that consume the next argv entry, so it is a value and not the repo positional.
const REPO_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  clone: new Set(['-u', '--upstream-remote-name']),
  edit: new Set([
    '--add-topic',
    '--default-branch',
    '-d',
    '--description',
    '-h',
    '--homepage',
    '--remove-topic',
    '--squash-merge-commit-message',
    '--visibility'
  ]),
  fork: new Set(['--fork-name', '--org', '--remote-name']),
  sync: new Set(['-b', '--branch', '-s', '--source']),
  view: new Set(['-b', '--branch', '-q', '--jq', '--json', '-t', '--template'])
}

// `gh api` flags that consume the next argv entry; every other flag there is a boolean.
const API_VALUE_FLAGS = new Set([
  '-X',
  '--method',
  '-H',
  '--header',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--input',
  '--cache',
  '--hostname',
  '-p',
  '--preview'
])

// A pull/issue web URL pins the repository as firmly as `-R` does.
const HTML_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/\d+/

// `gh pr`/`gh issue` flags whose value can itself be a URL — one there is body text, not the selector.
const PR_ISSUE_VALUE_FLAGS = new Set(['-b', '--body', '-F', '--body-file', '-t', '--title', '--subject'])

/** Resolve the repo a `gh` invocation targets; `cwdOrigin` is called only if nothing earlier answers. */
export function resolveGhTargetRepo(
  argv: readonly string[],
  env: { GH_REPO?: string },
  cwdOrigin: () => string | undefined
): { repo?: string; defer?: boolean } {
  const candidate = flagRepo(argv) ?? commandRepo(argv) ?? nonEmpty(env.GH_REPO) ?? cwdOrigin()
  return normalizeRepoArg(candidate)
}

/**
 * Normalize a raw repo candidate. gh accepts `OWNER/REPO`, `HOST/OWNER/REPO` and full URLs
 * for `-R`/`GH_REPO`; the cwd fallback hands us whatever `git remote get-url origin` prints.
 * Unparseable ⇒ workspace token (repo undefined); a clearly non-github.com target ⇒ defer
 * (the wrapper runs the real gh untouched — `gitRepoLabel` strips ANY host, so the
 * github.com assertion lives here).
 */
export function normalizeRepoArg(raw?: string): { repo?: string; defer?: boolean } {
  const s = raw?.trim()
  if (!s) return {}
  // Bare OWNER/REPO (no host, no scheme).
  if (/^[^/\s:@]+\/[^/\s:@]+$/.test(s)) return { repo: s.replace(/\.git$/i, '') }
  // Full URL (https://git.example.com/…) or scp form (git@git.example.com:…).
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+)/i.exec(s)?.[1] ?? /^[\w.-]+@([\w.-]+):/.exec(s)?.[1]
  if (host) {
    if (host.toLowerCase() !== 'github.com') return { defer: true }
    const segs = gitRepoLabel(s).split('/')
    return segs.length >= 2 && segs[0] && segs[1] ? { repo: `${segs[0]}/${segs[1]}` } : {}
  }
  // HOST/OWNER/REPO plain form (gh's own shape).
  const segs = s.split('/')
  if (segs.length === 3 && segs[0]!.includes('.')) {
    if (segs[0]!.toLowerCase() !== 'github.com') return { defer: true }
    return { repo: `${segs[1]}/${segs[2]!.replace(/\.git$/i, '')}` }
  }
  return {}
}

function nonEmpty(v?: string): string | undefined {
  return v && v.trim() ? v : undefined
}

/** Last `-R`/`--repo` wins, matching gh's pflag; all four spellings are accepted. */
function flagRepo(argv: readonly string[]): string | undefined {
  let repo = ''
  let prev = ''
  for (const a of argv) {
    if (prev === '-R' || prev === '--repo') repo = a
    if (a.startsWith('--repo=')) repo = a.slice('--repo='.length)
    else if (a.startsWith('-R=')) repo = a.slice('-R='.length)
    else if (a.startsWith('-R') && a.length > 2) repo = a.slice('-R'.length)
    prev = a
  }
  return nonEmpty(repo)
}

/** The target the command already carries: a repo positional, the `api` endpoint, or a pull/issue URL. */
function commandRepo(argv: readonly string[]): string | undefined {
  const [cmd, sub] = argv
  if (cmd === 'repo' && sub && REPO_SUBCOMMANDS.has(sub)) return repoPositional(argv, sub)
  if (cmd === 'api') return apiEndpointRepo(argv)
  if ((cmd === 'pr' || cmd === 'issue') && sub) return htmlUrlRepo(argv)
  return undefined
}

/** First positional of a `gh repo <sub>` command — only a slash-bearing one names a repository. */
function repoPositional(argv: readonly string[], sub: string): string | undefined {
  const valueFlags = REPO_VALUE_FLAGS[sub]
  let skipValue = false
  for (const a of argv.slice(2)) {
    if (skipValue) {
      skipValue = false
      continue
    }
    if (a === '--') break
    if (valueFlags?.has(a)) {
      skipValue = true
      continue
    }
    if (a.startsWith('-')) continue
    return a.includes('/') ? a : undefined
  }
  return undefined
}

/** `gh api repos/{owner}/{repo}/…` names the repo in the endpoint itself — the 404 this fix exists for. */
function apiEndpointRepo(argv: readonly string[]): string | undefined {
  const endpoint = apiEndpoint(argv)
  if (!endpoint) return undefined
  let path = endpoint
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    const onApi = /^https?:\/\/api\.github\.com\/?(.*)$/i.exec(path)
    if (!onApi) return path // another host — normalizeRepoArg defers
    path = onApi[1]!
  }
  path = path.replace(/[?#].*$/, '').replace(/^\/+/, '')
  const seg = /^repos\/([^/]+)\/([^/]+)(?:\/|$)/.exec(path)
  if (!seg) return undefined // graphql, /user, /orgs/… — gh's own default applies
  const [, owner, repo] = seg
  // gh's `{owner}`/`{repo}` placeholders resolve from ITS default; leave them to the later layers.
  if (owner!.includes('{') || repo!.includes('{')) return undefined
  return `${owner}/${repo}`
}

/** First positional after `api`, skipping the flags that consume a value. */
function apiEndpoint(argv: readonly string[]): string | undefined {
  let skipValue = false
  let endOfFlags = false
  for (const a of argv.slice(1)) {
    if (skipValue) {
      skipValue = false
      continue
    }
    if (!endOfFlags && a.startsWith('-') && a !== '-') {
      if (a === '--') {
        endOfFlags = true
        continue
      }
      if (a.includes('=')) continue // `--flag=value` / `-X=value` are self-contained
      if (API_VALUE_FLAGS.has(a)) {
        skipValue = true
        continue
      }
      continue // `-Xvalue` is self-contained; anything else is a boolean
    }
    return a
  }
  return undefined
}

/** The pull/issue URL the command selects; a URL handed to a body/title flag is text, not a target. */
function htmlUrlRepo(argv: readonly string[]): string | undefined {
  let skipValue = false
  for (const a of argv.slice(2)) {
    if (skipValue) {
      skipValue = false
      continue
    }
    if (PR_ISSUE_VALUE_FLAGS.has(a)) {
      skipValue = true
      continue
    }
    if (HTML_URL_RE.test(a)) return a
  }
  return undefined
}
