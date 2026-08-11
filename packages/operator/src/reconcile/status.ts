import {
  CONDITION_CREDENTIAL_READY,
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
import {
  APP_LABEL_KEY,
  DAEMON_NAME,
  SANDBOX_EXTENSIONS_GROUP,
  SANDBOX_GROUP,
  corePath,
  getOrNull,
  groupPath
} from './resources.js'

/** Upsert a condition, advancing lastTransitionTime only when the status flips. */
export function setCondition(conditions: Condition[], next: Condition, nowIso: string): Condition[] {
  const existing = conditions.find((condition) => condition.type === next.type)
  const lastTransitionTime = existing && existing.status === next.status ? existing.lastTransitionTime : nowIso
  const updated: Condition = { ...next, lastTransitionTime }
  return [...conditions.filter((condition) => condition.type !== next.type), updated]
}

interface DeploymentRead {
  spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ image?: string }> } } }
  status?: { readyReplicas?: number; updatedReplicas?: number }
}

interface PodList {
  items?: Array<{ status?: { phase?: string; containerStatuses?: Array<{ ready?: boolean }> } }>
}

interface SandboxList {
  items?: Array<{ spec?: { operatingMode?: string } }>
}

interface WarmPoolList {
  items?: Array<{
    metadata?: { name?: string }
    status?: { availableReplicas?: number; readyReplicas?: number; claimedReplicas?: number }
  }>
}

/** Read the live workload state the status summaries derive from. */
export async function observeWorkloads(ctx: ReconcileContext, input: EnvelopeInputs, obs: Observations): Promise<void> {
  const ns = input.spec.targetNamespace
  const deployment = await getOrNull<DeploymentRead>(ctx.http, groupPath('apps/v1', ns, 'deployments', DAEMON_NAME))
  if (deployment) {
    const desired = deployment.spec?.replicas ?? 0
    const ready = deployment.status?.readyReplicas ?? 0
    obs.daemon = {
      ready: desired > 0 && ready >= desired,
      image: deployment.spec?.template?.spec?.containers?.[0]?.image
    }
    // OR, not overwrite: an earlier step (e.g. a deferred suspend) may already be progressing.
    obs.progressing = obs.progressing || ready < desired
  }
  const pods = await ctx.http.json<PodList>({
    method: 'GET',
    path: corePath(ns, 'pods'),
    query: { labelSelector: `${APP_LABEL_KEY}=${DAEMON_NAME}` }
  })
  const daemonPods = pods.items ?? []
  // CredentialReady derives from pod state: the required Secret mount is the only startup gate.
  if (input.spec.suspend) obs.credential = { status: 'Unknown', reason: 'Suspended' }
  else if (daemonPods.some((pod) => pod.status?.containerStatuses?.every((status) => status.ready)))
    obs.credential = { status: 'True', reason: 'DaemonRunning' }
  else if (daemonPods.length > 0) obs.credential = { status: 'False', reason: 'DaemonPodNotReady' }
  else obs.credential = { status: 'Unknown', reason: 'NoDaemonPod' }
  const sandboxes = await getOrNull<SandboxList>(ctx.http, groupPath(SANDBOX_GROUP, ns, 'sandboxes'))
  const items = sandboxes?.items ?? []
  const suspended = items.filter((sandbox) => sandbox.spec?.operatingMode === 'Suspended').length
  obs.sandboxes = { total: items.length, running: items.length - suspended, suspended }
  const pools = await getOrNull<WarmPoolList>(ctx.http, groupPath(SANDBOX_EXTENSIONS_GROUP, ns, 'sandboxwarmpools'))
  // Observation record only: absent vendor status fields read as 0, never as a guess.
  obs.pools = (pools?.items ?? []).map((pool) => ({
    name: pool.metadata?.name ?? '',
    warmAvailable: pool.status?.availableReplicas ?? pool.status?.readyReplicas ?? 0,
    claimed: pool.status?.claimedReplicas ?? 0
  }))
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
    type: CONDITION_CREDENTIAL_READY,
    status: obs.credential?.status ?? 'Unknown',
    reason: obs.credential?.reason ?? 'NotObserved'
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
