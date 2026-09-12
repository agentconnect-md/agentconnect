// Gitea run projection (gitea-integration.md §10.4): one Control-Plane-written commit status per (hook, repository, pull request, head).
import { randomUUID } from 'node:crypto'
import type {
  CodeHostNoteState,
  GiteaHookMetadata,
  HookConfigSnapshot,
  OptionalHookConfigSnapshot
} from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '../domain/clock.js'
import { AgentId, HookId, type OrgId } from '../domain/ids.js'
import type {
  AgentRepo,
  CodeHostRunProjectionRecord,
  CodeHostRunProjectionRepo,
  CodeHostRunProjectionWriterRepo,
  GiteaConnectionRepo,
  GiteaRepositoryBindingRepo,
  HookRepo,
  OrgRepo
} from '../persistence/ports.js'
import { completeSnapshot } from '../codehost/note-projection.service.js'
import {
  GITEA_DEFAULT_PAGE_SIZE,
  GiteaApiError,
  giteaCreateCommitStatus,
  giteaListCommitStatuses,
  isGiteaAuthRejection,
  splitGiteaRepoPath,
  type GiteaApiClient,
  type GiteaCommitStatus,
  type GiteaCommitStatusSpec,
  type GiteaCommitStatusState
} from './api.js'
import { GiteaConnectDenied } from './connection.service.js'
import type { GiteaTokenSource } from './provisioner.js'

const PROVIDER = 'gitea'
const CONTEXT_PREFIX = 'agentconnect/'
const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_LEASE_MS = 30_000
const DEFAULT_BATCH_SIZE = 25
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 5 * 60_000
/** How long a marker-bearing write may stay unobserved before its absence counts as proof it never landed. */
const AMBIGUOUS_WRITE_GRACE_MS = 10 * 60_000
const REASON_CODE = /^[a-z0-9_:-]{1,100}$/

