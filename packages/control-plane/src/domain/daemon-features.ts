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
 */
import { GITLAB_COM_V1_FEATURE } from '@agentconnect.md/protocol'

// Structural on purpose: the predicate reads only the workspace-mode
// discriminant, so DOMAIN records and WIRE AgentSpec bundles both fit — the
// sender-level activation gate checks the exact spec it is about to transmit.
type WorkspaceShapedAgent = { workspace: { mode: string } }

/** Features a daemon must advertise before this agent's spec can decode there. */
export function requiredDaemonFeatures(agent: WorkspaceShapedAgent): readonly string[] {
  // The workspace union's 'gitlab' arm arrives with the M4 daemon slice; until a
  // row can carry it this returns [] for every agent, and the comparison stays a
  // string so the arm lights the gate up without touching this file again.
  return agent.workspace.mode === 'gitlab' ? [GITLAB_COM_V1_FEATURE] : []
}

/** Fail-closed: unknown/absent advertised features support only feature-free agents. */
export function daemonSupportsAgent(
  agent: WorkspaceShapedAgent,
  advertisedFeatures: readonly string[] | undefined
): boolean {
  const required = requiredDaemonFeatures(agent)
  if (required.length === 0) return true
  const advertised = new Set(advertisedFeatures ?? [])
  return required.every((feature) => advertised.has(feature))
}
