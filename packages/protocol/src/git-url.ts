/**
 * Git repo address helpers, shared by the CP (normalize on write) and the
 * daemon (defensive normalize before clone).
 *
 * STORAGE INVARIANT: `workspace.gitRepo` is persisted as a FULL cloneable git
 * address (e.g. `https://github.com/acme/infra`), never the `acme/infra`
 * shorthand a user may type. UIs shorten it back to `org/repo` for display
 * with `gitRepoLabel`.
 */

import { WORKSPACE_GIT_ORIGINS_ENV } from './consts.js'

/** Scheme-full address: https://, ssh://, git://, file://, … */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i
/** Any URI scheme, including non-hierarchical forms such as `ext::…`. */
const ANY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
/** scp-like ssh address: git@github.com:acme/infra(.git) */
const SCP_RE = /^[\w.-]+@[\w.-]+:(.+)$/
const SCP_PARTS_RE = /^([\w.-]+)@([\w.-]+):(.+)$/
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/** Conservative daemon default. Operators may explicitly add exact origins
 * for GitLab, Bitbucket, or self-managed Git services. */
// gitlab-com-integration.md §13.2: managed GitLab workspaces are HTTPS-only and
// exactly this origin. An operator-supplied allowlist stays authoritative.
export const DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS = [
  'https://github.com',
  'ssh://github.com',
  'https://gitlab.com'
] as const

/**
 * Hard cap on an untrusted repo reference. Real clone addresses are far under
 * this; the bound exists so no amount of caller-supplied text can turn
 * normalization into a long synchronous scan on the CP's single event loop.
 */
export const MAX_GIT_REPO_LENGTH = 512

export class GitCloneUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitCloneUrlError'
  }
}

/**
 * Strip trailing `/` without a backtracking regex.
 *
 * `s.replace(/\/+$/, '')` looks anchored but is not: the engine retries the
 * greedy `+` from every offset, so a long run of slashes that does NOT end the
 * string costs O(n²). These helpers run inside request validation on the
 * control plane's single-threaded event loop, where that is a stall for every
 * tenant, not just the caller.
 */
function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f /* '/' */) end--
  return end === s.length ? s : s.slice(0, end)
}

/**
 * Normalize a user-supplied repo reference into a full cloneable git address.
 * Idempotent — full addresses pass through unchanged.
 *
 * - `https://…` / `ssh://…` / `git://…` / `git@host:…` → as-is
 * - `github.com/acme/infra` (host-prefixed shorthand)  → `https://github.com/acme/infra`
 * - `acme/infra` (bare org/repo)                       → `https://github.com/acme/infra`
 * - anything else (e.g. a local path) → as-is
 */
export function normalizeGitUrl(input: string): string {
  const s = trimTrailingSlashes(input.trim())
  if (!s || SCHEME_RE.test(s) || SCP_RE.test(s)) return s
  const segments = s.split('/')
  // host-prefixed shorthand: first segment looks like a hostname (has a dot)
  if (segments.length >= 3 && segments[0]!.includes('.')) return `https://${s}`
  // bare org/repo → GitHub by default
  if (segments.length === 2 && segments.every((p) => p.length > 0)) return `https://github.com/${s}`
  return s
}

function invalidCloneUrl(message: string): never {
  throw new GitCloneUrlError(message)
}

function hasLocalPathPrefix(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('~/') ||
    /^[a-z]:[\\/]/i.test(value)
  )
}

/**
 * Normalize and validate an untrusted git clone target.
 *
 * This shared codec remains host-agnostic so the CP can store repositories for
 * different daemon deployments. Only credential-free HTTPS and SSH transports
 * are accepted; the daemon applies its operator-owned exact-origin policy at
 * the execution boundary.
 */
