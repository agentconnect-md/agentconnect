// Azure DevOps run projection (azure-devops-integration.md §11.7): one Control-Plane-written pull-request status per state change, under the Gitea writer's ledger rules.
import { randomUUID } from 'node:crypto'
import type {
  AzureDevOpsHookMetadata,
  CodeHostNoteState,
  HookConfigSnapshot,
  OptionalHookConfigSnapshot
} from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '../domain/clock.js'
import { AgentId, HookId, type OrgId } from '../domain/ids.js'
import type {
  AgentRepo,
  AzureDevOpsConnectionRecord,
  AzureDevOpsConnectionRepo,
  AzureDevOpsRepositoryBindingRecord,
  AzureDevOpsRepositoryBindingRepo,
  CodeHostRunProjectionRecord,
  CodeHostRunProjectionRepo,
  CodeHostRunProjectionWriterRepo,
  HookRepo,
  OrgRepo
} from '../persistence/ports.js'
import { completeSnapshot } from '../codehost/note-projection.service.js'
import { AzureDevOpsApiError, azureDevOpsCall, type AzureDevOpsApiClient } from './api.js'
import type { AzureDevOpsConnectionService } from './connection.service.js'
import { hookBindingOf } from './hook.service.js'

const PROVIDER = 'azure-devops'
const GENRE = 'agentconnect'
const API_VERSION = '7.1'
const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_LEASE_MS = 30_000
const DEFAULT_BATCH_SIZE = 25
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 5 * 60_000
/** How long a write may stay unobserved before its absence counts as proof it never landed. */
const AMBIGUOUS_WRITE_GRACE_MS = 10 * 60_000
const REASON_CODE = /^[a-z0-9_:-]{1,100}$/

export type AzureDevOpsStatusState = 'pending' | 'succeeded' | 'failed' | 'error' | 'notApplicable' | 'notSet'

/** §11.7's mapping; `notApplicable` is never written, because under a required status policy it removes the requirement. */
const STATUS_STATE: Record<CodeHostNoteState, Exclude<AzureDevOpsStatusState, 'notApplicable'>> = {
  queued: 'pending',
  running: 'pending',
  completed: 'succeeded',
  failed: 'error',
  interrupted: 'error',
  skipped: 'succeeded',
  superseded: 'succeeded'
}

const DESCRIPTION: Record<CodeHostNoteState, string> = {
  queued: 'AgentConnect review queued',
  running: 'AgentConnect review in progress',
  completed: 'AgentConnect review completed',
  failed: 'AgentConnect review failed',
  interrupted: 'AgentConnect review interrupted before it finished',
  skipped: 'AgentConnect review skipped',
  superseded: 'AgentConnect review superseded by a newer revision'
}

/** The states whose description names the normalized reason. */
const REASONED: ReadonlySet<CodeHostNoteState> = new Set(['failed', 'skipped'])

export function isAzureDevOpsProjectionState(state: string): state is CodeHostNoteState {
  return state in STATUS_STATE
}

function normalizedReason(reason: string | null | undefined): string | undefined {
  return reason && REASON_CODE.test(reason) ? reason : undefined
}

/** The pull-request facts a projection needs; a push or a head-less update has nothing to project. */
export function azureDevOpsProjectionSubject(
  azure: AzureDevOpsHookMetadata | undefined
): { projectId: bigint; projectPath: string; mergeRequestIid: number; headSha: string } | null {
  if (!azure || azure.target.kind !== 'pull' || !azure.target.headSha) return null
  return {
    projectId: BigInt(azure.repoId),
    projectPath: azure.repoPath,
    mergeRequestIid: azure.target.pullRequestId,
    headSha: azure.target.headSha
  }
}

export interface AzureDevOpsStatusSpec {
  state: Exclude<AzureDevOpsStatusState, 'notApplicable'>
  description: string
  context: { genre: string; name: string }
  targetUrl?: string
}

