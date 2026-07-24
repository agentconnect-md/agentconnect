/**
 * Git repo address helpers, shared by the CP (normalize on write) and the
 * daemon (defensive normalize before clone).
 *
 * STORAGE INVARIANT: `workspace.gitRepo` is persisted as a FULL cloneable git
 * address (e.g. `https://github.com/acme/infra`), never the `acme/infra`
 * shorthand a user may type. UIs shorten it back to `org/repo` for display
 * with `gitRepoLabel`.
 */

/** Scheme-full address: https://, ssh://, git://, file://, … */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i
/** Any URI scheme, including non-hierarchical forms such as `ext::…`. */
const ANY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
/** scp-like ssh address: git@github.com:acme/infra(.git) */
const SCP_RE = /^[\w.-]+@[\w.-]+:(.+)$/
const SCP_PARTS_RE = /^([\w.-]+)@([\w.-]+):(.+)$/
const CONTROL_RE = /[\u0000-\u001f\u007f]/

export class GitCloneUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitCloneUrlError'
  }
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
  const s = input.trim().replace(/\/+$/, '')
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
 * Public Git hosts remain host-agnostic. Only credential-free HTTPS and SSH
 * transports are accepted; local paths and Git's executable/legacy transports
 * are rejected before the value can reach `git clone`.
 */
export function normalizeGitCloneUrl(input: string): string {
  if (CONTROL_RE.test(input)) invalidCloneUrl('git clone url must not contain control characters')

  const s = input.trim().replace(/\/+$/, '')
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
  const s = gitRepo
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  const scp = SCP_RE.exec(s)
  if (scp) return scp[1]!.replace(/^\/+/, '')
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(s)
  if (url) return url[1]!
  const segments = s.split('/')
  if (segments.length >= 3 && segments[0]!.includes('.')) return segments.slice(1).join('/')
  return s
}
