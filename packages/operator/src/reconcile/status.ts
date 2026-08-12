import {
  CONDITION_DEGRADED,
  CONDITION_LIMITS_APPLIED,
  CONDITION_NAMESPACE_READY,
  CONDITION_PROGRESSING,
  CONDITION_READY,
  type AgentConnectOrg,
  type AgentConnectOrgStatus,
  type Condition
} from '../crd/types.js'
import type { Observations, ReconcileContext } from './context.js'
import type { EnvelopeInputs } from './envelope.js'
import { DAEMON_NAME, SANDBOX_EXTENSIONS_GROUP, SANDBOX_GROUP, getOrNull, groupPath } from './resources.js'

/** Upsert a condition, advancing lastTransitionTime only when the status flips. */
export function setCondition(conditions: Condition[], next: Condition, nowIso: string): Condition[] {
  const existing = conditions.find((condition) => condition.type === next.type)
  const lastTransitionTime = existing && existing.status === next.status ? existing.lastTransitionTime : nowIso
  const updated: Condition = { ...next, lastTransitionTime }
  return [...conditions.filter((condition) => condition.type !== next.type), updated]
}

interface DeploymentRead {
  metadata?: { generation?: number }
  spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ image?: string }> } } }
  status?: { observedGeneration?: number; readyReplicas?: number; updatedReplicas?: number }
}

interface SandboxList {
  items?: Array<{ spec?: { operatingMode?: string } }>
}

// SandboxWarmPool status is exactly {replicas, readyReplicas, selector} — there is no claimed count on the pool.
interface WarmPoolList {
  items?: Array<{ metadata?: { name?: string }; status?: { readyReplicas?: number } }>
}

interface ClaimList {
  items?: Array<{ spec?: { warmPoolRef?: { name?: string } }; status?: { sandbox?: { name?: string } } }>
}

/** Read the live workload state the status summaries derive from. */
export async function observeWorkloads(ctx: ReconcileContext, input: EnvelopeInputs, obs: Observations): Promise<void> {
  const ns = input.namespace
  const deployment = await getOrNull<DeploymentRead>(ctx.http, groupPath('apps/v1', ns, 'deployments', DAEMON_NAME))
  if (deployment) {
    const desired = deployment.spec?.replicas ?? 0
    const ready = deployment.status?.readyReplicas ?? 0
    // Converged = the controller has seen this spec AND the ready pods are the updated ones —
    // otherwise a stale readyReplicas from the old pod would report the target image Ready.
    const converged =
      (deployment.status?.observedGeneration ?? 0) >= (deployment.metadata?.generation ?? 0) &&
      (deployment.status?.updatedReplicas ?? 0) >= desired &&
      ready >= desired
    obs.daemon = {
      ready: desired > 0 && converged,
      image: deployment.spec?.template?.spec?.containers?.[0]?.image
    }
    // OR, not overwrite: an earlier step (e.g. a deferred suspend) may already be progressing.
    obs.progressing = obs.progressing || !converged
  }
  const sandboxes = await getOrNull<SandboxList>(ctx.http, groupPath(SANDBOX_GROUP, ns, 'sandboxes'))
  const items = sandboxes?.items ?? []
  const suspended = items.filter((sandbox) => sandbox.spec?.operatingMode === 'Suspended').length
  obs.sandboxes = { total: items.length, running: items.length - suspended, suspended }
  const pools = await getOrNull<WarmPoolList>(ctx.http, groupPath(SANDBOX_EXTENSIONS_GROUP, ns, 'sandboxwarmpools'))
  const poolItems = pools?.items ?? []
  // Adoption strips the warm-pool label, so readyReplicas counts only unclaimed members — claimed comes from the claims.
  const claimed = poolItems.length > 0 ? await countBoundClaims(ctx, ns) : new Map<string, number>()
  // Observation record only: absent vendor status fields read as 0, never as a guess.
  obs.pools = poolItems.map((pool) => {
    const name = pool.metadata?.name ?? ''
    return { name, warmAvailable: pool.status?.readyReplicas ?? 0, claimed: claimed.get(name) ?? 0 }
  })
}

