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
  metadata?: { generation?: number }
  spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ image?: string }> } } }
  status?: { observedGeneration?: number; readyReplicas?: number; updatedReplicas?: number }
}

interface ContainerStatusRead {
  ready?: boolean
  state?: { waiting?: { reason?: string } }
}

interface PodRead {
  metadata?: { name?: string }
  status?: {
    phase?: string
    conditions?: Array<{ type?: string; status?: string }>
    containerStatuses?: ContainerStatusRead[]
    initContainerStatuses?: ContainerStatusRead[]
  }
}

interface PodList {
  items?: PodRead[]
}

interface EventRead {
  involvedObject?: { name?: string }
  message?: string
  lastTimestamp?: string
  eventTime?: string
  series?: { lastObservedTime?: string }
}

interface EventList {
  items?: EventRead[]
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

/** Every declared container reported ready — an empty list means the kubelet has not started any yet. */
function isPodReady(pod: PodRead): boolean {
  const containers = pod.status?.containerStatuses ?? []
  return containers.length > 0 && containers.every((status) => status.ready === true)
}

/** The kubelet cannot build a container config it cannot resolve; the daemon pod's only such reference is the Secret. */
function hasCredentialConfigError(pod: PodRead): boolean {
  const containers = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]
  return containers.some((status) => status.state?.waiting?.reason === 'CreateContainerConfigError')
}

/** Pending with the scheduler refusing to place the pod — nothing has read the Secret yet. */
function isUnschedulable(pod: PodRead): boolean {
  return (
    pod.status?.phase === 'Pending' &&
    (pod.status.conditions ?? []).some((condition) => condition.type === 'PodScheduled' && condition.status === 'False')
  )
}

/** Sized to the recorder, not the kubelet: mounts retry about every two minutes, but once the correlator's
 *  burst drains it admits one update per five minutes per object, so API-visible ones can be ~6 min apart. */
const FAILED_MOUNT_FRESH_MS = 15 * 60_000

/** Newest occurrence across both Event shapes: core aggregation and the events.k8s.io series. Absent reads as stale. */
function lastOccurrenceMs(event: EventRead): number {
  const stamps = [event.series?.lastObservedTime, event.lastTimestamp, event.eventTime]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((ms) => !Number.isNaN(ms))
  return stamps.length > 0 ? Math.max(...stamps) : 0
}

/** No container has been created yet — the state a blocked mount leaves the pod in, and the corroboration
 *  that keeps a retained Event from outliving the fault it described. */
function isAwaitingContainerCreate(pod: PodRead): boolean {
  const containers = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]
  return containers.length === 0 || containers.some((status) => status.state?.waiting?.reason === 'ContainerCreating')
}

/** The name has to appear as the Secret the kubelet could not read — the wordings it uses to say so.
 *  A bare substring would blame the credential for a PVC that merely shares the name. */
function namesCredentialSecret(message: string, namespace: string, secretName: string): boolean {
  return [`secret "${secretName}"`, `secrets "${secretName}"`, `secret ${namespace}/${secretName}`].some((form) =>
    message.includes(form)
  )
}

/** A Secret-backed volume the kubelet cannot mount surfaces only as a FailedMount Event; pod.status never names it. */
async function hasFailedCredentialMount(
  ctx: ReconcileContext,
  namespace: string,
  pods: PodRead[],
  secretName: string
): Promise<boolean> {
  const names = new Set(
    pods
      .filter(isAwaitingContainerCreate)
      .map((pod) => pod.metadata?.name)
      .filter((name): name is string => Boolean(name))
  )
  if (names.size === 0) return false
  let events: EventList
  try {
    events = await ctx.http.json<EventList>({
      method: 'GET',
      path: corePath(namespace, 'events'),
      query: { fieldSelector: 'involvedObject.kind=Pod,reason=FailedMount' }
    })
  } catch (error) {
    // Best-effort: an install whose RBAC predates this read must lose the nuance, not the whole status pass.
    ctx.log.warn?.(`${namespace}: FailedMount events unreadable: ${(error as Error).message}`)
    return false
  }
  // Matched on how the message names the Secret, so the daemon's own PVC is never read as a credential fault,
  // and on the newest occurrence so an Event retained past its fix cannot keep describing a resolved mount.
  const cutoff = Date.now() - FAILED_MOUNT_FRESH_MS
  return (events.items ?? []).some(
    (event) =>
      names.has(event.involvedObject?.name ?? '') &&
      namesCredentialSecret(event.message ?? '', namespace, secretName) &&
      lastOccurrenceMs(event) >= cutoff
  )
}

/** A FailedMount Event can be written after the pod's last update, which no watch would wake us for. */
export const CREDENTIAL_RECHECK_MS = 60_000

interface CredentialVerdict {
  credential: NonNullable<Observations['credential']>
  /** Set when the verdict is provisional: the pod is up to nothing yet and only an Event can refine it. */
  recheckAfterMs?: number
}

/** CredentialReady exists to report the Secret mount, so separate it from ordinary scheduling and startup delay. */
async function observeCredential(
  ctx: ReconcileContext,
  namespace: string,
  pods: PodRead[],
  secretName: string
): Promise<CredentialVerdict> {
  if (pods.length === 0) return { credential: { status: 'Unknown', reason: 'NoDaemonPod' } }
  if (pods.some(isPodReady)) return { credential: { status: 'True', reason: 'DaemonRunning' } }
  const missing = {
    credential: {
      status: 'False',
      reason: 'CredentialSecretMissing',
      message: `daemon pod cannot mount credential secret ${secretName}`
    }
  } as const
  if (pods.some(hasCredentialConfigError)) return missing
  // An unplaced pod never reached a kubelet, so no mount was attempted and there is no Event worth reading.
  // The scheduler keeps updating the PodScheduled condition while it retries, so a watch wakes the next pass.
  if (pods.every(isUnschedulable))
    return {
      credential: { status: 'Unknown', reason: 'DaemonPodUnschedulable', message: 'daemon pod is not scheduled yet' }
    }
  if (await hasFailedCredentialMount(ctx, namespace, pods, secretName)) return missing
  return { credential: { status: 'False', reason: 'DaemonPodNotReady' }, recheckAfterMs: CREDENTIAL_RECHECK_MS }
}

/** Read the live workload state the status summaries derive from. */
export async function observeWorkloads(ctx: ReconcileContext, input: EnvelopeInputs, obs: Observations): Promise<void> {
  const ns = input.spec.targetNamespace
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
  const pods = await ctx.http.json<PodList>({
    method: 'GET',
    path: corePath(ns, 'pods'),
    query: { labelSelector: `${APP_LABEL_KEY}=${DAEMON_NAME}` }
  })
  const daemonPods = pods.items ?? []
  // CredentialReady derives from pod state: the required Secret mount is the only startup gate.
  const verdict: CredentialVerdict = input.spec.suspend
    ? { credential: { status: 'Unknown', reason: 'Suspended' } }
    : await observeCredential(ctx, ns, daemonPods, input.spec.daemon.credentialSecretName)
  obs.credential = verdict.credential
  if (verdict.recheckAfterMs !== undefined) obs.recheckAfterMs = verdict.recheckAfterMs
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
    type: CONDITION_CREDENTIAL_READY,
    status: obs.credential?.status ?? 'Unknown',
    reason: obs.credential?.reason ?? 'NotObserved',
    message: obs.credential?.message
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
