/**
 * Durable, CP-owned GitHub Checks projection for GitHub hook reviews (R2a).
 *
 * The coordinator translates the authoritative HookRun lifecycle into a
 * metadata-only desired state. The worker is an outbox consumer: every write is
 * fenced by (projection id, generation), a lease, and a durable write marker.
 * A request whose outcome is ambiguous is never replayed; later passes only
 * reconcile the existing marker from GitHub.
 *
 * No webhook body, agent answer, inline-review body, or raw failure reason is
 * accepted by this module. Check output is deliberately derived from normalized
 * projection metadata only.
 */
import { randomUUID } from 'node:crypto'
import { GITHUB_REQUEST_REVIEW_ACTION } from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '../domain/clock.js'
import { OrgId, type HookId } from '../domain/ids.js'
import type {
  AgentRepo,
  HookRepo,
  HookReviewProjectionRecord,
  HookReviewSubjectRecord,
  HookRunRecord,
  OrgRepo
} from '../persistence/ports.js'
import { githubRequest, GithubApiError, type FetchLike } from './api.js'
import {
  authoritativeHookProjectionState,
  hookRuntimeProjectionState,
  hookSkippedCheckGuidance,
  hookSkippedCheckLabel,
  type ProjectionDesiredState
} from './projection-state.js'
import { GithubService, GitCredDeniedError } from './service.js'

const CHECK_NAME = 'AgentConnect PR Review'
const LEGACY_CHECK_NAME_PREFIX = 'agentconnect/info/review/'
const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_LEASE_MS = 30_000
const DEFAULT_BATCH_SIZE = 25
const MAX_RECOVERY_PAGES = 10
const MAX_ASSOCIATION_PAGES = 10
const ASSOCIATION_PAGE_SIZE = 100
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 5 * 60_000

const CHECK_OUTPUT_TITLE: Record<ProjectionDesiredState, string> = {
  queued: 'Waiting for review',
  in_progress: 'Analyzing this revision',
  success: 'No blocking findings',
  action_required: 'Review findings need attention',
  neutral: 'No blocking verdict',
  skipped: 'Review was not run',
  failure: 'Review could not be completed',
  timed_out: 'Review exceeded its time limit'
}

const REVISION_NOT_CURRENT_TITLE = 'Revision is no longer current'
const ASSOCIATION_ATTENTION_TITLE = 'Pull request association needs attention'

const TERMINAL_CHECK_STATES = new Set<string>([
  'success',
  'action_required',
  'neutral',
  'skipped',
  'failure',
  'timed_out'
])

interface PendingProjectionIntent {
  desiredState: string
  currentHookRunId?: string | null
  nextAttemptAt?: string
}

interface CheckRunResponse {
  id: string
  external_id: string | null
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  output?: { summary?: string | null } | null
}

interface CheckRunsResponse {
  total_count: number
  check_runs: CheckRunResponse[]
}

interface AssociatedPullResponse {
  number: number
  state: string
  head: { sha: string } | null
  base: { sha: string } | null
}

type SubjectAssociationErrorCode =
  'pr_association_incomplete' | 'no_current_pull_request' | 'stale_head' | 'shared_head_multiple_prs'

interface SubjectAssociationResult {
  synchronized: boolean
  errorCode: SubjectAssociationErrorCode | null
}

/** One `Request review`-style button GitHub renders on the Check. */
interface CheckAction {
  label: string
  description: string
  identifier: string
}

interface CheckPresentation {
  detailsUrl?: string
  agentUrl?: string
  publication?: { pullNumber: number; url: string }
  skippedLabel?: string
  /** Markdown appended to the summary; Checks-tab only, unlike the title. */
  skippedGuidance?: string
  requestReviewAction?: boolean
}

/** A head GitHub no longer presents was superseded, not a human's problem. Cleanup is exempt:
 *  organization deletion settles a tombstone only on a durably non-passing Check. */
function associationBlockedState(code: SubjectAssociationErrorCode, tombstoned: boolean): ProjectionDesiredState {
  if (tombstoned) return 'action_required'
  return code === 'stale_head' || code === 'no_current_pull_request' ? 'neutral' : 'action_required'
}