/** The one status a generation writes: a bounded normalized state, and the ordinary Console link when one exists. */
export function azureDevOpsStatusSpec(
  row: Pick<CodeHostRunProjectionRecord, 'agentId' | 'agentName' | 'desiredState' | 'reason'>,
  consoleUrl?: string
): AzureDevOpsStatusSpec {
  const state = row.desiredState
  const reason = REASONED.has(state) || state === 'superseded' ? normalizedReason(row.reason) : undefined
  return {
    state: STATUS_STATE[state],
    description: reason ? `${DESCRIPTION[state]} (${reason})` : DESCRIPTION[state],
    context: { genre: GENRE, name: row.agentName ?? row.agentId },
    ...(consoleUrl ? { targetUrl: consoleUrl } : {})
  }
}

/** The Console link carrying one write's marker, the only evidence a listed status is that write. */
export function withWriteMarker(consoleUrl: string | undefined, marker: string): string | undefined {
  if (!consoleUrl) return undefined
  return `${consoleUrl}${consoleUrl.includes('?') ? '&' : '?'}write=${encodeURIComponent(marker)}`
}

/** One lifecycle edge, as the WS/relay frame that carries it already presents it. */
export interface AzureDevOpsStatusEdge {
  hookId: string
  agentId: string
  deliveryKey: string
  orgId: OrgId
  state: CodeHostNoteState
  reason?: string | null
  sessionId?: string
  azureDevOps: AzureDevOpsHookMetadata | undefined
  snapshot: OptionalHookConfigSnapshot
  at: Date
}

type BindingLookup = Pick<AzureDevOpsRepositoryBindingRepo, 'listForRepo'>

/** The binding a status is written through: the repository's hooked one (§11.5). */
async function hookedBinding(
  bindings: BindingLookup,
  orgId: string,
  repoId: bigint
): Promise<AzureDevOpsRepositoryBindingRecord | undefined> {
  return hookBindingOf(await bindings.listForRepo(orgId, repoId))
}

export interface AzureDevOpsStatusCoordinatorDeps {
  projections: Pick<CodeHostRunProjectionRepo, 'upsert' | 'setDesired' | 'supersede' | 'getByNaturalKey'>
  /** The ACCEPTED run behind an edge — the only authority for its projection epoch. */
  runs: Pick<HookRepo, 'getRun'>
  agents: Pick<AgentRepo, 'getUnscoped'>
  bindings: BindingLookup
  connections: Pick<AzureDevOpsConnectionRepo, 'get'>
  clock: Pick<Clock, 'now'>
  /** Immediate wake-up only; the reporter's periodic scan is authoritative. */
  kick?: () => void
}

/** Converts hook-turn lifecycle edges to one current desired status; call each after its HookRun mutation commits. */
export class AzureDevOpsStatusCoordinator {
  constructor(private readonly deps: AzureDevOpsStatusCoordinatorDeps) {}

  /** Relay accepted the delivery: queued when it names a head; an update kind waits for the head its turn reads. */
  async afterAccepted(edge: AzureDevOpsStatusEdge): Promise<void> {
    await this.converge({ ...edge, state: 'queued' })
  }

  async afterDeliveryFailed(edge: AzureDevOpsStatusEdge): Promise<void> {
    await this.converge({ ...edge, state: 'skipped' })
  }

  /** The `hook/start` barrier crossed, carrying the head the daemon read. */
  async afterStart(edge: AzureDevOpsStatusEdge): Promise<void> {
    await this.converge({ ...edge, state: 'running' })
  }

  async afterReport(edge: AzureDevOpsStatusEdge): Promise<void> {
    await this.converge(edge)
  }

