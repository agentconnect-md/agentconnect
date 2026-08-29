// The Git URL tile's input policy (git-workspace-model.md §7): a FULL https/ssh
// address only — no shorthand — and the managed hosts are refused with a
// switch-tile hint, so tile ↔ stored-shape stays injective by construction.

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i
const SCP_RE = /^[\w.-]+@[\w.-]+:.+$/

/** The deployment's GitLab instance, published via runtime config (window.__AC_ENV);
 *  gitlab.com when unset. Lives in this leaf so both tile guards share one answer. */
export function managedGitlabInstanceUrl(): string {
  if (typeof window !== 'undefined') {
    const configured = window.__AC_ENV?.GITLAB_URL
    if (configured) return configured
  }
  return 'https://gitlab.com'
}

/** host[:port] of the managed instance, the unit `gitRepoHostname` answers in. */
export function managedGitlabHost(): string {
  try {
    return new URL(managedGitlabInstanceUrl()).host.toLowerCase()
  } catch {
    return 'gitlab.com'
  }
}

/** Hostname of a git address (scheme URL or scp-style ssh); shared with the tile derivation. */
export function gitRepoHostname(input: string): string | undefined {
  const s = input.trim()
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:?#]+)/i.exec(s) ?? /^[\w.-]+@([\w.-]+):/.exec(s)
  return m?.[1]?.toLowerCase()
}

/** Non-null ⇒ the address does not belong on this tile; the string says why / where to go. */
export function gitRepoUrlTileHint(input: string): string | null {
  const s = input.trim()
  if (!s) return null // emptiness is handled by canSubmit, not a hint
  if (!SCHEME_RE.test(s) && !SCP_RE.test(s)) {
    return 'Enter a full https:// or ssh:// clone URL.'
  }
  const host = gitRepoHostname(s)
  if (host === 'github.com') return 'Use the “GitHub” tile for github.com repositories.'
  if (host === 'gitlab.com' || host === managedGitlabHost()) {
    return 'Use the “GitLab” tile for GitLab projects.'
  }
  return null
}
