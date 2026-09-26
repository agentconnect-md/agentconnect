// A GitHub trigger watches one repository or every repository of one installation (webhook-triggers-and-github-events.md, Installation-Wide Rows).

/** The console's key for an installation-wide pick: `owner/*`, which the owner-based access and installation lookups read as that account. */
export function installationScopeKey(accountLogin: string): string {
  return `${accountLogin}/*`
}

/** The account an installation-wide key names; null for a repository. */
export function installationScopeAccount(key: string | null | undefined): string | null {
  return key?.endsWith('/*') ? key.slice(0, -2) : null
}

/** A github trigger's scope as a write sends it: an installation row by its account, any other row by its repository. */
export function githubHookScope(hook: {
  repoFullName: string | null
  installationAccount?: string | null
}): { githubAccount: string } | { repoFullName: string } {
  return hook.installationAccount
    ? { githubAccount: hook.installationAccount }
    : { repoFullName: hook.repoFullName ?? '' }
}

/** The key a github trigger's scope reads under in the console's per-scope maps. */
export function githubHookScopeKey(hook: {
  repoFullName: string | null
  installationAccount?: string | null
}): string | null {
  return hook.installationAccount ? installationScopeKey(hook.installationAccount) : hook.repoFullName
}