  private async converge(edge: AzureDevOpsStatusEdge): Promise<void> {
    const subject = azureDevOpsProjectionSubject(edge.azureDevOps)
    if (!subject) return
    const snapshot = completeSnapshot(edge.snapshot)
    if (!snapshot || snapshot.reportingMode !== 'status') return
    const run = await this.deps.runs.getRun(HookId(edge.hookId), edge.deliveryKey)
    if (!run || run.projectionEpoch === null) return
    const agent = await this.deps.agents.getUnscoped(AgentId(edge.agentId))
    if (!agent || agent.orgId !== edge.orgId) return
    const binding = await hookedBinding(this.deps.bindings, edge.orgId, subject.projectId)
    if (!binding) return
    const connection = await this.deps.connections.get(edge.orgId, binding.connectionId)
    if (!connection) return

    // A success that crossed no start barrier settles only a status its own delivery opened; an ignored update or a cleanup never restates the head's.
    if (edge.state === 'completed' && !run.turnStartedAt) {
      const held = await this.deps.projections.getByNaturalKey(
        HookId(edge.hookId),
        subject.projectId,
        subject.mergeRequestIid,
        subject.headSha,
        run.projectionEpoch
      )
      if (held?.currentDeliveryKey !== edge.deliveryKey) return
    }

    const acceptedAt = run.startedAt
    const terminal = edge.state !== 'queued' && edge.state !== 'running'
    const reason = normalizedReason(edge.reason)
    const projection = await this.deps.projections.upsert({
      provider: PROVIDER,
      hookId: HookId(edge.hookId),
      orgId: edge.orgId,
      agentId: AgentId(edge.agentId),
      agentName: agent.name,
      projectionEpoch: run.projectionEpoch,
      desiredState: edge.state,
      currentDeliveryKey: edge.deliveryKey,
      currentRunAt: edge.at,
      credentialEpoch: connection.credentialEpoch,
      ...this.fence(snapshot),
      ...subject,
      ...(reason ? { reason } : {}),
      ...(edge.sessionId ? { sessionId: edge.sessionId } : {}),
      queuedAt: acceptedAt,
      ...(edge.state === 'running' ? { startedAt: edge.at } : {}),
      ...(terminal ? { completedAt: edge.at } : {}),
      nextAttemptAt: edge.at
    })
    if (!projection || projection.tombstonedAt) return
    if (projection.currentDeliveryKey !== edge.deliveryKey) return
    await this.deps.projections.supersede(
      HookId(edge.hookId),
      subject.projectId,
      subject.mergeRequestIid,
      subject.headSha,
      edge.at,
      acceptedAt
    )
    if (projection.writePhase !== null) return
    const moved = await this.deps.projections.setDesired(
      projection.id,
      projection.generation,
      edge.state,
      edge.at,
      reason
    )
    if (moved) this.deps.kick?.()
  }

  private fence(snapshot: HookConfigSnapshot) {
    return {
      configRevision: BigInt(snapshot.configRevision),
      dispatchRevision: BigInt(snapshot.dispatchRevision),
      dispatchDaemonId: snapshot.dispatchDaemonId,
      reviewPolicySnapshot: snapshot.reviewPolicy,
      reportingModeSnapshot: snapshot.reportingMode,
      gateModeSnapshot: snapshot.gateMode
    }
  }
}

