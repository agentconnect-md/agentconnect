// The Git URL tile's input policy (git-workspace-model.md §7): a FULL https/ssh
// address only — no shorthand — and the managed hosts are refused with a
// switch-tile hint, so tile ↔ stored-shape stays injective by construction.

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i
const SCP_RE = /^[\w.-]+@[\w.-]+:.+$/

/** The deployment's GitLab instance, published via runtime config (window.__AC_ENV);
 *  gitlab.com only as the unset fallback. Lives in this leaf so every guard shares it. */
export function managedGitlabInstanceUrl(): string {
  if (typeof window !== 'undefined') {
    const configured = window.__AC_ENV?.GITLAB_URL
    if (configured) return configured
  }
  return 'https://gitlab.com'
}

/** Hostname of a git address (scheme URL or scp-style ssh); shared with the tile derivation. */
export function gitRepoHostname(input: string): string | undefined {
  const s = input.trim()
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:?#]+)/i.exec(s) ?? /^[\w.-]+@([\w.-]+):/.exec(s)
  return m?.[1]?.toLowerCase()
}

/**
 * The repository path when the address sits on the configured GitLab instance;
 * null otherwise. Mirrors the CP's `gitlabManagedProjectPath` semantics — the
 * whole base matches (host, non-default port, path prefix), an scp/ssh address
 * matches only a prefix-less base, and gitlab.com claims nothing once another
 * instance is configured.
 */
export function managedGitlabRepoPath(input: string, baseUrl = managedGitlabInstanceUrl()): string | null {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return null
  }
  const baseHost = base.host.toLowerCase() // URL drops default ports, like the CP's canonical origin
  const basePrefix = base.pathname.replace(/\/+$/, '')
  const s = input.trim()
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(s)
  if (scp) {
    if (basePrefix !== '' || scp[1]!.toLowerCase() !== baseHost) return null
    const path = scp[2]!
      .replace(/^\/+/, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
    return path.includes('/') ? path : null
  }
  let url: URL
  try {
    url = new URL(s)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return null
  if (url.protocol === 'ssh:' && basePrefix !== '') return null
  if (url.host.toLowerCase() !== baseHost) return null
  const path = url.pathname.replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!path.toLowerCase().startsWith(`${basePrefix.toLowerCase()}/`)) return null
  const repoPath = path.slice(basePrefix.length + 1)
  return repoPath.includes('/') ? repoPath : null
}

/** Non-null ⇒ the address does not belong on this tile; the string says why / where to go. */
export function gitRepoUrlTileHint(input: string): string | null {
  const s = input.trim()
  if (!s) return null // emptiness is handled by canSubmit, not a hint
  if (!SCHEME_RE.test(s) && !SCP_RE.test(s)) {
    return 'Enter a full https:// or ssh:// clone URL.'
  }
  if (gitRepoHostname(s) === 'github.com') return 'Use the “GitHub” tile for github.com repositories.'
  if (managedGitlabRepoPath(s) !== null) return 'Use the “GitLab” tile for GitLab projects.'
  return null
}
