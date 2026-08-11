import { z } from 'zod'

export const GROUP = 'agentconnect.md'
export const VERSION = 'v1alpha1'
export const API_VERSION = `${GROUP}/${VERSION}`
export const KIND = 'AgentConnectOrg'
export const PLURAL = 'agentconnectorgs'

/** Guards the envelope deletion order; only the operator removes it. */
export const FINALIZER = 'agentconnect.md/org-envelope'

/** Rollout drain handshake annotation on runtime Sandboxes (value: `<rolloutId>/<image>`). */
export const DRAIN_REQUESTED_ANNOTATION = 'agentconnect.md/drain-requested'
/** Pod-template annotation the operator bumps to force a Recreate on credential rotation. */
export const CREDENTIAL_REVISION_ANNOTATION = 'agentconnect.md/credential-revision'
/** Label mapping envelope workloads (Deployments/Pods) back to their owning org CR. */
export const ORG_LABEL = 'agentconnect.md/org'
/** Label an operator stamps on a namespace it created or adopted. */
export const NAMESPACE_CLAIM_LABEL = 'agentconnect.md/org-namespace'

export const CONDITION_READY = 'Ready'
export const CONDITION_NAMESPACE_READY = 'NamespaceReady'
export const CONDITION_CREDENTIAL_READY = 'CredentialReady'
export const CONDITION_LIMITS_APPLIED = 'LimitsApplied'
export const CONDITION_PROGRESSING = 'Progressing'
export const CONDITION_DEGRADED = 'Degraded'
export const REASON_LIMITS_APPLY_FAILED = 'LimitsApplyFailed'

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

// The zod schemas are the operator's runtime guard; the CRD YAML in
// charts/operator is authoritative for the API server. A parity test keeps
// the two field sets aligned.
export const AgentConnectOrgSpecSchema = z.object({
  targetNamespace: z.string().regex(DNS_LABEL, 'targetNamespace must be a DNS label'),
  displayName: z.string().optional(),
  suspend: z.boolean().default(false),
  daemon: z.object({
    image: z.string().min(1),
    tier: z.string().min(1),
    credentialSecretName: z.string().default('ac-daemon-token'),
    credentialRevision: z.string().optional()
  }),
  runtime: z.object({
    image: z.string().min(1),
    tiers: z.array(
      z.object({
        name: z.string().min(1),
        warmReplicas: z.number().int().min(0).default(0)
      })
    )
  }),
  quota: z
    .object({
      maxAgents: z.number().int().min(0).default(0),
      cpu: z.string().default('0'),
      memory: z.string().default('0'),
      storage: z.string().default('0')
    })
    .default({ maxAgents: 0, cpu: '0', memory: '0', storage: '0' }),
  llmLimits: z
    .object({
      perSession: z.object({ tokensPerMinute: z.number().int().min(0).default(0) }).default({ tokensPerMinute: 0 }),
      perOrg: z
        .object({
          tokensPerMinute: z.number().int().min(0).default(0),
          requestsPerMinute: z.number().int().min(0).default(0),
          tokensPerDay: z.number().int().min(0).default(0)
        })
        .default({ tokensPerMinute: 0, requestsPerMinute: 0, tokensPerDay: 0 })
    })
    .optional(),
  egressPolicy: z.enum(['locked', 'curated', 'open']).default('curated'),
  llmDeny: z
    .object({
      all: z.boolean().default(false),
      agents: z.array(z.string()).default([])
    })
    .optional(),
  deletionPolicy: z.enum(['Delete']).default('Delete')
})

export const ConditionSchema = z.object({
  type: z.string(),
  status: z.enum(['True', 'False', 'Unknown']),
  reason: z.string().optional(),
  message: z.string().optional(),
  lastTransitionTime: z.string().optional(),
  observedGeneration: z.number().int().optional()
})

export const AgentConnectOrgStatusSchema = z.object({
  observedGeneration: z.number().int().optional(),
  namespace: z.string().optional(),
  conditions: z.array(ConditionSchema).optional(),
  daemon: z.object({ ready: z.boolean(), image: z.string().optional() }).optional(),
  sandboxes: z.object({ total: z.number().int(), running: z.number().int(), suspended: z.number().int() }).optional(),
  pools: z.array(z.object({ name: z.string(), warmAvailable: z.number().int(), claimed: z.number().int() })).optional(),
  appliedLimits: z.object({ generation: z.number().int() }).optional(),
  rollout: z
    .object({
      rolloutId: z.string(),
      targetImage: z.string(),
      pending: z.array(z.string()),
      failed: z.array(z.string())
    })
    .optional()
})

export type AgentConnectOrgSpec = z.infer<typeof AgentConnectOrgSpecSchema>
export type AgentConnectOrgStatus = z.infer<typeof AgentConnectOrgStatusSchema>
export type Condition = z.infer<typeof ConditionSchema>

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
    finalizers?: string[]
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  spec?: AgentConnectOrgSpec
  status?: AgentConnectOrgStatus
}
