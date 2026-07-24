import {
  DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS,
  normalizeAllowedWorkspaceGitUrl,
  normalizeWorkspaceGitOrigin
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
