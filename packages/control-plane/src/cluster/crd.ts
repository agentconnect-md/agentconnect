/**
 * The `AgentConnectOrg` contract as the control plane uses it
 * (docs/designs/agentconnect-org-operator.md §2).
 *
 * The CRD in `charts/operator/templates/crd.yaml` is authoritative — the API
 * server validates every write against it and prunes anything unknown. The
 * control plane is a WRITER of `spec` and a READER of `status`, so it needs the
 * group coordinates, the field shapes it emits, and the condition names it
 * projects; runtime validation stays with the API server and the operator. The
 * co-located parity test asserts every path here still exists in that CRD, so a
 * schema change on the operator side cannot silently strand this writer.
 */
export const GROUP = 'agentconnect.md'
export const VERSION = 'v1alpha1'
export const API_VERSION = `${GROUP}/${VERSION}`
export const KIND = 'AgentConnectOrg'
export const PLURAL = 'agentconnectorgs'

/** Server-side-apply field manager; the control plane owns exactly `spec`. */
export const FIELD_MANAGER = 'agentconnect-control-plane'

/** CRD default for `spec.daemon.credentialSecretName`; immutable once created. */
export const DEFAULT_CREDENTIAL_SECRET_NAME = 'ac-daemon-token'

/** Operator-owned status conditions, in the order the console renders them. */
export const CONDITION_TYPES = [
  'Ready',
  'NamespaceReady',
  'CredentialReady',
  'LimitsApplied',
  'Progressing',
  'Degraded'
] as const

export type ConditionType = (typeof CONDITION_TYPES)[number]

export interface AgentConnectOrgSpec {
  targetNamespace: string
  displayName?: string
  suspend: boolean
  daemon: {
    image: string
    tier: string
    credentialSecretName: string
    credentialRevision?: string
  }
  runtime: {
    image: string
    tiers: { name: string; warmReplicas: number }[]
  }
  quota: { maxAgents: number; cpu: string; memory: string; storage: string }
  egressPolicy: 'locked' | 'curated' | 'open'
}

export interface AgentConnectOrgCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  lastTransitionTime?: string
  observedGeneration?: number
}

export interface AgentConnectOrgStatus {
  observedGeneration?: number
  namespace?: string
  conditions?: AgentConnectOrgCondition[]
  daemon?: { ready: boolean; image?: string }
  sandboxes?: { total: number; running: number; suspended: number }
  pools?: { name: string; warmAvailable: number; claimed: number }[]
  rollout?: { rolloutId: string; targetImage: string; pending: string[]; failed: string[] }
}

export interface AgentConnectOrg {
  apiVersion?: string
  kind?: string
  metadata?: {
    name?: string
    namespace?: string
    uid?: string
    resourceVersion?: string
    generation?: number
    deletionTimestamp?: string
  }
  spec?: AgentConnectOrgSpec
  status?: AgentConnectOrgStatus
}