export function normalizeGitCloneUrl(input: string): string {
  // Bound FIRST: every check below scans the value, and this is the one entry
  // point untrusted repo text reaches. A real address is nowhere near the cap.
  if (input.length > MAX_GIT_REPO_LENGTH) invalidCloneUrl('git clone url is too long')
  if (CONTROL_RE.test(input)) invalidCloneUrl('git clone url must not contain control characters')

  const s = trimTrailingSlashes(input.trim())
  if (!s) invalidCloneUrl('git clone url must not be empty')
  if (s.startsWith('-')) invalidCloneUrl('git clone url must not start with "-"')
  if (/\s/.test(s)) invalidCloneUrl('git clone url must not contain whitespace')
  // Git and WHATWG URLs disagree about whether a backslash terminates the
  // authority. Reject it outright so validation, redaction, and Git cannot
  // select different credentials or hosts.
  if (s.includes('\\')) invalidCloneUrl('git clone url must not contain backslashes')
  if (hasLocalPathPrefix(s)) invalidCloneUrl('local git paths are not supported')

  const scp = SCP_PARTS_RE.exec(s)
  if (scp) {
    const path = scp[3]!
    if (!path || path.startsWith('-') || path.includes('?') || path.includes('#')) {
      invalidCloneUrl('invalid scp-style git clone url')
    }
    return s
  }

  // Reject ext::, file:, Windows drive-like values, and every other
  // non-hierarchical/unsupported scheme before shorthand normalization.
  if (ANY_SCHEME_RE.test(s) && !SCHEME_RE.test(s)) {
    invalidCloneUrl('git clone url must use https or ssh')
  }

  const normalized = normalizeGitUrl(s)
  if (!SCHEME_RE.test(normalized)) invalidCloneUrl('git clone url must identify a remote repository')

  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    invalidCloneUrl('git clone url must be a valid absolute URL')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
    invalidCloneUrl('git clone url must use https or ssh')
  }
  if (url.protocol === 'https:' && (url.username || url.password)) {
    invalidCloneUrl('https git clone url must not contain credentials')
  }
  if (url.protocol === 'ssh:' && url.password) {
    invalidCloneUrl('ssh git clone url must not contain a password')
  }
  if (normalized.includes('?') || normalized.includes('#')) {
    invalidCloneUrl('git clone url must not contain a query or fragment')
  }
  if (!url.hostname || !url.pathname || url.pathname === '/') {
    invalidCloneUrl('git clone url must identify a remote repository')
  }

  return normalized
}

const GITHUB_SKILL_COMPONENT_RE = /^[A-Za-z0-9_.-]+$/
const GITHUB_SKILL_DOT_SEGMENT_RE = /\/(?:\.|%2e)(?:\.|%2e)?(?:\/|$)/i

/** Normalize the deliberately narrow source vocabulary supported by the
 * daemon's bounded GitHub archive acquisition path. Unlike generic workspaces,
 * skill sources cannot name arbitrary Git servers until an equally bounded
 * transport exists for them. */
export function normalizeGitHubSkillSource(input: string): string {
  const normalized = normalizeGitCloneUrl(input)
  // WHATWG URL parsing collapses literal and percent-encoded dot segments.
  // Reject them before parsing so admission cannot silently reinterpret an
  // unsafe tree subdirectory as a different ref/path.
  if (GITHUB_SKILL_DOT_SEGMENT_RE.test(normalized)) {
    invalidCloneUrl('GitHub skill source must not contain dot path segments')
  }
  const scp = SCP_PARTS_RE.exec(normalized)
  if (scp) {
    if (scp[1] !== 'git' || scp[2]!.toLowerCase().replace(/\.+$/, '') !== 'github.com') {
      invalidCloneUrl('skill source must use GitHub')
    }
    assertGitHubSkillRepositoryPath(scp[3]!, false, false)
    return normalized
  }

  const url = new URL(normalized)
  const protocol = url.protocol
  if (url.hostname.toLowerCase().replace(/\.+$/, '') !== 'github.com' || url.port) {
    invalidCloneUrl('skill source must use canonical GitHub')
  }
  if (protocol === 'https:') {
    if (url.username || url.password) invalidCloneUrl('GitHub skill source must not contain credentials')
  } else if (protocol === 'ssh:') {
    if (url.username !== 'git' || url.password) {
      invalidCloneUrl('GitHub SSH skill source must use the git role')
    }
  } else {
    invalidCloneUrl('GitHub skill source must use https or ssh')
  }
  assertGitHubSkillRepositoryPath(url.pathname, protocol === 'https:', true)
  return normalized
}

