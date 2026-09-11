import {
  DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS,
  normalizeAllowedWorkspaceGitUrl,
  normalizeWorkspaceGitOrigin,
  workspaceGitOriginOf,
  WORKSPACE_GIT_ANY_ORIGIN
} from '@agentconnect.md/protocol'
import { normalizeManagedBaseUrl } from '../gitcred/managed-hosts.js'

// One daemon runs per process. Keep the operator-owned policy beside the
// functional workspace helpers, like git-injection's process-local state.
let allowedOrigins: readonly string[] = DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS

export function configureWorkspaceGitOrigins(origins: readonly string[]): void {
  allowedOrigins = origins.map(normalizeWorkspaceGitOrigin)
}

/** The origin form of a code host's base URL, which may carry a path prefix (§24.1) an origin may not. */
function codeHostOrigin(codeHost: string | undefined): string | undefined {
  const host = normalizeManagedBaseUrl(codeHost)
  if (!host) return undefined
  try {
    const url = new URL(host)
    return normalizeWorkspaceGitOrigin(`${url.protocol}//${url.host}`)
  } catch {
    return undefined // not addressable as a clone origin; the caller's own boundary reports that
  }
}

/**
 * The operator's list plus the code hosts THIS agent's spec names — one per spec-hosted provider
 * (§24.4, gitea-integration.md §3). Deployment configuration, not tenant input — the same values
 * that already decide which host the daemon hands this agent's git credential to, so refusing to
 * clone one protected nothing and made every self-managed install restate an address the control
 * plane had already sent.
 *
 * Derived per call from the spec in hand rather than remembered: a daemon installs specs through
 * four paths (live upsert, the register/ok snapshot, activate, a move), and a policy carried in
 * process state is only as correct as whichever path last happened to run.
 *
 * An explicit empty list is a decision about this daemon — no remote Git workspaces at all — and
 * nothing widens past it.
 */
function effectiveOrigins(deploymentCodeHosts: readonly (string | undefined)[]): readonly string[] {
  if (allowedOrigins.length === 0) return allowedOrigins
  let origins = allowedOrigins
  for (const codeHost of deploymentCodeHosts) {
    const origin = codeHostOrigin(codeHost)
    if (origin && !origins.includes(origin)) origins = [...origins, origin]
  }
  return origins
}

/** Final daemon boundary for every tenant-selected workspace network target. */
export function authorizeWorkspaceGitUrl(input: string, ...deploymentCodeHosts: (string | undefined)[]): string {
  return normalizeAllowedWorkspaceGitUrl(input, effectiveOrigins(deploymentCodeHosts))
}

/**
 * The origin a workspace repository needs but this daemon's policy excludes; undefined when the
 * policy admits it (§24.4). The policy is the operator's list plus the deployment's own code hosts,
 * so what this reports is a repository somewhere none of them names.
 */
export function unauthorizedWorkspaceGitOrigin(
  repository: string,
  ...deploymentCodeHosts: (string | undefined)[]
): string | undefined {
  try {
    authorizeWorkspaceGitUrl(repository, ...deploymentCodeHosts)
    return undefined
  } catch {
    try {
      return workspaceGitOriginOf(repository)
    } catch {
      return undefined // not a clone address at all; the clone boundary reports that on its own
    }
  }
}

/** True when the OPERATOR list carries no HTTPS origin (`*` carries them all). Managed GitLab is
 *  HTTPS-only (§13.2), so such a daemon serves no GitLab instance beyond the one its own
 *  deployment names — which is a per-agent answer this startup-time check cannot have. */
export function permitsNoHttpsOrigin(): boolean {
  return !allowedOrigins.some(
    (origin) => origin === WORKSPACE_GIT_ANY_ORIGIN || origin.toLowerCase().startsWith('https://')
  )
}
