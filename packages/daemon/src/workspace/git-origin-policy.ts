import {
  DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS,
  normalizeAllowedWorkspaceGitUrl,
  normalizeWorkspaceGitOrigin,
  workspaceGitOriginOf
} from '@agentconnect.md/protocol'
import { gitlabManagedHost } from '../gitcred/managed-hosts.js'

// One daemon runs per process. Keep the operator-owned policy beside the
// functional workspace helpers, like git-injection's process-local state.
let allowedOrigins: readonly string[] = DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS

export function configureWorkspaceGitOrigins(origins: readonly string[]): void {
  allowedOrigins = origins.map(normalizeWorkspaceGitOrigin)
}

// The one code host this deployment's control plane names — deployment configuration, not tenant
// input, and the same value that already decides which host this daemon hands an agent's git
// credential to. Adopting it is what keeps a self-managed instance from having to be restated here.
let deploymentCodeHostOrigin: string | undefined

/** Adopt the code host a spec names, so cloning from it needs no second statement anywhere. A
 *  deployment addresses ONE GitLab instance, so the latest spec is the current answer. */
export function adoptDeploymentCodeHost(gitlabHost: string | undefined): void {
  const host = gitlabHost?.trim()
  // Absent means this AGENT addresses GitLab.com or no GitLab at all (§24.1) — never that the
  // deployment stopped having an instance. Leave the answer alone: with several agents on one
  // daemon, clearing here would make the policy depend on whose spec arrived last. A disconnected
  // instance is forgotten at restart, when nothing names it again.
  if (!host) return
  try {
    // The base URL may carry a path prefix (§24.1), which an origin may not: keep scheme, host, port.
    const url = new URL(gitlabManagedHost(host).baseUrl)
    deploymentCodeHostOrigin = normalizeWorkspaceGitOrigin(`${url.protocol}//${url.host}`)
  } catch {
    // Not addressable as a clone origin: leave the previous answer rather than a broken one.
  }
}

/** The operator's list plus the deployment's own host — except when the operator turned remote
 *  workspaces off entirely, which is a decision about this daemon and not about one host. */
function effectiveOrigins(): readonly string[] {
  if (allowedOrigins.length === 0) return allowedOrigins
  if (!deploymentCodeHostOrigin || allowedOrigins.includes(deploymentCodeHostOrigin)) return allowedOrigins
  return [...allowedOrigins, deploymentCodeHostOrigin]
}

/** Final daemon boundary for every tenant-selected workspace network target. */
export function authorizeWorkspaceGitUrl(input: string): string {
  return normalizeAllowedWorkspaceGitUrl(input, effectiveOrigins())
}

/**
 * The origin a workspace repository needs but this daemon's policy excludes; undefined when the
 * policy admits it (§24.4). The policy is the operator's list plus the deployment's own code host,
 * so what this reports is a repository somewhere neither of them names.
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
  return !effectiveOrigins().some((origin) => origin.toLowerCase().startsWith('https://'))
}
