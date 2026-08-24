/**
 * §17.3 snapshot projection gate (gitlab-com-integration.md).
 *
 * The daemon reads CP-authored frames tolerantly, but tolerance covers unknown
 * KEYS only — a new union arm or enum value inside `register/ok` or
 * `agent/upsert` makes the whole frame undecodable on a pre-GitLab daemon,
 * killing its GitHub work too. So the CP must never project a GitLab-shaped
 * spec (or place such an agent) onto a daemon that has not advertised
 * `gitlab-com-v1`. This module is the one predicate every projection and
 * placement site asks; it lands before any GitLab-shaped value can exist, so
 * the first one to exist is born gated.
 *
 * §24.4 adds a second axis on the same predicate: when the deployment's GitLab
 * host is not GitLab.com, the same values additionally require
 * `gitlab-instance-v1`, so a daemon that cannot carry a host per agent never
 * sees self-managed work and cannot fall back to GitLab.com for it.
 */
import { GITLAB_COM_V1_FEATURE, GITLAB_DEFAULT_BASE_URL, GITLAB_INSTANCE_V1_FEATURE } from '@agentconnect.md/protocol'

// Structural on purpose: the predicate reads the workspace-mode discriminant, the
// assembled additional-repository list, and the assembled host axis — so DOMAIN
// records and WIRE AgentSpec bundles both fit. The sender-level activation gate
// checks the exact spec it is about to transmit, which is the only place the
// grant and hook sources are visible: neither lives on the agent row.
type WorkspaceShapedAgent = {
  workspace?: { mode: string; additionalRepos?: readonly { provider?: string }[] }
  gitlabHost?: string
}

/** True when the axis names an instance other than GitLab.com, the only case anything gates (§24.4). */
export function isSelfManagedGitlabHost(host: string | undefined): boolean {
  return host !== undefined && host !== GITLAB_DEFAULT_BASE_URL
}

/** The §24.4 addition ALONE — for a gate that must not start requiring §17.3's bit as well.
 *  The hook's dispatch-target daemon is one: it was never gated on `gitlab-com-v1`, and
 *  widening it here would change GitLab.com fleets. */
export function requiredGitlabInstanceFeatures(host: string | undefined): readonly string[] {
  return isSelfManagedGitlabHost(host) ? [GITLAB_INSTANCE_V1_FEATURE] : []
}

/** Features a peer must advertise before a GitLab-shaped value on `host` can decode there. */
export function requiredGitlabFeatures(host: string | undefined): readonly string[] {
  return [GITLAB_COM_V1_FEATURE, ...requiredGitlabInstanceFeatures(host)]
}

/** Fail-closed: unknown/absent advertised features support only feature-free values. */
export function advertises(advertisedFeatures: readonly string[] | undefined, required: readonly string[]): boolean {
  if (required.length === 0) return true
  const advertised = new Set(advertisedFeatures ?? [])
  return required.every((feature) => advertised.has(feature))
}

/** Features a daemon must advertise before this agent's spec can decode there. */
export function requiredDaemonFeatures(agent: WorkspaceShapedAgent): readonly string[] {
  // Three sources, not one. The workspace union's 'gitlab' arm is frame-fatal on a
  // pre-GitLab daemon; a gitlab ADDITIONAL repository is quieter and worse — the
  // old schema strips the unknown `provider` key, so a two-segment project path
  // reads as an `owner/repo` GitHub entry and would be cloned from github.com.
  // Comparisons stay strings so a new host lights the gate up without touching
  // this file again.
  const gitlab =
    agent.workspace?.mode === 'gitlab' ||
    (agent.workspace?.additionalRepos ?? []).some((repo) => repo.provider === 'gitlab')
  const features = gitlab ? [GITLAB_COM_V1_FEATURE] : []
  // §24.4: GitLab-shaped is any spec carrying a non-default host, whichever consumer
  // put it there — an enabled hook alone qualifies, and that consumer is invisible in
  // the workspace above. A default (or absent) host gates nothing, so GitLab.com fleets
  // stay exactly as they are.
  if (isSelfManagedGitlabHost(agent.gitlabHost)) features.push(GITLAB_INSTANCE_V1_FEATURE)
  return features
}

/** Fail-closed: unknown/absent advertised features support only feature-free agents. */
export function daemonSupportsAgent(
  agent: WorkspaceShapedAgent,
  advertisedFeatures: readonly string[] | undefined
): boolean {
  return advertises(advertisedFeatures, requiredDaemonFeatures(agent))
}
