import {
  DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS,
  normalizeAllowedWorkspaceGitUrl,
  normalizeWorkspaceGitOrigin,
  workspaceGitOriginOf
} from '@agentconnect.md/protocol'

// One daemon runs per process. Keep the operator-owned policy beside the
// functional workspace helpers, like git-injection's process-local state.
let allowedOrigins: readonly string[] = DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS

export function configureWorkspaceGitOrigins(origins: readonly string[]): void {
  allowedOrigins = origins.map(normalizeWorkspaceGitOrigin)
}

/** Final daemon boundary for every tenant-selected workspace network target. */
export function authorizeWorkspaceGitUrl(input: string): string {
  return normalizeAllowedWorkspaceGitUrl(input, allowedOrigins)
}

/**
 * The origin a workspace repository needs but the operator policy excludes; undefined when the
 * policy admits it (§24.4). The operator allowlist stays authoritative — the managed GitLab feature
 * allows exactly the configured origin and never widens the list — so a spec naming an excluded
 * instance is refused by NAMING the origin an operator has to add.
 */
export function unauthorizedWorkspaceGitOrigin(repository: string): string | undefined {
  try {
    authorizeWorkspaceGitUrl(repository)
    return undefined
  } catch {
    try {
      return workspaceGitOriginOf(repository)
    } catch {
      return undefined // not a clone address at all; the clone boundary reports that on its own
    }
  }
}

/** True when no HTTPS origin is permitted at all: managed GitLab is HTTPS-only (§13.2), so on such
 *  a daemon no GitLab instance — GitLab.com or self-managed — can ever be cloned. */
export function permitsNoHttpsOrigin(): boolean {
  return !allowedOrigins.some((origin) => origin.toLowerCase().startsWith('https://'))
}