export interface GithubRunReporterLog {
  info(obj: unknown, msg?: string): void
  warn?(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface GithubRunCoordinatorDeps {
  hooks: Pick<
    HookRepo,
    | 'getRun'
    | 'listRunsNeedingReviewProjection'
    | 'upsertReviewProjection'
    | 'bindRunProjection'
    | 'setProjectionDesired'
    | 'upsertReviewSubject'
  >
  agents: Pick<AgentRepo, 'getUnscoped'>
  clock: Clock
  /** Immediate wake-up only; the worker's periodic scan is authoritative. */
  kick?: () => void
}

/**
 * Converts HookRun lifecycle edges to one current informational Check intent.
 * Call each method only after its corresponding HookRepo mutation commits.
 */
export class GithubRunCoordinator {
  constructor(private readonly deps: GithubRunCoordinatorDeps) {}

  /**
   * Rebuild lifecycle edges that committed before the process crashed but whose
   * projection convergence did not. The repository returns only the newest
   * current revision per hook/repo/SHA and only when its projection is missing
   * or stale, so a periodic scan is both bounded and idempotent.
   */
  async repair(limit = 100): Promise<number> {
    const runs = await this.deps.hooks.listRunsNeedingReviewProjection(limit)
    for (const run of runs) {
      const desired = authoritativeHookProjectionState(run)
      if (desired) await this.converge(run, desired, false, true)
    }
    return runs.length
  }

  /** Relay accepted a delivery. Only a trusted revision event opens `queued`. */
  async afterAccepted(hookId: HookId, deliveryKey: string): Promise<void> {
    const run = await this.deps.hooks.getRun(hookId, deliveryKey)
    if (!run || run.status !== 'running' || run.projectionIntent !== 'revision_event') return
    await this.converge(run, 'queued', true)
  }

  /** Daemon crossed the acknowledged start barrier. */
  async afterStart(hookId: HookId, deliveryKey: string): Promise<void> {
    const run = await this.deps.hooks.getRun(hookId, deliveryKey)
    if (!run || run.status !== 'running' || run.projectionIntent !== 'revision_event') return
    await this.converge(run, 'in_progress', true)
  }

  /** A formal review effect was durably correlated to this exact HookRun. */
  async afterReviewResult(hookId: HookId, deliveryKey: string): Promise<void> {
    const run = await this.deps.hooks.getRun(hookId, deliveryKey)
    if (!run || run.reviewAttemptState !== 'submitted') return
    const desired = reviewDesiredState(run)
    if (!desired) return
    // Informational R2a may project a definitive review_action_only verdict.
    // Such turns never open queued/in_progress state. COMMENT + neutral is a
    // conversational/non-verdict review and must not replace the current
    // revision's existing pass/fail projection.
    if (run.projectionIntent !== 'revision_event' && run.projectionIntent !== 'review_action_only') return
    await this.converge(run, desired, true)
  }

  /** Daemon terminal report. A submitted review verdict is sealed over runtime outcome. */
  async afterReport(hookId: HookId, deliveryKey: string): Promise<void> {
    const run = await this.deps.hooks.getRun(hookId, deliveryKey)
    if (!run) return
    const reviewState = run.reviewAttemptState === 'submitted' ? reviewDesiredState(run) : null
    if (run.projectionIntent === 'review_action_only' && !reviewState) return
    if (run.projectionIntent !== 'revision_event' && run.projectionIntent !== 'review_action_only') return
    const desired: ProjectionDesiredState =
      reviewState ?? (run.reviewErrorCode ? 'failure' : hookRuntimeProjectionState(run)) ?? 'failure'
    await this.converge(run, desired, true)
  }

  private async converge(
    run: HookRunRecord,
    desiredState: ProjectionDesiredState,
    kickWorker: boolean,
    forceConverge = false
  ): Promise<void> {
    // R2a publishes Checks only, and only under the informational context. `off`
    // is not an outbox intent; status/required snapshots fail closed here and in
    // the worker in case an older binary persisted one.
    if (run.reportingModeSnapshot !== 'check' || run.gateModeSnapshot !== 'informational') return
    if (
      !run.agentId ||
      !run.repoId ||
      !run.repoFullName ||
      !run.reportSha ||
      run.subjectKind !== 'pull_request' ||
      run.pullNumber === null ||
      !run.headSha ||
      !run.baseSha ||
      run.configRevision === null ||
      run.projectionEpoch === null ||
      run.dispatchRevision === null ||
      !run.dispatchDaemonId
    )
      return

    const agent = await this.deps.agents.getUnscoped(run.agentId)
    if (!agent) return
    const now = new Date(this.deps.clock.now())
    const projection = await this.deps.hooks.upsertReviewProjection({
      hookId: run.hookId,
      orgId: agent.orgId,
      agentId: run.agentId,
      agentName: agent.name,
      repoId: run.repoId,
      repoFullName: run.repoFullName,
      headSha: run.headSha,
      reportSha: run.reportSha,
      projectionEpoch: run.projectionEpoch,
      mode: 'check',
      gateMode: 'informational',
      desiredState,
      currentHookRunId: run.id,
      nextAttemptAt: now
    })
    // Repository tombstones are irreversible cleanup intent. This guard is
    // deliberately duplicated with PgHookRepo so alternate/fake ports cannot
    // bind a delayed run or overwrite its cleanup-only desired state.
    if (projection.tombstonedAt) return

    // A write already in flight stores this lifecycle edge as pendingIntent.
    // Binding the new run to the old generation would let its completion race
    // that generation, so bind only after it is the projection's current run.
    const pendingRunId = parsePendingIntent(projection.pendingIntent)?.currentHookRunId
    if (
      projection.currentHookRunId !== run.id ||
      (pendingRunId !== undefined && pendingRunId !== null && pendingRunId !== run.id)
    ) {
      if (kickWorker) this.deps.kick?.()
      return
    }
    await this.deps.hooks.bindRunProjection(run.hookId, run.deliveryKey, projection.id, projection.generation)
    if (run.pullNumber !== null && run.headSha) {
      await this.deps.hooks.upsertReviewSubject({
        projectionId: projection.id,
        pullNumber: run.pullNumber,
        headSha: run.headSha,
        baseSha: run.baseSha,
        isOpen: true
      })
    }
    // Duplicate accepted/start notifications must not regress a sealed review
    // verdict. Normal WS order is accepted -> start -> result -> report; this
    // check also makes delayed duplicate edges harmless.
    const mayConverge = !(isTerminalDesiredState(projection.desiredState) && !isTerminalDesiredState(desiredState))
    if (mayConverge && (forceConverge || projection.desiredState !== desiredState)) {
      await this.deps.hooks.setProjectionDesired(projection.id, projection.generation, desiredState, now, run.id)
    }
    if (kickWorker) this.deps.kick?.()
  }
}

export interface GithubRunReporterDeps {
  hooks: Pick<
    HookRepo,
    | 'claimDueReviewProjections'
    | 'beginProjectionWrite'
    | 'completeProjectionWrite'
    | 'advancePendingReviewProjection'
    | 'retryProjectionWrite'
    | 'blockProjection'
    | 'settleReviewProjection'
    | 'getReviewProjection'
    | 'listReviewSubjects'
    | 'synchronizeReviewSubjects'
    | 'refreshReviewProjectionTarget'
    | 'getRunById'
  >
  agents: Pick<AgentRepo, 'getUnscoped'>
  orgs?: Pick<OrgRepo, 'slugById'>
  /** Console origin used for Check Run links; unset keeps GitHub's default App link. */
  webAppUrl?: string
  /** GITHUB_APP_SLUG — the `@<slug>` handle a maintainer mentions to summon a
   * review. Unset keeps the Check copy handle-free. */
  appSlug?: string
  github: Pick<
    GithubService,
    | 'mintChecksForAgent'
    | 'mintChecksForProjectionCleanup'
    | 'invalidateInstallationTokens'
    | 'refreshInstallationFacts'
  >
  clock: Clock
  workerId?: string
  intervalMs?: number
  leaseMs?: number
  batchSize?: number
  fetchImpl?: FetchLike
  baseUrl?: string
  log?: GithubRunReporterLog
  /** Durable HookRun-to-projection repair, invoked before every periodic claim. */
  repair?: () => Promise<unknown>
}

/** Durable periodic worker for one informational Check projection per hook/SHA. */
export class GithubRunReporter {
  private readonly workerId: string
  private readonly intervalMs: number
  private readonly leaseMs: number
  private readonly batchSize: number
  private timer: TimerHandle | undefined
  private started = false
  private running = false
  private rerunRequested = false

  constructor(private readonly deps: GithubRunReporterDeps) {
    this.workerId = deps.workerId ?? `github-run-reporter:${randomUUID()}`
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
      if (this.deps.repair) {
        try {
          await this.deps.repair()
        } catch (err) {
          // Existing durable projection work remains safe to process even when
          // the repair scan itself is temporarily unavailable.
          this.deps.log?.error({ err }, 'github-run-reporter: repair scan failed')
        }
      }
      do {
        this.rerunRequested = false
        const now = new Date(this.deps.clock.now())
        const claimed = await this.deps.hooks.claimDueReviewProjections(
          this.workerId,
          now,
          new Date(now.getTime() + this.leaseMs),
          this.batchSize
        )
        for (const projection of claimed) {
          try {
            await this.process(projection)
          } catch (err) {
            // An unexpected worker bug must not strand the lease forever. No
            // request is repeated here; `writePhase` decides whether the retry
            // is a reconcile-only pass.
            await this.retry(
              projection,
              'worker_error',
              projection.writeMarker !== null || projection.writePhase !== null
            )
            this.deps.log?.error(
              { err, projectionId: projection.id, generation: projection.generation.toString() },
              'github-run-reporter: projection failed'
            )
          }
        }
        if (claimed.length === this.batchSize) this.rerunRequested = true
      } while (this.rerunRequested)
    } catch (err) {
      this.deps.log?.error({ err }, 'github-run-reporter: claim failed')
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

  private async process(projection: HookReviewProjectionRecord): Promise<void> {
    if (projection.mode !== 'check' || projection.gateMode !== 'informational') {
      await this.blockOrHoldAmbiguous(projection, 'unsupported_mode')
      return
    }
    if (!isDesiredState(projection.desiredState)) {
      await this.blockOrHoldAmbiguous(projection, 'invalid_state')
      return
    }
    if (
      projection.tombstonedAt !== null &&
      projection.writeMarker === null &&
      projection.writePhase === null &&
      projection.desiredState !== 'neutral' &&
      projection.desiredState !== 'failure'
    ) {
      // A tombstone is cleanup-only authority. A pending cleanup serialized
      // behind an older write may now be advanced, but corrupt/late passing or
      // nonterminal state can never mint a new external mutation.
      const pending = parsePendingIntent(projection.pendingIntent)
      if (pending && (pending.desiredState === 'neutral' || pending.desiredState === 'failure')) {
        await this.advancePending(projection)
      } else {
        await this.deps.hooks.blockProjection(projection.id, projection.generation, 'invalid_tombstone_state')
      }
      return
    }
    if (
      projection.observedState === projection.desiredState &&
      projection.writePhase === null &&
      projection.pendingIntent !== null
    ) {
      await this.advancePending(projection)
      return
    }
    // Settled: GitHub already shows the desired state, no write is in flight, and no newer
    // intent is queued. Everything below this point mints a token and writes a Check, so a row
    // that reaches it with nothing to say re-publishes what is already there. Leave the due set
    // instead — the claim is a bounded FIFO, and rows that never leave it starve the real work
    // behind them.
    if (
      projection.observedState === projection.desiredState &&
      projection.writePhase === null &&
      projection.writeMarker === null &&
      projection.pendingIntent === null
    ) {
      await this.deps.hooks.settleReviewProjection(projection.id, projection.generation, this.workerId)
      return
    }
    const settledAssociationError =
      projection.subjectSyncGeneration === projection.generation
        ? asSubjectAssociationError(projection.subjectSyncErrorCode)
        : null
    if (
      settledAssociationError &&
      projection.observedState === associationBlockedState(settledAssociationError, projection.tombstonedAt !== null) &&
      projection.writePhase === null &&
      projection.writeMarker === null
    ) {
      // A crash may leave a newer intent pending after the deliberately
      // non-matching observed state was durably completed. Advance it without
      // repeating the old Check write; otherwise merely release a doorbell
      // wake. Only the next generation performs another association read.
      if (projection.pendingIntent !== null) await this.advancePending(projection)
      else await this.deps.hooks.blockProjection(projection.id, projection.generation, settledAssociationError)
      return
    }

    const agent = await this.deps.agents.getUnscoped(projection.agentId)
    let token: string
    let repoFullName: string
    let resolvedRepoId: bigint
    let installationId: bigint
    try {
      // Tombstone is one-way cleanup authority. It takes precedence even while
      // the Agent row still exists (for example, a per-repository grant was
      // revoked); normal agent authorization must never be consulted again.
      if (projection.tombstonedAt) {
        const minted = await this.deps.github.mintChecksForProjectionCleanup(
          OrgId(projection.orgId),
          projection.repoId,
          projection.repoFullName
        )
        token = minted.cred.token
        repoFullName = minted.repoFullName
        resolvedRepoId = minted.repoId
        installationId = minted.installation.installationId
      } else if (agent && agent.orgId === projection.orgId) {
        const minted = await this.deps.github.mintChecksForAgent(agent, projection.repoId, projection.repoFullName)
        token = minted.cred.token
        repoFullName = minted.resolved.repoFullName
        resolvedRepoId = minted.resolved.repoId
        installationId = minted.resolved.installation.installationId
      } else {
        await this.blockOrHoldAmbiguous(projection, 'repo_authorization')
        return
      }
    } catch (err) {
      await this.handlePreWriteError(projection, err)
      return
    }
    const [owner, repo] = repoFullName.split('/')
    if (!owner || !repo || resolvedRepoId !== projection.repoId) {
      await this.blockOrHoldAmbiguous(projection, 'repo_identity')
      return
    }
    if (projection.repoFullName !== repoFullName || projection.lastResolvedInstallationId !== installationId) {
      const refreshed = await this.deps.hooks.refreshReviewProjectionTarget(
        projection.id,
        projection.generation,
        repoFullName,
        installationId
      )
      if (!refreshed) return
    }

    if (projection.writeMarker && projection.writePhase) {
      await this.reconcileAmbiguous(projection, token, owner, repo, installationId)
      return
    }

    let effectiveState = projection.desiredState as ProjectionDesiredState
    let associationError: SubjectAssociationErrorCode | null = null
    if (isTerminalDesiredState(projection.desiredState)) {
      const association = await this.ensureTerminalAssociation(projection, token, owner, repo)
      if (!association.synchronized) return
      associationError = association.errorCode
      if (associationError) {
        effectiveState = associationBlockedState(associationError, projection.tombstonedAt !== null)
      }
    }

    // Keep every fallible local read before the write marker. Once the marker
    // exists, only a GitHub mutation or reconcile-only recovery may follow.
    const subjects = await this.deps.hooks.listReviewSubjects(projection.id)
    const presentation = await this.checkPresentation(projection, agent?.orgId === projection.orgId)

    const marker = randomUUID()
    const phase = projection.checkRunId ? 'update' : 'create'
    if (
      !(await this.deps.hooks.beginProjectionWrite(
        projection.id,
        projection.generation,
        this.workerId,
        marker,
        phase,
        new Date(this.deps.clock.now())
      ))
    )
      return

    const payload = checkPayload(
      projection,
      marker,
      new Date(this.deps.clock.now()),
      subjects,
      effectiveState,
      associationError,
      presentation
    )
    try {
      if (projection.checkRunId) {
        await githubRequest<CheckRunResponse>(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${encodeURIComponent(projection.checkRunId)}`,
          {
            method: 'PATCH',
            auth: token,
            body: { name: checkName(projection), ...payload },
            fetchImpl: this.deps.fetchImpl,
            baseUrl: this.deps.baseUrl,
            bigIdsAsStrings: true
          }
        )
        await this.finish(projection, marker, projection.checkRunId, installationId, effectiveState, associationError)
      } else {
        const created = await githubRequest<CheckRunResponse>(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs`,
          {
            method: 'POST',
            auth: token,
            body: {
              // One write settles the Check completely. The create used to
              // publish a legacy recovery name and repair it afterwards, but
              // GitHub replaces `actions` on every update, so that second
              // request had to carry presentation — which made a cosmetic,
              // fence-free write into a stateful one racing the next
              // generation. Naming the Check correctly up front removes the
              // second write, and with it the race. `findCreatedCheck` still
              // reads the legacy name so creates already in flight from an
              // earlier binary stay recoverable.
              name: checkName(projection),
              head_sha: projection.reportSha,
              external_id: projection.externalId,
              ...payload
            },
            fetchImpl: this.deps.fetchImpl,
            baseUrl: this.deps.baseUrl,
            bigIdsAsStrings: true
          }
        )
        const checkRunId = String(created.id)
        await this.finish(projection, marker, checkRunId, installationId, effectiveState, associationError)
      }
    } catch (err) {
      await this.handleWriteError(projection, err, installationId)
    }
  }

  private async checkPresentation(
    projection: HookReviewProjectionRecord,
    hasLiveAgent: boolean
  ): Promise<CheckPresentation> {
    let run: HookRunRecord | null = null
    if (projection.currentHookRunId) {
      let candidate: HookRunRecord | null = null
      try {
        candidate = await this.deps.hooks.getRunById(projection.currentHookRunId)
      } catch (err) {
        // For skipped projections this read selects semantic Check output. Retry
        // before beginProjectionWrite instead of settling a generic title that
        // would never be repaired for this generation. Other states only lose
        // their best-effort session link and may continue.
        if (projection.desiredState === 'skipped') throw err
      }
      if (
        candidate?.hookId === projection.hookId &&
        candidate.agentId === projection.agentId &&
        candidate.repoId === projection.repoId &&
        candidate.reportSha === projection.reportSha &&
        candidate.projectionEpoch === projection.projectionEpoch
      )
        run = candidate
    }
    const skippedLabel = hookSkippedCheckLabel(run?.reason, this.deps.appSlug) ?? undefined
    const skippedGuidance = hookSkippedCheckGuidance(run?.reason, this.deps.appSlug) ?? undefined
    const requestReviewAction =
      projection.tombstonedAt === null && TERMINAL_CHECK_STATES.has(projection.desiredState) ? true : undefined
    const publication = run ? checkPublication(projection.repoFullName, run) : undefined
    const fallback = {
      ...(publication ? { publication } : {}),
      ...(skippedLabel ? { skippedLabel } : {}),
      ...(skippedGuidance ? { skippedGuidance } : {}),
      ...(requestReviewAction ? { requestReviewAction } : {})
    }
    if (!this.deps.webAppUrl || !this.deps.orgs) return fallback
    try {
      const orgSlug = await this.deps.orgs.slugById(projection.orgId)
      if (!orgSlug) return fallback
      const base = `${this.deps.webAppUrl.replace(/\/+$/, '')}/${encodeURIComponent(orgSlug)}`
      const agentUrl = hasLiveAgent ? `${base}/agents/${encodeURIComponent(projection.agentId)}` : undefined
      const detailsUrl = run?.sessionId
        ? `${base}/sessions/${encodeURIComponent(run.sessionId)}?source=github`
        : undefined
      return {
        ...(detailsUrl ? { detailsUrl } : {}),
        ...(agentUrl ? { agentUrl } : {}),
        ...fallback
      }
    } catch {
      // A console-link lookup must never block the authoritative GitHub projection.
      return fallback
    }
  }

  /**
   * Read the complete live commit association before any terminal mutation.
   * The result is persisted once per projection generation; retries after a
   * definite write failure reuse that snapshot, while a newer generation
   * necessarily re-evaluates GitHub.
   */
  private async ensureTerminalAssociation(
    projection: HookReviewProjectionRecord,
    token: string,
    owner: string,
    repo: string
  ): Promise<SubjectAssociationResult> {
    if (projection.subjectSyncGeneration === projection.generation) {
      return {
        synchronized: true,
        errorCode: asSubjectAssociationError(projection.subjectSyncErrorCode)
      }
    }

    let currentPulls: AssociatedPullResponse[] | null = null
    let errorCode: SubjectAssociationErrorCode | null = null
    try {
      const encodedRepo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      const pulls = await this.readAssociatedPullPages(
        `${encodedRepo}/commits/${encodeURIComponent(projection.headSha)}/pulls`,
        token
      )
      if (pulls === null) {
        errorCode = 'pr_association_incomplete'
      } else {
        const openPulls = dedupeAssociatedPulls(pulls.filter((pull) => pull.state === 'open'))
        if (openPulls.length === 0) {
          // The base-repository commit endpoint returns no association for some fork heads.
          const repoPulls = await this.readAssociatedPullPages(`${encodedRepo}/pulls`, token, 'state=open')
          if (repoPulls === null) {
            errorCode = 'pr_association_incomplete'
          } else {
            currentPulls = dedupeAssociatedPulls(
              repoPulls.filter((pull) => pull.state === 'open' && pull.head?.sha === projection.headSha)
            )
            if (currentPulls.length === 0) errorCode = 'no_current_pull_request'
            else if (currentPulls.length > 1) errorCode = 'shared_head_multiple_prs'
          }
        } else {
          currentPulls = openPulls.filter((pull) => pull.head?.sha === projection.headSha)
          if (currentPulls.length === 0) errorCode = 'stale_head'
          else if (currentPulls.length > 1) errorCode = 'shared_head_multiple_prs'
        }
      }
    } catch (err) {
      // A partial page set (including a transport/API failure mid-scan) is not
      // authoritative enough to close stale subjects. Persist the normalized
      // fail-closed result and still attempt a non-passing informational Check.
      errorCode = 'pr_association_incomplete'
      this.deps.log?.warn?.(
        { err, projectionId: projection.id, generation: projection.generation.toString() },
        'github-run-reporter: PR association read incomplete'
      )
    }

    const synchronized = await this.deps.hooks.synchronizeReviewSubjects(
      projection.id,
      projection.generation,
      currentPulls?.map((pull) => ({
        pullNumber: pull.number,
        headSha: pull.head!.sha,
        baseSha: pull.base?.sha ?? null
      })) ?? null,
      errorCode
    )
    return { synchronized, errorCode }
  }

  private async readAssociatedPullPages(
    path: string,
    token: string,
    query?: string
  ): Promise<AssociatedPullResponse[] | null> {
    const pulls: AssociatedPullResponse[] = []
    for (let page = 1; page <= MAX_ASSOCIATION_PAGES; page++) {
      const batch = await githubRequest<AssociatedPullResponse[]>(
        `${path}?${query ? `${query}&` : ''}per_page=${ASSOCIATION_PAGE_SIZE}&page=${page}`,
        { auth: token, fetchImpl: this.deps.fetchImpl, baseUrl: this.deps.baseUrl }
      )
      if (!Array.isArray(batch) || batch.some((pull) => !isAssociatedPullResponse(pull))) return null
      pulls.push(...batch)
      if (batch.length < ASSOCIATION_PAGE_SIZE) return pulls
    }
    return null
  }

  private async reconcileAmbiguous(
    projection: HookReviewProjectionRecord,
    token: string,
    owner: string,
    repo: string,
    installationId: bigint
  ): Promise<void> {
    const marker = projection.writeMarker!
    try {
      let recovered: CheckRunResponse | null = null
      if (projection.checkRunId) {
        const remote = await githubRequest<CheckRunResponse>(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${encodeURIComponent(projection.checkRunId)}`,
          {
            auth: token,
            fetchImpl: this.deps.fetchImpl,
            baseUrl: this.deps.baseUrl,
            bigIdsAsStrings: true
          }
        )
        if (hasWriteMarker(remote, marker)) recovered = remote
      } else {
        recovered = await this.findCreatedCheck(projection, marker, token, owner, repo)
      }
      if (recovered) {
        const recoveredState = recoveredWriteState(recovered, marker)
        if (!recoveredState) {
          // The marker proves that GitHub observed this request, but the state
          // bound to that marker is the only safe observed value. The
          // projection's desired state may have advanced while the original
          // response was lost; treating that newer value as observed would
          // clear the mutex without ever writing it remotely.
          await this.retry(projection, 'ambiguous_write_state', true)
          return
        }
        const associationError = asSubjectAssociationError(
          projection.subjectSyncGeneration === projection.generation ? projection.subjectSyncErrorCode : null
        )
        const checkRunId = String(recovered.id)
        // Recovery settles the projection against what GitHub observed and
        // writes nothing further. A create publishes its final name and
        // actions in one request, so there is no repair left to perform — and
        // this path must not invent presentation it did not compute.
        await this.finish(projection, marker, checkRunId, installationId, recoveredState, associationError)
        return
      }
      // GitHub list/get can lag an accepted mutation. Preserve the mutex and
      // reconcile again after backoff; never issue another POST/PATCH.
      await this.retry(projection, 'ambiguous_write', true)
    } catch (err) {
      // Even a definite GET failure says nothing about the earlier mutation.
      // Once a write marker exists, preserving it takes precedence over normal
      // auth/error classification.
      if (err instanceof GithubApiError && (err.status === 401 || err.status === 403 || err.status === 422)) {
        this.deps.github.invalidateInstallationTokens(installationId)
        await this.deps.github
          .refreshInstallationFacts(installationId)
          .catch((refreshError) =>
            this.deps.log?.warn?.(
              { err: refreshError, installationId: installationId.toString() },
              'github-run-reporter: reconcile facts refresh failed'
            )
          )
      }
      await this.retry(projection, errorLabel(err, 'reconcile_failed'), true)
    }
  }

  private async findCreatedCheck(
    projection: HookReviewProjectionRecord,
    marker: string,
    token: string,
    owner: string,
    repo: string
  ): Promise<CheckRunResponse | null> {
    // Creates publish the display name directly. The legacy recovery name is
    // still searched so a POST left in flight by an earlier binary — which
    // named its creates `agentconnect/info/review/<hookId>` and repaired the
    // label afterwards — stays recoverable across the upgrade.
    for (const candidate of [checkName(projection), legacyCheckName(projection)]) {
      const found = await this.findCreatedCheckByName(projection, marker, token, owner, repo, candidate)
      if (found) return found
    }
    return null
  }

  private async findCreatedCheckByName(
    projection: HookReviewProjectionRecord,
    marker: string,
    token: string,
    owner: string,
    repo: string,
    checkRunName: string
  ): Promise<CheckRunResponse | null> {
    const name = encodeURIComponent(checkRunName)
    for (let page = 1; page <= MAX_RECOVERY_PAGES; page++) {
      const response = await githubRequest<CheckRunsResponse>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(projection.reportSha)}/check-runs?check_name=${name}&filter=all&per_page=100&page=${page}`,
        {
          auth: token,
          fetchImpl: this.deps.fetchImpl,
          baseUrl: this.deps.baseUrl,
          bigIdsAsStrings: true
        }
      )
      const recovered = response.check_runs.find(
        (run) => run.external_id === projection.externalId && hasWriteMarker(run, marker)
      )
      if (recovered) return recovered
      if (response.check_runs.length < 100) return null
    }
    // A capped/incomplete recovery read is not evidence of no effect.
    return null
  }

  private async finish(
    projection: HookReviewProjectionRecord,
    marker: string,
    checkRunId: string,
    installationId: bigint,
    observedState: ProjectionDesiredState = projection.desiredState as ProjectionDesiredState,
    settledErrorCode: SubjectAssociationErrorCode | null = null
  ): Promise<boolean> {
    const completed = await this.deps.hooks.completeProjectionWrite({
      projectionId: projection.id,
      generation: projection.generation,
      leaseOwner: this.workerId,
      writeMarker: marker,
      observedState,
      checkRunId,
      lastResolvedInstallationId: installationId,
      ...(settledErrorCode ? { settledErrorCode } : {})
    })
    if (!completed) return false
    const fresh = await this.deps.hooks.getReviewProjection(projection.id)
    if (fresh) await this.advancePending(fresh)
    return true
  }

  private async advancePending(projection: HookReviewProjectionRecord): Promise<void> {
    const pending = parsePendingIntent(projection.pendingIntent)
    if (!pending) return
    const nextAttemptAt = pending.nextAttemptAt ? new Date(pending.nextAttemptAt) : new Date(this.deps.clock.now())
    const advanced = await this.deps.hooks.advancePendingReviewProjection(
      projection.id,
      projection.generation,
      Number.isNaN(nextAttemptAt.getTime()) ? new Date(this.deps.clock.now()) : nextAttemptAt
    )
    if (advanced) this.rerunRequested = true
  }

  private async handlePreWriteError(projection: HookReviewProjectionRecord, err: unknown): Promise<void> {
    if (projection.writeMarker || projection.writePhase) {
      // Authorization can disappear while a previous write remains ambiguous.
      // It is safe to stop all new effects, but not to clear that write's mutex.
      await this.retry(projection, errorLabel(err, 'repo_authorization'), true)
      return
    }
    if (isRetryable(err)) {
      await this.retry(projection, errorLabel(err, 'github_unavailable'), false)
      return
    }
    await this.deps.hooks.blockProjection(projection.id, projection.generation, errorLabel(err, 'repo_authorization'))
  }

  private async handleWriteError(
    projection: HookReviewProjectionRecord,
    err: unknown,
    installationId: bigint
  ): Promise<void> {
    if (err instanceof GithubApiError && err.code === 'RATE_LIMITED') {
      // A received rate-limit response is a definite non-effect: clear the
      // marker and retry the mutation after backoff.
      await this.retry(projection, 'rate_limited', false)
      return
    }
    if (err instanceof GithubApiError && (err.status === 401 || err.status === 403 || err.status === 422)) {
      this.deps.github.invalidateInstallationTokens(installationId)
      if (projection.lastErrorCode !== 'installation_facts_refreshed') {
        let refreshed = false
        try {
          await this.deps.github.refreshInstallationFacts(installationId)
          refreshed = true
        } catch (refreshError) {
          this.deps.log?.warn?.(
            { err: refreshError, installationId: installationId.toString() },
            'github-run-reporter: installation facts refresh failed'
          )
        }
        await this.retry(
          projection,
          refreshed ? 'installation_facts_refreshed' : 'installation_facts_refresh_failed',
          false
        )
        return
      }
    }
    if (isAmbiguousMutationError(err)) {
      await this.retry(projection, errorLabel(err, 'ambiguous_write'), true)
      return
    }
    // A received non-retryable response proves this request did not mutate.
    await this.deps.hooks.blockProjection(projection.id, projection.generation, errorLabel(err, 'github_write_denied'))
  }

  private async blockOrHoldAmbiguous(projection: HookReviewProjectionRecord, code: string): Promise<void> {
    if (projection.writeMarker || projection.writePhase) {
      await this.retry(projection, code, true)
      return
    }
    await this.deps.hooks.blockProjection(projection.id, projection.generation, code)
  }

  private async retry(projection: HookReviewProjectionRecord, code: string, keepWriteMutex: boolean): Promise<void> {
    const attempt = Math.max(0, projection.attempts)
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempt, 8))
    await this.deps.hooks.retryProjectionWrite(
      projection.id,
      projection.generation,
      this.workerId,
      new Date(this.deps.clock.now() + delay),
      code,
      keepWriteMutex
    )
  }
}

function reviewDesiredState(run: HookRunRecord): ProjectionDesiredState | null {
  if (run.reviewEvent === 'REQUEST_CHANGES') return 'action_required'
  if (run.verdict === 'pass') return 'success'
  if (run.verdict === 'fail') return 'action_required'
  if (run.projectionIntent === 'review_action_only') return null
  if (run.verdict === 'neutral') return 'neutral'
  return null
}

function checkName(projection: HookReviewProjectionRecord): string {
  return projection.agentName ? `${CHECK_NAME}: ${projection.agentName}` : CHECK_NAME
}

function legacyCheckName(projection: HookReviewProjectionRecord): string {
  return `${LEGACY_CHECK_NAME_PREFIX}${projection.hookId}`
}

function checkPublication(repoFullName: string, run: HookRunRecord): CheckPresentation['publication'] | undefined {
  if (run.pullNumber === null) return undefined
  const [owner, repo, extra] = repoFullName.split('/')
  if (!owner || !repo || extra !== undefined) return undefined

  let fragment: string | undefined
  if (run.reviewAttemptState === 'submitted' && run.reviewId && /^\d+$/.test(run.reviewId)) {
    fragment = `pullrequestreview-${run.reviewId}`
  } else if (run.publishedCommentId && /^\d+$/.test(run.publishedCommentId)) {
    if (run.publishedCommentKind === 'issue_comment') fragment = `issuecomment-${run.publishedCommentId}`
    if (run.publishedCommentKind === 'review_comment') fragment = `discussion_r${run.publishedCommentId}`
  }
  if (!fragment) return undefined

  return {
    pullNumber: run.pullNumber,
    url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull/${run.pullNumber}#${fragment}`
  }
}

function pullRequestLabel(subject: HookReviewSubjectRecord, publication?: CheckPresentation['publication']): string {
  if (!publication || publication.pullNumber !== subject.pullNumber) return `#${subject.pullNumber}`
  return `[#${subject.pullNumber}](<${publication.url}>)`
}

function checkPayload(
  projection: HookReviewProjectionRecord,
  marker: string,
  at: Date,
  subjects: readonly HookReviewSubjectRecord[],
  effectiveState: ProjectionDesiredState = projection.desiredState as ProjectionDesiredState,
  associationError: SubjectAssociationErrorCode | null = null,
  presentation: CheckPresentation = {}
): Record<string, unknown> {
  const state = effectiveState
  const openSubjects =
    associationError === 'pr_association_incomplete' ? [] : subjects.filter((subject) => subject.isOpen)
  const agentLabel =
    projection.agentName && presentation.agentUrl
      ? `[${projection.agentName}](${presentation.agentUrl})`
      : projection.agentName
  // Same gate as the call-to-action title: the how-to belongs on the Check only
  // while it is actually parked waiting for a maintainer. The write marker stays
  // last so recovery keeps matching on it.
  const guidance = state === 'skipped' && !associationError ? presentation.skippedGuidance : undefined
  const normalizedSummary = [
    `Phase: ${state}`,
    ...(agentLabel ? [`Agent: ${agentLabel}`] : []),
    `Revision: ${projection.reportSha}`,
    ...(openSubjects.length > 0
      ? [
          `Pull requests: ${openSubjects.map((subject) => pullRequestLabel(subject, presentation.publication)).join(', ')}`
        ]
      : []),
    ...(associationError ? [`Association: ${associationError}`] : []),
    ...(guidance ? ['', guidance, ''] : []),
    `<!-- agentconnect-write:${marker} -->`
  ].join('\n')
  const output = {
    title: checkOutputTitle(state, associationError, presentation),
    summary: normalizedSummary
  }
  const actions: CheckAction[] =
    presentation.requestReviewAction && TERMINAL_CHECK_STATES.has(state)
      ? [
          {
            label: 'Request review',
            description: 'Start AgentConnect review',
            identifier: GITHUB_REQUEST_REVIEW_ACTION
          }
        ]
      : []
  const link = presentation.detailsUrl ? { details_url: presentation.detailsUrl } : {}
  if (state === 'queued' || state === 'in_progress') return { status: state, output, actions, ...link }
  return {
    status: 'completed',
    conclusion: state,
    completed_at: at.toISOString(),
    output,
    actions,
    ...link
  }
}

function checkOutputTitle(
  state: ProjectionDesiredState,
  associationError: SubjectAssociationErrorCode | null,
  presentation: CheckPresentation
): string {
  if (associationError) return state === 'neutral' ? REVISION_NOT_CURRENT_TITLE : ASSOCIATION_ATTENTION_TITLE
  if (state === 'skipped' && presentation.skippedLabel) return presentation.skippedLabel
  return CHECK_OUTPUT_TITLE[state]
}

function isAssociatedPullResponse(value: unknown): value is AssociatedPullResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const pull = value as Record<string, unknown>
  const head = pull.head
  const base = pull.base
  return (
    Number.isSafeInteger(pull.number) &&
    (pull.number as number) > 0 &&
    typeof pull.state === 'string' &&
    !!head &&
    typeof head === 'object' &&
    !Array.isArray(head) &&
    typeof (head as Record<string, unknown>).sha === 'string' &&
    (base === null ||
      (!!base &&
        typeof base === 'object' &&
        !Array.isArray(base) &&
        typeof (base as Record<string, unknown>).sha === 'string'))
  )
}

function dedupeAssociatedPulls(pulls: readonly AssociatedPullResponse[]): AssociatedPullResponse[] {
  const byNumber = new Map<number, AssociatedPullResponse>()
  for (const pull of pulls) byNumber.set(pull.number, pull)
  return [...byNumber.values()].sort((a, b) => a.number - b.number)
}

function asSubjectAssociationError(value: string | null): SubjectAssociationErrorCode | null {
  return value === 'pr_association_incomplete' ||
    value === 'no_current_pull_request' ||
    value === 'stale_head' ||
    value === 'shared_head_multiple_prs'
    ? value
    : null
}

function hasWriteMarker(run: CheckRunResponse, marker: string): boolean {
  return run.output?.summary?.includes(`<!-- agentconnect-write:${marker} -->`) ?? false
}

/** Recover the immutable state encoded by one durable write marker. The local
 * desired state is deliberately not consulted: accepted/start/completion may
 * have advanced it while the original GitHub response was ambiguous. */
function recoveredWriteState(run: CheckRunResponse, marker: string): ProjectionDesiredState | null {
  const summary = run.output?.summary
  if (!summary || !summary.includes(`<!-- agentconnect-write:${marker} -->`)) return null
  const encoded = summary.match(/^Phase: ([^\n]+)$/m)?.[1]
  if (!encoded || !isDesiredState(encoded)) return null
  if (encoded === 'queued' || encoded === 'in_progress') return run.status === encoded ? encoded : null
  return run.status === 'completed' && run.conclusion === encoded ? encoded : null
}

function isDesiredState(state: string): state is ProjectionDesiredState {
  return (
    state === 'queued' ||
    state === 'in_progress' ||
    state === 'success' ||
    state === 'action_required' ||
    state === 'neutral' ||
    state === 'skipped' ||
    state === 'failure' ||
    state === 'timed_out'
  )
}

function isTerminalDesiredState(state: string): boolean {
  return state !== 'queued' && state !== 'in_progress'
}

function parsePendingIntent(value: unknown): PendingProjectionIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.desiredState !== 'string' || !isDesiredState(candidate.desiredState)) return null
  if (
    candidate.currentHookRunId !== undefined &&
    candidate.currentHookRunId !== null &&
    typeof candidate.currentHookRunId !== 'string'
  )
    return null
  if (candidate.nextAttemptAt !== undefined && typeof candidate.nextAttemptAt !== 'string') return null
  return {
    desiredState: candidate.desiredState,
    ...(candidate.currentHookRunId !== undefined
      ? { currentHookRunId: candidate.currentHookRunId as string | null }
      : {}),
    ...(typeof candidate.nextAttemptAt === 'string' ? { nextAttemptAt: candidate.nextAttemptAt } : {})
  }
}

function isRetryable(err: unknown): boolean {
  return (err instanceof GithubApiError && err.retryable) || (err instanceof GitCredDeniedError && err.retryable)
}

function isAmbiguousMutationError(err: unknown): boolean {
  return !(err instanceof GithubApiError) || err.status === 0 || err.status >= 500
}

function errorLabel(err: unknown, fallback: string): string {
  if (err instanceof GitCredDeniedError) return err.code.toLowerCase()
  if (err instanceof GithubApiError) return err.code.toLowerCase()
  return fallback
}