/** §10.4's state mapping; `warning` is never used because Gitea folds it into failure. */
const STATUS_STATE: Record<CodeHostNoteState, GiteaCommitStatusState> = {
  queued: 'pending',
  running: 'pending',
  completed: 'success',
  failed: 'error',
  interrupted: 'error',
  skipped: 'success',
  superseded: 'success'
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

/** The states whose description names the normalized reason (§10.4). */
const REASONED: ReadonlySet<CodeHostNoteState> = new Set(['failed', 'skipped'])

export function isGiteaProjectionState(state: string): state is CodeHostNoteState {
  return state in STATUS_STATE
}

/** Only a normalized code reaches a projection; anything else (a raw turn failure text) is dropped. */
function normalizedReason(reason: string | null | undefined): string | undefined {
  return reason && REASON_CODE.test(reason) ? reason : undefined
}

/** The pull-request facts a projection needs; an issue or push subject has nothing to project. */
export function giteaProjectionSubject(
  gitea: GiteaHookMetadata | undefined
): { projectId: bigint; projectPath: string; mergeRequestIid: number; headSha: string } | null {
  if (!gitea || gitea.target.kind !== 'pull' || !gitea.target.headSha) return null
  return {
    projectId: BigInt(gitea.repoId),
    projectPath: gitea.repoPath,
    mergeRequestIid: gitea.target.index,
    headSha: gitea.target.headSha
  }
}

/** The one status a generation writes: a bounded normalized state, and the ordinary Console link when one exists. */
export function giteaStatusSpec(
  row: Pick<CodeHostRunProjectionRecord, 'agentId' | 'agentName' | 'desiredState' | 'reason'>,
  consoleUrl?: string
): GiteaCommitStatusSpec {
  const state = row.desiredState
  const reason = REASONED.has(state) ? normalizedReason(row.reason) : undefined
  return {
    context: `${CONTEXT_PREFIX}${row.agentName ?? row.agentId}`,
    state: STATUS_STATE[state],
    description: reason ? `${DESCRIPTION[state]} (${reason})` : DESCRIPTION[state],
    ...(consoleUrl ? { target_url: consoleUrl } : {})
  }
}

/** One lifecycle edge, as the WS/relay frame that carries it already presents it. */
export interface GiteaStatusEdge {
  hookId: string
  agentId: string
  deliveryKey: string
  orgId: OrgId
  state: CodeHostNoteState
  reason?: string | null
  sessionId?: string
  gitea: GiteaHookMetadata | undefined
  snapshot: OptionalHookConfigSnapshot
  at: Date
}

export interface GiteaStatusCoordinatorDeps {
  projections: Pick<CodeHostRunProjectionRepo, 'upsert' | 'setDesired' | 'supersede'>
  /** The ACCEPTED run behind an edge — the only authority for its projection epoch. */
  runs: Pick<HookRepo, 'getRun'>
  agents: Pick<AgentRepo, 'getUnscoped'>
  bindings: Pick<GiteaRepositoryBindingRepo, 'byRepo'>
  connections: Pick<GiteaConnectionRepo, 'get'>
  clock: Pick<Clock, 'now'>
  /** Immediate wake-up only; the reporter's periodic scan is authoritative. */
  kick?: () => void
}

/** Converts hook-turn lifecycle edges to one current desired commit status; call each after its HookRun mutation commits. */
export class GiteaStatusCoordinator {
  constructor(private readonly deps: GiteaStatusCoordinatorDeps) {}

  /** Relay accepted the delivery: the turn is queued, and a newer head preempts older generations. */
  async afterAccepted(edge: GiteaStatusEdge): Promise<void> {
    await this.converge({ ...edge, state: 'queued' })
  }

  /** Delivery failed before any turn ran — the Control Plane can still say so, whatever kept the daemon away. */
  async afterDeliveryFailed(edge: GiteaStatusEdge): Promise<void> {
    await this.converge({ ...edge, state: 'skipped' })
  }

  /** The provider-neutral `hook/start` barrier crossed: the accepted turn is entering the prompt. */
  async afterStart(edge: GiteaStatusEdge): Promise<void> {
    await this.converge({ ...edge, state: 'running' })
  }

  /** Daemon terminal report: completed / failed / skipped / interrupted. */
  async afterReport(edge: GiteaStatusEdge): Promise<void> {
    await this.converge(edge)
  }

  private async converge(edge: GiteaStatusEdge): Promise<void> {
    const subject = giteaProjectionSubject(edge.gitea)
    if (!subject) return
    // A partially rolled-out dispatch tuple cannot authorize an effect, so it cannot open a projection either.
    const snapshot = completeSnapshot(edge.snapshot)
    if (!snapshot) return
    // The status IS the run report, so reporting `off` opens nothing — judged from the ACCEPTED snapshot.
    if (snapshot.reportingMode === 'off') return
    // The ACCEPTED run's epoch, never the live hook's: an edit mid-run would otherwise fork a new row.
    const run = await this.deps.runs.getRun(HookId(edge.hookId), edge.deliveryKey)
    if (!run || run.projectionEpoch === null) return
    const agent = await this.deps.agents.getUnscoped(AgentId(edge.agentId))
    if (!agent || agent.orgId !== edge.orgId) return
    // The binding names the connection the status is written as; a binding mid-removal writes nothing new.
    const binding = await this.deps.bindings.byRepo(edge.orgId, subject.projectId)
    if (!binding || binding.state === 'cleanup_pending') return
    const connection = await this.deps.connections.get(edge.orgId, binding.connectionId)
    if (!connection) return

    // The run's acceptance ranks its head on the pull request: the same on every edge, so a late edge of an older head outranks nothing.
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
    // Null ⇒ the hook was retired under the lifecycle fence while this edge was in flight.
    if (!projection || projection.tombstonedAt) return
    // The row already belongs to a newer run of this head: an older delivery's edge moves nothing.
    if (projection.currentDeliveryKey !== edge.deliveryKey) return
    // The newest accepted head preempts every older one, this head's own row included when a newer head is already here.
    await this.deps.projections.supersede(
      HookId(edge.hookId),
      subject.projectId,
      subject.mergeRequestIid,
      subject.headSha,
      edge.at,
      acceptedAt
    )
    // The upsert parks an edge that landed mid-write; the reporter drains it once that write settles.
    if (projection.writePhase !== null) return
    // A late queued/running edge loses against the terminal authority that sealed the generation; a superseded row refuses every edge.
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

export interface GiteaStatusReporterLog {
  info(obj: unknown, msg?: string): void
  warn?(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface GiteaStatusReporterDeps {
  projections: Pick<
    CodeHostRunProjectionWriterRepo,
    'claimDue' | 'beginWrite' | 'completeWrite' | 'retryWrite' | 'blockWrite' | 'settleWrite' | 'advancePending' | 'get'
  >
  bindings: Pick<GiteaRepositoryBindingRepo, 'byRepo'>
  connections: Pick<GiteaConnectionRepo, 'get'>
  /** The connection token, and the §4.3 path a definite rejection takes. */
  tokens: GiteaTokenSource
  orgs?: Pick<OrgRepo, 'slugById'>
  api: GiteaApiClient
  clock: Clock
  /** Console origin for the ordinary authenticated session link; unset ⇒ the status carries no link. */
  webAppUrl?: string
  workerId?: string
  intervalMs?: number
  leaseMs?: number
  batchSize?: number
  pageSize?: number
  log?: GiteaStatusReporterLog
}

/** Durable periodic worker for one commit status per projection row (§10.4). */
export class GiteaStatusReporter {
  private readonly workerId: string
  private readonly intervalMs: number
  private readonly leaseMs: number
  private readonly batchSize: number
  private timer: TimerHandle | undefined
  private started = false
  private running = false
  private rerunRequested = false

  constructor(private readonly deps: GiteaStatusReporterDeps) {
    this.workerId = deps.workerId ?? `gitea-status-reporter:${randomUUID()}`
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
            // An unexpected worker bug must not strand the lease; `writePhase` decides whether the retry is reconcile-only.
            await this.retry(
              projection,
              'worker_error',
              projection.writeMarker !== null || projection.writePhase !== null
            )
            this.deps.log?.error(
              { err, projectionId: projection.id, generation: projection.generation.toString() },
              'gitea-status-reporter: projection failed'
            )
          }
        }
        if (claimed.length === this.batchSize) this.rerunRequested = true
      } while (this.rerunRequested)
    } catch (err) {
      this.deps.log?.error({ err }, 'gitea-status-reporter: claim failed')
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
    if (!isGiteaProjectionState(row.desiredState)) {
      await this.blockOrHold(row, 'invalid_state')
      return
    }
    const inFlight = row.writeMarker !== null || row.writePhase !== null
    // Observed already, nothing in flight: drain a parked edge into its own generation, or leave the due set.
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

    const binding = await this.deps.bindings.byRepo(row.orgId, row.projectId)
    const connection = binding ? await this.deps.connections.get(row.orgId, binding.connectionId) : null
    const repo = binding ? splitGiteaRepoPath(binding.repoPath) : null
    if (!binding || !connection || !repo) {
      await this.blockOrHold(row, 'repo_authorization')
      return
    }
    let token: string
    try {
      token = await this.deps.tokens.withToken(row.orgId, connection.id)
    } catch (err) {
      // A rejected token is waiting on its replacement; the row stays due and never loses a held marker.
      await this.retry(row, err instanceof GiteaConnectDenied ? err.code : 'token_unavailable', inFlight)
      return
    }
    const where = { owner: repo.owner, repo: repo.repo, token, botUserId: connection.botUserId }

    if (row.writeMarker && row.writePhase) {
      await this.reconcileAmbiguous(row, where)
      return
    }

    // Keep every fallible local read before the write marker; after it, only the one mutation or a reconcile may follow.
    const spec = giteaStatusSpec(row, await this.consoleUrl(row))
    const marker = randomUUID()
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
      const created = await giteaCreateCommitStatus(token, where.owner, where.repo, row.headSha, spec, this.deps.api)
      await this.finish(row, marker, String(created.id))
    } catch (err) {
      await this.handleWriteError(row, err, connection.id)
    }
  }

  /** Proven by a newer row than last observed with the sent state and description; absent past the grace window, it never landed. */
  private async reconcileAmbiguous(
    row: CodeHostRunProjectionRecord,
    where: { owner: string; repo: string; token: string; botUserId: bigint }
  ): Promise<void> {
    const spec = giteaStatusSpec(row, await this.consoleUrl(row))
    let statuses: GiteaCommitStatus[]
    try {
      statuses = await giteaListCommitStatuses(
        where.token,
        where.owner,
        where.repo,
        row.headSha,
        this.deps.api,
        this.deps.pageSize ?? GITEA_DEFAULT_PAGE_SIZE
      )
    } catch (err) {
      // Even a definite GET failure says nothing about the earlier mutation: the marker stays.
      await this.retry(row, errorLabel(err, 'reconcile_failed'), true)
      return
    }
    const lastObserved = row.noteId && /^\d+$/.test(row.noteId) ? BigInt(row.noteId) : -1n
    const landed = statuses
      .filter((status) => statusIdOf(status) !== null && statusIdOf(status)! > lastObserved)
      .filter((status) => status.context === spec.context)
      .filter((status) => status.creator?.id === undefined || String(status.creator.id) === where.botUserId.toString())
      .find((status) => status.status === spec.state && status.description === spec.description)
    if (landed) {
      await this.finish(row, row.writeMarker!, statusIdOf(landed)!.toString())
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
      noteId: statusId,
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

  private async handleWriteError(row: CodeHostRunProjectionRecord, err: unknown, connectionId: string): Promise<void> {
    if (isGiteaAuthRejection(err)) {
      // A received rejection is a definite non-effect; the connection's §4.3 path degrades the bindings.
      await this.deps.tokens.onAuthRejected(row.orgId, connectionId).catch(() => undefined)
      await this.retry(row, 'token_rejected', false)
      return
    }
    if (err instanceof GiteaApiError && err.code === 'RATE_LIMITED') {
      await this.retry(row, 'rate_limited', false, 60_000)
      return
    }
    if (err instanceof GiteaApiError && !err.retryable && err.status !== 0) {
      // A received non-retryable response proves this request did not mutate.
      await this.deps.projections.blockWrite(row.id, row.generation, errorLabel(err, 'gitea_write_denied'))
      return
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
      return `${base}/sessions/${encodeURIComponent(row.sessionId)}?source=gitea`
    } catch (err) {
      // A console-link lookup must never block the authoritative projection.
      this.deps.log?.warn?.({ err, projectionId: row.id }, 'gitea-status-reporter: console link lookup failed')
      return undefined
    }
  }
}

function statusIdOf(status: GiteaCommitStatus): bigint | null {
  const raw = String(status.id)
  return /^\d+$/.test(raw) ? BigInt(raw) : null
}

function errorLabel(err: unknown, fallback: string): string {
  return err instanceof GiteaApiError ? err.code.toLowerCase() : fallback
}
