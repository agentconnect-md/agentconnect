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
/** scp-like ssh address: git@github.com:acme/infra(.git) */
const SCP_RE = /^[\w.-]+@[\w.-]+:(.+)$/

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