function assertGitHubSkillRepositoryPath(path: string, allowTree: boolean, urlPath: boolean): void {
  // URL pathnames have exactly one structural leading slash; scp paths have
  // none. Do not trim an arbitrary run here: doing so would admit nonstandard
  // server-side absolute paths that the bounded daemon transport cannot safely
  // canonicalize to GitHub HTTPS.
  if (urlPath ? !path.startsWith('/') || path.startsWith('//') : path.startsWith('/') || path.startsWith('~')) {
    invalidCloneUrl('GitHub skill source must use a repository-relative path')
  }
  const encodedParts = (urlPath ? path.slice(1) : path).split('/')
  if (encodedParts.some((part) => !part)) {
    invalidCloneUrl('GitHub skill source path must not contain empty components')
  }

  let parts: string[]
  try {
    parts = encodedParts.map((part) => decodeURIComponent(part))
  } catch {
    invalidCloneUrl('GitHub skill source contains malformed URL encoding')
  }
  if (parts.some((part) => !part || part.includes('/') || part.includes('\\') || CONTROL_RE.test(part))) {
    invalidCloneUrl('GitHub skill source contains an unsafe encoded path component')
  }
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    invalidCloneUrl('GitHub skill source must identify owner/repository')
  }
  const owner = parts[0]!
  const repo = parts[1]!.replace(/\.git$/i, '')
  if (!GITHUB_SKILL_COMPONENT_RE.test(owner) || !GITHUB_SKILL_COMPONENT_RE.test(repo)) {
    invalidCloneUrl('GitHub skill source contains an invalid owner or repository')
  }
  if (parts.length === 2) return
  if (!allowTree || parts.length < 4 || parts[2] !== 'tree' || parts.slice(3).some((part) => !part)) {
    invalidCloneUrl('GitHub skill source path must be owner/repository or owner/repository/tree/ref[/subdir]')
  }
  const ref = parts[3]!
  if (ref.length > 256 || ref === '.' || ref === '..') {
    invalidCloneUrl('GitHub skill source contains an unsafe tree ref')
  }
  const subDir = parts.slice(4)
  if (subDir.join('/').length > 1_024 || subDir.some((part) => part === '.' || part === '..')) {
    invalidCloneUrl('GitHub skill source contains an unsafe tree subdirectory')
  }
}

function canonicalGitOrigin(protocol: 'https:' | 'ssh:', hostname: string, port: string): string {
  // A final DNS root dot does not select a different host. WHATWG already
  // does this for special schemes; reparse through HTTPS because SSH is a
  // non-special scheme and otherwise preserves case / percent-encoded IDNs.
  let host: string
  try {
    host = new URL(`https://${hostname}`).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    invalidCloneUrl('git origin must identify a valid host')
  }
  if (!host) invalidCloneUrl('git origin must identify a host')
  const defaultPort = protocol === 'https:' ? '443' : '22'
  return `${protocol}//${host}${port && port !== defaultPort ? `:${port}` : ''}`
}

/**
 * Normalize an operator-owned allowlist entry to an exact scheme/host/port
 * origin. Paths, credentials, wildcards, queries, and fragments are not policy
 * syntax: repository paths remain tenant-selected within an allowed origin.
 */
export function normalizeWorkspaceGitOrigin(input: string): string {
  if (CONTROL_RE.test(input)) invalidCloneUrl('git origin must not contain control characters')
  const raw = input.trim()
  if (!raw || /\s/.test(raw) || raw.includes('\\') || raw.includes('*')) {
    invalidCloneUrl('git origin must be an exact https or ssh origin')
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    invalidCloneUrl('git origin must be a valid absolute URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
    invalidCloneUrl('git origin must use https or ssh')
  }
  const authorityStart = raw.indexOf('://') + 3
  const pathStart = raw.indexOf('/', authorityStart)
  const authority = raw.slice(authorityStart, pathStart < 0 ? raw.length : pathStart)
  const path = pathStart < 0 ? '' : raw.slice(pathStart)
  if (
    authority.includes('@') ||
    raw.includes('?') ||
    raw.includes('#') ||
    url.username ||
    url.password ||
    (path !== '' && path !== '/')
  ) {
    invalidCloneUrl('git origin must not contain credentials, a path, query, or fragment')
  }
  return canonicalGitOrigin(url.protocol, url.hostname, url.port)
}

/** Return the canonical exact origin selected by a validated clone URL. */
export function workspaceGitOriginOf(input: string): string {
  const normalized = normalizeGitCloneUrl(input)
  const scp = SCP_PARTS_RE.exec(normalized)
  if (scp) return canonicalGitOrigin('ssh:', scp[2]!, '')

  const url = new URL(normalized)
  return canonicalGitOrigin(url.protocol as 'https:' | 'ssh:', url.hostname, url.port)
}

/**
 * Normalize a clone URL and require its exact scheme/host/port origin to be in
 * the deployment policy. The caller owns the list; tenant input can never add
 * to it.
 */
export function normalizeAllowedWorkspaceGitUrl(input: string, allowedOrigins: readonly string[]): string {
  const normalized = normalizeGitCloneUrl(input)
  const allowed = new Set(allowedOrigins.map(normalizeWorkspaceGitOrigin))
  const origin = workspaceGitOriginOf(normalized)
  if (!allowed.has(origin)) {
    // The refusal names the origin and the operator knob: the reader is usually a tenant whose
    // fix is asking the daemon's operator, so the message must say what to ask for.
    invalidCloneUrl(
      `git clone origin ${origin} is not allowed by this daemon — its operator can allow it via security.workspaceGitAllowedOrigins in the daemon config (${WORKSPACE_GIT_ORIGINS_ENV} for a cluster member)`
    )
  }
  return normalized
}

function withoutQueryOrFragment(value: string): string {
  const query = value.indexOf('?')
  const fragment = value.indexOf('#')
  const cut = query < 0 ? fragment : fragment < 0 ? query : Math.min(query, fragment)
  return cut < 0 ? value : value.slice(0, cut)
}

function redactHierarchicalUrlFallback(value: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i.exec(value)
  if (!match) return value
  const [, prefix, authority, path] = match
  const at = authority!.lastIndexOf('@')
  if (at < 0) return value
  const host = authority!.slice(at + 1)
  if (prefix!.toLowerCase() !== 'ssh://') return `${prefix}${host}${path}`
  const username = authority!.slice(0, at).split(':', 1)[0]
  return `${prefix}${username ? `${username}@` : ''}${host}${path}`
}

function redactMalformedHierarchicalUrl(value: string): string {
  const withoutTail = withoutQueryOrFragment(value)
  const redacted = redactHierarchicalUrlFallback(withoutTail)
  if (redacted !== withoutTail) return redacted
  const authority = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)/i.exec(withoutTail)
  // An unparseable colon-bearing authority may be user:password or a malformed
  // host/port. Returning only the scheme is conservative, non-secret, and
  // deliberately non-cloneable.
  return authority?.[2]?.includes(':') ? authority[1]! : redacted
}

