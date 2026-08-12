/**
 * Pure projections between the stored cluster-execution settings and the
 * `AgentConnectOrg` resource (docs/designs/agentconnect-org-operator.md §2):
 * the CR name, the spec the control plane applies, and the status shape the
 * console reads back. The envelope NAMESPACE is deliberately not among them —
 * the control plane never sets the CRD's override, so the operator derives it
 * from the CR name and publishes it on `status`.
 */
import type { ClusterExecutionSettings } from '../persistence/ports.js'
import { CONDITION_TYPES, type AgentConnectOrgSpec, type AgentConnectOrgStatus, type ConditionType } from './crd.js'

/** Kubernetes namespaces are DNS labels: ≤63 chars, lowercase alphanumeric and dashes. */
const MAX_DNS_LABEL = 63
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export class ClusterNamingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClusterNamingError'
  }
}

/**
 * The org's CR name in the control namespace: the org id folded to a DNS label.
 * The operator derives the envelope namespace as `<install prefix><CR name>`, so
 * the name is truncated to leave the prefix room and a truncated tail keeps the
 * id's leading (unique) characters. Derived ONCE at enable time and stored,
 * because the name is the durable handle everything else addresses the envelope
 * by — including the tombstone that outlives the organization row.
 */
export function orgResourceName(prefix: string, orgId: string): string {
  const slug = orgId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
  // An empty fold would collapse every such org onto one name — one envelope for
  // many orgs is the one outcome worse than refusing the write.
  if (!slug) throw new ClusterNamingError(`org id "${orgId}" has no characters usable in a resource name`)
  // Clamped: a negative budget would make slice() trim from the END and quietly
  // return a name whose prefixed namespace is longer than a label allows.
  const name = slug.slice(0, Math.max(0, MAX_DNS_LABEL - prefix.length)).replace(/-+$/, '')
  if (!DNS_LABEL.test(name)) {
    throw new ClusterNamingError(`derived resource name "${name}" is not a DNS label under prefix "${prefix}"`)
  }
  return name
}

/** The desired `spec` for an org — everything the control plane owns, nothing else. */
export function buildSpec(settings: ClusterExecutionSettings, displayName?: string): AgentConnectOrgSpec {
  return {
    ...(displayName ? { displayName } : {}),
    suspend: settings.suspend,
    daemon: {
      image: settings.daemonImage,
      tier: settings.daemonTier,
      credentialSecretName: settings.credentialSecretName,
      ...(settings.credentialRevision ? { credentialRevision: settings.credentialRevision } : {})
    },
    runtime: {
      image: settings.runtimeImage,
      tiers: settings.runtimeTiers.map((tier) => ({ name: tier.name, warmReplicas: tier.warmReplicas }))
    },
    quota: {
      maxAgents: settings.quota.maxAgents,
      cpu: settings.quota.cpu,
      memory: settings.quota.memory,
      storage: settings.quota.storage
    },
    egressPolicy: settings.egressPolicy
  }
}

export interface ClusterEnvelopeStatus {
  /** False ⇒ no `AgentConnectOrg` exists for this org; every other field is absent. */
  present: boolean
  observedGeneration?: number
  namespace?: string
  conditions: {
    type: string
    status: 'True' | 'False' | 'Unknown'
    reason?: string
    message?: string
    lastTransitionTime?: string
  }[]
  daemon?: { ready: boolean; image?: string }
  sandboxes?: { total: number; running: number; suspended: number }
  pools?: { name: string; warmAvailable: number; claimed: number }[]
  rollout?: { rolloutId: string; targetImage: string; pending: string[]; failed: string[] }
}

/** The status a caller sees when the org has no resource in the control namespace. */
export const ABSENT_ENVELOPE: ClusterEnvelopeStatus = { present: false, conditions: [] }

/** Conditions in the operator's documented order first, then anything it added later. */
function orderConditions(
  conditions: NonNullable<AgentConnectOrgStatus['conditions']>
): ClusterEnvelopeStatus['conditions'] {
  const rank = (type: string): number => {
    const index = CONDITION_TYPES.indexOf(type as ConditionType)
    return index === -1 ? CONDITION_TYPES.length : index
  }
  return [...conditions]
    .sort((a, b) => rank(a.type) - rank(b.type))
    .map((condition) => ({
      type: condition.type,
      status: condition.status,
      ...(condition.reason ? { reason: condition.reason } : {}),
      ...(condition.message ? { message: condition.message } : {}),
      ...(condition.lastTransitionTime ? { lastTransitionTime: condition.lastTransitionTime } : {})
    }))
}

/** Project the operator-owned status onto the console's read model. */
export function projectStatus(status: AgentConnectOrgStatus | undefined): ClusterEnvelopeStatus {
  return {
    present: true,
    ...(status?.observedGeneration !== undefined ? { observedGeneration: status.observedGeneration } : {}),
    ...(status?.namespace ? { namespace: status.namespace } : {}),
    conditions: orderConditions(status?.conditions ?? []),
    ...(status?.daemon ? { daemon: status.daemon } : {}),
    ...(status?.sandboxes ? { sandboxes: status.sandboxes } : {}),
    ...(status?.pools ? { pools: status.pools } : {}),
    ...(status?.rollout ? { rollout: status.rollout } : {})
  }
}
