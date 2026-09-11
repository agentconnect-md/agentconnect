/**
 * §17.3 snapshot projection gate (gitlab-com-integration.md).
 *
 * The daemon reads CP-authored frames tolerantly, but tolerance covers unknown
 * KEYS only — a new union arm or enum value inside `register/ok` or
 * `agent/upsert` makes the whole frame undecodable on a peer that predates it,
 * killing its work for every other host too. So the CP must never project a
 * spec shaped by a host (or place such an agent) onto a daemon that has not
 * advertised that host's feature. This module is the one predicate every
 * projection and placement site asks; which features a host needs, and which
 * field carries its instance axis, are that host's registry entry's answers
 * (`codehost/provider.ts`).
 *
 * §24.4 adds a second axis on the same predicate: when the deployment's instance
 * is not the host's default, the same values additionally require the per-agent
 * host bit, so a daemon that cannot carry a host per agent never sees
 * self-managed work and cannot fall back to the default instance for it.
 */
import {
  CODE_HOST_PROVIDERS,
  WORKSPACE_GIT_V1_FEATURE,
  isSelfManagedGitlabHost,
  type AgentSpec
} from '@agentconnect.md/protocol'
import type { CodeHostProviderRegistry } from '../codehost/provider.js'
import { codeHostProviders } from '../codehost/registry.js'

// Structural on purpose: the predicate reads the workspace discriminant + credential
// axis, the assembled additional-repository list, and the assembled host axes — so
// DOMAIN records and WIRE AgentSpec bundles both fit. The sender-level activation gate
// checks the exact spec it is about to transmit, which is the only place the
// grant and hook sources are visible: neither lives on the agent row.
type WorkspaceShapedAgent = {
  workspace?: {
    mode: string
    credential?: { provider?: string }
    additionalRepos?: readonly { provider?: string }[]
  }
  gitlabHost?: string
}

export { isSelfManagedGitlabHost }

/** Fail-closed: unknown/absent advertised features support only feature-free values. */
export function advertises(advertisedFeatures: readonly string[] | undefined, required: readonly string[]): boolean {
  if (required.length === 0) return true
  const advertised = new Set(advertisedFeatures ?? [])
  return required.every((feature) => advertised.has(feature))
}

/** Whether any of this agent's workspace, grants, or legacy wire mode is vouched by `provider`. */
function consumes(agent: WorkspaceShapedAgent, provider: string): boolean {
  return (
    agent.workspace?.mode === provider ||
    agent.workspace?.credential?.provider === provider ||
    (agent.workspace?.additionalRepos ?? []).some((repo) => repo.provider === provider)
  )
}

/** Features a daemon must advertise before this agent's spec can decode there. */
export function requiredDaemonFeatures(
  agent: WorkspaceShapedAgent,
  codeHosts: CodeHostProviderRegistry = codeHostProviders
): readonly string[] {
  const features: string[] = []
  for (const provider of CODE_HOST_PROVIDERS) {
    const host = codeHosts[provider].features
    // Three sources of a consumer, not one. A vouched workspace (git-workspace-model.md
    // §2: `credential.provider`, or the legacy wire arm's mode) is frame-fatal on a peer
    // that predates the host; an ADDITIONAL repository of its is quieter and worse — the
    // old schema strips the unknown `provider` key, so a two-segment project path reads
    // as an `owner/repo` GitHub entry and would be cloned from github.com.
    //
    // §24.4: a spec carrying a non-default instance is host-shaped whichever consumer put
    // it there — an enabled hook alone qualifies, and that consumer is invisible in the
    // workspace above. A default (or absent) instance gates nothing, so default-instance
    // fleets stay exactly as they are.
    const instance = host.specHost(agent)
    features.push(...(consumes(agent, provider) ? host.required(instance) : host.requiredForInstance(instance)))
  }
  return features
}

/** Fail-closed: unknown/absent advertised features support only feature-free agents. */
export function daemonSupportsAgent(
  agent: WorkspaceShapedAgent,
  advertisedFeatures: readonly string[] | undefined
): boolean {
  return advertises(advertisedFeatures, requiredDaemonFeatures(agent))
}

// Per-peer dual encoding (§8): the `git` arm to peers advertising workspace-git-v1
// (frame-fatal elsewhere — one roster entry would kill the whole register/ok), the
// legacy host-shaped arm to the rest. Runs at every transmit site — roster,
// agent/upsert, agent/activate, duty/fetch — because the peer is only known there.
export function encodeSpecWorkspaceForPeer<S extends Pick<AgentSpec, 'workspace'>>(
  spec: S,
  advertisedFeatures: readonly string[] | undefined,
  codeHosts: CodeHostProviderRegistry = codeHostProviders
): S {
  const workspace = spec.workspace
  if (workspace?.mode !== 'git' || advertises(advertisedFeatures, [WORKSPACE_GIT_V1_FEATURE])) return spec
  const shared = {
    isolation: workspace.isolation,
    gitRepo: workspace.gitRepo,
    branch: workspace.branch,
    ...(workspace.agentDir !== undefined ? { agentDir: workspace.agentDir } : {}),
    additionalRepos: workspace.additionalRepos
  }
  const credential = workspace.credential
  const hostArm = credential ? codeHosts[credential.provider].workspace.legacySpecArm(shared, credential) : null
  // The legacy `github` arm is deliberately host-agnostic, so an anonymous
  // workspace on any host rides it exactly as it always did.
  const legacy: AgentSpec['workspace'] = hostArm ?? { mode: 'github', ...shared }
  return { ...spec, workspace: legacy }
}