/**
 * Best-effort redaction for stored or historical git addresses.
 *
 * This function is deliberately total: response serialization and logging must
 * not fail merely because a legacy value is malformed. Existing shorthand
 * normalization is retained, HTTPS/other URL userinfo is removed, SSH keeps
 * its non-secret username while dropping a password, and query/fragment data
 * is discarded.
 */
export function redactGitUrlSecrets(input: string): string {
  const normalized = normalizeGitUrl(input)
  if (SCP_RE.test(normalized) || !SCHEME_RE.test(normalized)) return withoutQueryOrFragment(normalized)
  // Git and WHATWG disagree on backslashes, so never let WHATWG reserialize an
  // ambiguous password as apparent path text.
  if (normalized.includes('\\')) return redactMalformedHierarchicalUrl(normalized)

  try {
    const url = new URL(normalized)
    if (url.protocol === 'ssh:') {
      url.password = ''
    } else {
      url.username = ''
      url.password = ''
    }
    url.search = ''
    url.hash = ''
    return normalizeGitUrl(url.toString())
  } catch {
    // Malformed hierarchical URLs still receive a conservative string-level
    // redaction so the total fallback cannot echo obvious credentials.
    return redactMalformedHierarchicalUrl(normalized)
  }
}

/** Canonical GitHub clone URL for an App-backed workspace. The GitHub
 * installation grant is tied to owner/repo, so a caller-supplied host or extra
 * path must never select different content while retaining that authority. */
export function normalizeGithubRepoUrl(input: string): string {
  const redacted = redactGitUrlSecrets(input)
  const hasGitSuffix = redacted.endsWith('.git')
  const label = gitRepoLabel(redacted)
  const parts = label.split('/')
  if (parts.length !== 2 || parts.some((part) => !part)) {
    invalidCloneUrl('github repository must be exactly owner/repo')
  }
  return normalizeGitCloneUrl(`${label}${hasGitSuffix ? '.git' : ''}`)
}

/**
 * Shorten a stored git address to the `org/repo` display form.
 * `https://github.com/acme/infra.git` / `git@github.com:acme/infra` → `acme/infra`.
 * Unrecognized inputs come back unchanged (minus a trailing `.git`).
 */
export function gitRepoLabel(gitRepo: string): string {
  const s = trimTrailingSlashes(gitRepo.trim()).replace(/\.git$/, '')
  const scp = SCP_RE.exec(s)
  if (scp) return scp[1]!.replace(/^\/+/, '')
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(s)
  if (url) return url[1]!
  const segments = s.split('/')
  if (segments.length >= 3 && segments[0]!.includes('.')) return segments.slice(1).join('/')
  return s
}