export interface AzureDevOpsStatusReporterLog {
  info(obj: unknown, msg?: string): void
  warn?(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface AzureDevOpsStatusReporterDeps {
  projections: Pick<
    CodeHostRunProjectionWriterRepo,
    'claimDue' | 'beginWrite' | 'completeWrite' | 'retryWrite' | 'blockWrite' | 'settleWrite' | 'advancePending' | 'get'
  >
  bindings: BindingLookup
  connections: Pick<AzureDevOpsConnectionRepo, 'get'>
  /** The connection's token, its one retry after a stale token, and the §3.5 degradation of a definite refusal. */
  service: Pick<AzureDevOpsConnectionService, 'withApi'>
  api: AzureDevOpsApiClient
  orgs?: Pick<OrgRepo, 'slugById'>
  clock: Clock
  /** Console origin for the ordinary authenticated session link; unset ⇒ the status carries no link. */
  webAppUrl?: string
  workerId?: string
  intervalMs?: number
  leaseMs?: number
  batchSize?: number
  log?: AzureDevOpsStatusReporterLog
}

interface StatusTarget {
  connection: AzureDevOpsConnectionRecord
  pullUrl: string
}

interface ListedStatus {
  id?: unknown
  state?: unknown
  description?: unknown
  context?: { genre?: unknown; name?: unknown }
  createdBy?: { id?: unknown }
  iterationId?: unknown
  targetUrl?: unknown
}

/** Durable periodic worker for one pull-request status per state change (§11.7). */
export class AzureDevOpsStatusReporter {
  private readonly workerId: string
  private readonly intervalMs: number
  private readonly leaseMs: number
  private readonly batchSize: number
  private timer: TimerHandle | undefined
  private started = false
  private running = false
  private rerunRequested = false

  constructor(private readonly deps: AzureDevOpsStatusReporterDeps) {
    this.workerId = deps.workerId ?? `azure-devops-status-reporter:${randomUUID()}`
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
    this.leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE
  }

  start(): void {
    this.started = true
    this.schedule(0)
  }

  stop(): void {
    this.started = false
    this.rerunRequested = false
    if (this.timer !== undefined) {
      this.deps.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Best-effort latency optimization. Periodic scans remain the recovery path. */
  kick(): void {
    if (!this.started) return
    if (this.running) {
      this.rerunRequested = true
      return
    }
    this.schedule(0)
  }

  /** One or more claimed batches. Public for deterministic unit tests. */
  async tick(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true
      return
    }
    this.running = true
    if (this.timer !== undefined) {
      this.deps.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
    try {
      do {
        this.rerunRequested = false
        const now = new Date(this.deps.clock.now())
        const claimed = await this.deps.projections.claimDue(
          PROVIDER,
          this.workerId,
          now,
          new Date(now.getTime() + this.leaseMs),
          this.batchSize
        )
        for (const projection of claimed) {
          try {
            await this.process(projection)
          } catch (err) {
            await this.retry(
              projection,
              'worker_error',
              projection.writeMarker !== null || projection.writePhase !== null
            )
            this.deps.log?.error(
              { err, projectionId: projection.id, generation: projection.generation.toString() },
              'azure-devops-status-reporter: projection failed'
            )
          }
        }
        if (claimed.length === this.batchSize) this.rerunRequested = true
      } while (this.rerunRequested)
    } catch (err) {
      this.deps.log?.error({ err }, 'azure-devops-status-reporter: claim failed')
    } finally {
      this.running = false
      if (this.started) this.schedule(this.intervalMs)
    }
  }

  private schedule(delayMs: number): void {
    if (!this.started) return
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = this.deps.clock.setTimeout(() => void this.tick(), delayMs)
  }

  private async process(row: CodeHostRunProjectionRecord): Promise<void> {
    if (!isAzureDevOpsProjectionState(row.desiredState)) {
      await this.blockOrHold(row, 'invalid_state')
      return
    }
    const inFlight = row.writeMarker !== null || row.writePhase !== null
    if (row.observedState === row.desiredState && !inFlight) {
      if (row.pendingIntent !== null) await this.advancePending(row)
      else await this.deps.projections.settleWrite(row.id, row.generation, this.workerId)
      return
    }
    // A tombstone is cleanup-only authority: it resolves a status a removed hook left pending and mints nothing otherwise.
    if (row.tombstonedAt !== null && !inFlight && row.observedState !== 'queued' && row.observedState !== 'running') {
      if (row.pendingIntent !== null) await this.advancePending(row)
      else await this.deps.projections.blockWrite(row.id, row.generation, 'cleanup_not_needed')
      return
    }

    const target = await this.target(row)
    if (!target) {
      await this.blockOrHold(row, 'repo_authorization')
      return
    }

    if (row.writeMarker && row.writePhase) {
      await this.reconcileAmbiguous(row, target)
      return
    }

    // Every fallible read precedes the write marker; after it, only the one POST or a reconcile may follow.
    let iterationId: number | undefined
    try {
      iterationId = await this.iterationOf(target, row.headSha)
    } catch (err) {
      await this.retry(row, errorLabel(err, 'iteration_read_failed'), false, retryAfter(err))
      return
    }
    const marker = randomUUID()
    const spec = azureDevOpsStatusSpec(row, withWriteMarker(await this.consoleUrl(row), marker))
    const now = new Date(this.deps.clock.now())
    const taken = await this.deps.projections.beginWrite(
      row.id,
      row.generation,
      this.workerId,
      marker,
      row.noteId ? 'update' : 'create',
      now,
      new Date(now.getTime() + this.leaseMs)
    )
    if (!taken) return
    try {
      const created = await this.deps.service.withApi(target.connection, (token) =>
        azureDevOpsCall<{ id?: unknown }>(
          this.deps.api,
          token,
          target.connection.organization,
          `${target.pullUrl}/statuses?api-version=${API_VERSION}`,
          { method: 'POST', body: { ...spec, ...(iterationId !== undefined ? { iterationId } : {}) } }
        )
      )
      await this.finish(row, marker, statusIdOf(created?.id) ?? row.noteId ?? '')
    } catch (err) {
      await this.handleWriteError(row, err)
    }
  }

  private async target(row: CodeHostRunProjectionRecord): Promise<StatusTarget | undefined> {
    const binding = await hookedBinding(this.deps.bindings, row.orgId, row.projectId)
    if (!binding) return undefined
    const connection = await this.deps.connections.get(row.orgId, binding.connectionId)
    if (!connection) return undefined
    const organization = encodeURIComponent(connection.organization)
    const repository = `${this.deps.api.devOpsBaseUrl}/${organization}/${binding.projectId}/_apis/git/repositories/${binding.repositoryId}`
    return { connection, pullUrl: `${repository}/pullRequests/${row.mergeRequestIid}` }
  }

  /** The newest iteration whose source commit is the projected head; none ⇒ the status names no iteration. */
  private async iterationOf(target: StatusTarget, headSha: string): Promise<number | undefined> {
    const listed = await this.deps.service.withApi(target.connection, (token) =>
      azureDevOpsCall<{ value?: Array<{ id?: unknown; sourceRefCommit?: { commitId?: unknown } }> }>(
        this.deps.api,
        token,
        target.connection.organization,
        `${target.pullUrl}/iterations?api-version=${API_VERSION}`
      )
    )
    let found: number | undefined
    for (const iteration of listed?.value ?? []) {
      const id = typeof iteration.id === 'number' && Number.isSafeInteger(iteration.id) ? iteration.id : undefined
      const commit = iteration.sourceRefCommit?.commitId
      if (id === undefined || typeof commit !== 'string' || commit.toLowerCase() !== headSha.toLowerCase()) continue
      if (found === undefined || id > found) found = id
    }
    return found
  }

  /** Proven only by a listed status carrying this write's marker on this head's iteration; absent past the grace window, it never landed. */
  private async reconcileAmbiguous(row: CodeHostRunProjectionRecord, target: StatusTarget): Promise<void> {
    const expectedUrl = withWriteMarker(await this.consoleUrl(row), row.writeMarker!)
    const spec = azureDevOpsStatusSpec(row, expectedUrl)
    let statuses: ListedStatus[]
    let iterationId: number | undefined
    try {
      iterationId = await this.iterationOf(target, row.headSha)
      const listed = await this.deps.service.withApi(target.connection, (token) =>
        azureDevOpsCall<{ value?: ListedStatus[] }>(
          this.deps.api,
          token,
          target.connection.organization,
          `${target.pullUrl}/statuses?api-version=${API_VERSION}`
        )
      )
      statuses = listed?.value ?? []
    } catch (err) {
      // Even a definite GET failure says nothing about the earlier mutation: the marker stays.
      await this.retry(row, errorLabel(err, 'reconcile_failed'), true)
      return
    }
    const lastObserved = row.noteId && /^\d+$/.test(row.noteId) ? BigInt(row.noteId) : -1n
    const identity = target.connection.identityId.toLowerCase()
    const landed = statuses
      .filter((status) => (statusIdOf(status.id) ? BigInt(statusIdOf(status.id)!) > lastObserved : false))
      .filter((status) => status.context?.genre === spec.context.genre && status.context?.name === spec.context.name)
      .filter((status) => typeof status.createdBy?.id !== 'string' || status.createdBy.id.toLowerCase() === identity)
      // Without the marker in the link nothing proves the write; another head's or an earlier write's status never does.
      .filter((status) => expectedUrl !== undefined && status.targetUrl === expectedUrl)
      .filter((status) => (status.iterationId ?? undefined) === iterationId)
      .find((status) => status.state === spec.state && status.description === spec.description)
    if (landed) {
      await this.finish(row, row.writeMarker!, statusIdOf(landed.id)!)
      return
    }
    if (this.writeGraceElapsed(row)) {
      await this.deps.projections.retryWrite(
        row.id,
        row.generation,
        this.workerId,
        new Date(this.deps.clock.now()),
        'ambiguous_write_reissued',
        false
      )
      return
    }
    await this.retry(row, 'ambiguous_write', true)
  }

  private writeGraceElapsed(row: CodeHostRunProjectionRecord): boolean {
    if (!row.writeStartedAt) return false
    return this.deps.clock.now() - row.writeStartedAt.getTime() >= AMBIGUOUS_WRITE_GRACE_MS
  }

  private async finish(row: CodeHostRunProjectionRecord, marker: string, statusId: string): Promise<void> {
    const completed = await this.deps.projections.completeWrite({
      projectionId: row.id,
      generation: row.generation,
      leaseOwner: this.workerId,
      writeMarker: marker,
      observedState: row.desiredState,
      ...(statusId ? { noteId: statusId } : {}),
      recheckAt: new Date(this.deps.clock.now())
    })
    if (!completed) return
    const fresh = await this.deps.projections.get(row.id)
    if (fresh?.pendingIntent) await this.advancePending(fresh)
  }

  private async advancePending(row: CodeHostRunProjectionRecord): Promise<void> {
    const advanced = await this.deps.projections.advancePending(row.id, row.generation, new Date(this.deps.clock.now()))
    if (advanced) this.rerunRequested = true
  }

  private async handleWriteError(row: CodeHostRunProjectionRecord, err: unknown): Promise<void> {
    if (err instanceof AzureDevOpsApiError) {
      // A received rejection of the token is a definite non-effect; the connection path already recorded it.
      if (err.code === 'UNAUTHORIZED' || err.code === 'SECRET_REJECTED' || err.code === 'ACCESS_REVOKED') {
        await this.retry(row, 'token_rejected', false)
        return
      }
      if (err.code === 'RATE_LIMITED') {
        await this.retry(row, 'rate_limited', false, err.retryAfterMs ?? 60_000)
        return
      }
      if (!err.retryable && err.status !== 0) {
        // A received non-retryable response proves this request did not mutate.
        await this.deps.projections.blockWrite(row.id, row.generation, errorLabel(err, 'azure_devops_write_denied'))
        return
      }
    }
    // A transport failure or a 5xx may or may not have applied the effect: keep the marker and reconcile.
    await this.retry(row, 'ambiguous_write', true)
  }

  private async blockOrHold(row: CodeHostRunProjectionRecord, code: string): Promise<void> {
    if (row.writeMarker || row.writePhase) {
      await this.retry(row, code, true)
      return
    }
    await this.deps.projections.blockWrite(row.id, row.generation, code)
  }

  private async retry(
    row: CodeHostRunProjectionRecord,
    code: string,
    keepWriteMutex: boolean,
    waitAtLeastMs = 0
  ): Promise<void> {
    const attempt = Math.max(0, row.attempts)
    const delay = Math.max(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempt, 8)), waitAtLeastMs)
    await this.deps.projections.retryWrite(
      row.id,
      row.generation,
      this.workerId,
      new Date(this.deps.clock.now() + delay),
      code,
      keepWriteMutex
    )
  }

  /** An ordinary authenticated Console session URL — never a bearer token, secret, or capability param. */
  private async consoleUrl(row: CodeHostRunProjectionRecord): Promise<string | undefined> {
    if (!this.deps.webAppUrl || !this.deps.orgs || !row.sessionId) return undefined
    try {
      const slug = await this.deps.orgs.slugById(row.orgId)
      if (!slug) return undefined
      const base = `${this.deps.webAppUrl.replace(/\/+$/, '')}/${encodeURIComponent(slug)}`
      return `${base}/sessions/${encodeURIComponent(row.sessionId)}?source=azure-devops`
    } catch (err) {
      this.deps.log?.warn?.({ err, projectionId: row.id }, 'azure-devops-status-reporter: console link lookup failed')
      return undefined
    }
  }
}

function statusIdOf(value: unknown): string | undefined {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value) : ''
  return /^\d+$/.test(raw) ? raw : undefined
}

function errorLabel(err: unknown, fallback: string): string {
  return err instanceof AzureDevOpsApiError ? err.code.toLowerCase() : fallback
}

function retryAfter(err: unknown): number {
  return err instanceof AzureDevOpsApiError && err.code === 'RATE_LIMITED' ? (err.retryAfterMs ?? 60_000) : 0
}