/** Bound SandboxClaims per warm pool — a claim counts only once it actually holds a Sandbox. */
async function countBoundClaims(ctx: ReconcileContext, ns: string): Promise<Map<string, number>> {
  const claims = await getOrNull<ClaimList>(ctx.http, groupPath(SANDBOX_EXTENSIONS_GROUP, ns, 'sandboxclaims'))
  const counts = new Map<string, number>()
  for (const claim of claims?.items ?? []) {
    const pool = claim.spec?.warmPoolRef?.name
    if (!pool || !claim.status?.sandbox?.name) continue
    counts.set(pool, (counts.get(pool) ?? 0) + 1)
  }
  return counts
}

/** Build the full status from this pass's observations; the operator is the only status writer. */
export function buildStatus(org: AgentConnectOrg, obs: Observations, nowIso: string): AgentConnectOrgStatus {
  let conditions = org.status?.conditions ?? []
  const generation = org.metadata?.generation
  const put = (next: Condition): void => {
    conditions = setCondition(conditions, { ...next, observedGeneration: generation }, nowIso)
  }
  put({
    type: CONDITION_NAMESPACE_READY,
    status: obs.namespaceReady ? 'True' : 'False',
    reason: obs.namespaceReady ? 'Claimed' : (obs.degraded?.reason ?? 'Pending'),
    message: obs.namespaceReady ? undefined : obs.degraded?.message
  })
  const degradedMessage = obs.degraded?.message ?? obs.warnings.join('; ')
  put({
    type: CONDITION_DEGRADED,
    status: obs.degraded || obs.warnings.length > 0 ? 'True' : 'False',
    reason: obs.degraded?.reason ?? (obs.warnings.length > 0 ? 'EnvelopeWarning' : 'Healthy'),
    message: degradedMessage || undefined
  })
  put({
    type: CONDITION_PROGRESSING,
    status: obs.progressing || obs.rollout ? 'True' : 'False',
    reason: obs.rollout ? 'RuntimeRollout' : obs.progressing ? 'DaemonRollout' : 'Stable'
  })
  // The gateway spike has not pinned the policy kinds, so no acknowledgement exists to observe yet.
  put({ type: CONDITION_LIMITS_APPLIED, status: 'Unknown', reason: 'GatewayNotConfigured' })
  const suspended = org.spec?.suspend === true
  const ready = obs.namespaceReady && !obs.degraded && !suspended && obs.daemon?.ready === true
  put({
    type: CONDITION_READY,
    status: ready ? 'True' : 'False',
    reason: ready
      ? 'EnvelopeReady'
      : suspended
        ? 'Suspended'
        : (obs.degraded?.reason ?? (obs.daemon?.ready ? 'Pending' : 'DaemonNotReady'))
  })
  return {
    observedGeneration: generation,
    // namespace publishes atomically with NamespaceReady=True, never before validation.
    ...(obs.namespaceReady && obs.namespace ? { namespace: obs.namespace } : {}),
    conditions,
    ...(obs.daemon ? { daemon: obs.daemon } : {}),
    ...(obs.sandboxes ? { sandboxes: obs.sandboxes } : {}),
    ...(obs.pools ? { pools: obs.pools } : {}),
    ...(obs.rollout ? { rollout: obs.rollout } : {})
  }
}

/** The operator-owned optional fields; whatever this pass did not observe is nulled, not left stale. */
const MANAGED_STATUS_FIELDS = ['namespace', 'daemon', 'sandboxes', 'pools', 'rollout'] as const

/** Publish status with replacement semantics: merge-patch plus explicit nulls for absent fields. */
export async function writeStatus(
  ctx: ReconcileContext,
  org: AgentConnectOrg,
  obs: Observations,
  nowIso = new Date().toISOString()
): Promise<void> {
  const name = org.metadata?.name
  if (!name) return
  const status: Record<string, unknown> = { ...buildStatus(org, obs, nowIso) }
  for (const field of MANAGED_STATUS_FIELDS) {
    if (status[field] === undefined) status[field] = null
  }
  await ctx.orgApi.patchStatus(name, status as AgentConnectOrgStatus)
}
