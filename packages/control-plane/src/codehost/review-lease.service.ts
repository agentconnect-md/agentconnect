/**
 * Provider-neutral broker for formal code-host reviews
 * (gitlab-com-integration.md §15, §15.1, §15.2).
 *
 * It authorizes one attempt against the accepted hook delivery, hands out the
 * durable publication lease for `(project, merge-request IID, service-account
 * user)`, runs the single-use operation ledger, and records the one body-free
 * terminal outcome. Review content never reaches it: the adapter talks to the
 * provider directly and reports metadata.
 *
 * The GitHub broker beside it stays exactly as it is. GitHub's review API is
 * atomic and its frames are repository/pull-shaped, so it needs no lease; this
 * one exists because a provider whose publication is a shared, unaddressed bulk
 * operation makes serialization a correctness boundary.
 */
import {
  isCodeHostProvider,
  type CodeHostReviewAuthorize,
  type CodeHostReviewAuthorized,
  type CodeHostReviewLeaseRenew,
  type CodeHostReviewLeaseRenewed,
  type CodeHostReviewOpAccepted,
  type CodeHostReviewOpRequest,
  type CodeHostReviewRefusalReason,
  type CodeHostReviewResultOk,
  type CodeHostReviewResultReport,
  type ErrorCode,
  type HookConfigSnapshot,
  type HookReviewEvent,
  type HookReviewVerdict,
  type HookStart
} from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { encodeExternalRef } from '../domain/code-host-review.js'
import { AgentId, DaemonId, HookId } from '../domain/ids.js'
import { PLACEMENT_ONLY, type PlacementResolver } from '../orchestrator/placementResolver.js'
import type {
  AgentRecord,
  AgentRepo,
  CodeHostReviewLeaseRepo,
  CodeHostReviewOpResult,
  CodeHostReviewSubject,
  HookRecord,
  HookRepo,
  HookRunRecord
} from '../persistence/ports.js'

/** One publication lease's life. Long enough for the draft/publish pipeline, and
 *  renewable — expiry alone never transfers authority (§15.1). */
export const CODE_HOST_REVIEW_LEASE_TTL_SEC = 300

type BrokerCode = Extract<ErrorCode, 'SCOPE_DENIED' | 'CONFLICT' | 'RATE_LIMITED' | 'INTERNAL'>

/** A redacted, wire-ready broker failure. Refusals that the adapter must classify
 *  precisely travel as a typed reply instead; this is for genuine faults. */
export class CodeHostReviewBrokerError extends Error {
  constructor(
    readonly code: BrokerCode,
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'CodeHostReviewBrokerError'
  }
}

function denied(message: string, code: BrokerCode = 'SCOPE_DENIED', retryable = false): never {
  throw new CodeHostReviewBrokerError(code, message, retryable)
}

/** The publishing identity one agent acts as. No credential rides it. */
export interface CodeHostReviewPublisher {
  serviceAccountExternalId: bigint
  projectPath?: string
}

/**
 * Resolve the ACTING AGENT's publishing identity on one project. Per-agent
 * accounts (gitlab-com-integration.md §7.2) make this the coordinator's subject
 * key, so two agents reviewing one merge request hold independent rows. One
 * implementer today (GitLab), so it stays a function on this service's deps
 * rather than a speculative code-host repository interface.
 */
export type CodeHostReviewPublisherResolver = (
  orgId: string,
  provider: string,
  projectExternalId: bigint,
  agentId: string
) => Promise<CodeHostReviewPublisher | null>

export interface CodeHostReviewBrokerDeps {
  leases: CodeHostReviewLeaseRepo
  hook: Pick<HookRepo, 'getUnscoped' | 'getRun' | 'recordStart'>
  agent: Pick<AgentRepo, 'getUnscoped'>
  publisher: CodeHostReviewPublisherResolver
  clock: Pick<Clock, 'now'>
  /** Absent (tests, or a deployment with no member set) ⇒ placement alone. */
  placement?: Pick<PlacementResolver, 'mayAct'>
}

const POLICY_RANK = { off: 0, comment: 1, request_changes: 2, full: 3 } as const

const EVENT_RANK: Record<HookReviewEvent, number> = {
  COMMENT: POLICY_RANK.comment,
  REQUEST_CHANGES: POLICY_RANK.request_changes,
  APPROVE: POLICY_RANK.full
}

/** `REQUEST_CHANGES` requires `fail` and `APPROVE` requires `pass` (§15). */
function verdictMatchesEvent(event: HookReviewEvent, verdict: HookReviewVerdict): boolean {
  if (event === 'APPROVE') return verdict === 'pass'
  if (event === 'REQUEST_CHANGES') return verdict === 'fail'
  return true
}

function snapshotMatches(run: HookRunRecord, snapshot: HookConfigSnapshot, daemonId: DaemonId): boolean {
  return (
    run.configRevision !== null &&
    run.configRevision === BigInt(snapshot.configRevision) &&
    run.dispatchRevision !== null &&
    run.dispatchRevision === BigInt(snapshot.dispatchRevision) &&
    run.dispatchDaemonId !== null &&
    run.dispatchDaemonId === DaemonId(snapshot.dispatchDaemonId) &&
    run.dispatchDaemonId === daemonId &&
    run.reviewPolicySnapshot === snapshot.reviewPolicy &&
    run.reportingModeSnapshot === snapshot.reportingMode &&
    run.gateModeSnapshot === snapshot.gateMode
  )
}

/** A typed refusal the adapter classifies; not an error, and not a lease. */
function refuse(attemptId: string, reason: CodeHostReviewRefusalReason, retryable: boolean): CodeHostReviewAuthorized {
  return { authorized: false, attemptId, reason, retryable }
}

export class CodeHostReviewBrokerService {
  constructor(private readonly deps: CodeHostReviewBrokerDeps) {}

  private serves(agent: AgentRecord, daemonId: DaemonId): Promise<boolean> {
    return (this.deps.placement ?? PLACEMENT_ONLY).mayAct(agent, daemonId)
  }

  /**
   * Persist the provider-neutral start barrier before an accepted GitLab hook turn is prompted
   * (§17.2). It attaches the started head and turn time to the accepted run, which is what gives
   * every later review authorization a head to fence against and the §16 ledger its `running` edge.
   *
   * The GitHub review broker is deliberately not involved: its fence is repository/pull-shaped and
   * its claimed-offline recovery belongs to GitHub webhook redelivery, which GitLab has no claim on.
   */
  async start(input: HookStart, reportingDaemonId: DaemonId, reportingOrgId: string): Promise<void> {
    const gitlab = input.gitlab
    if (!gitlab) denied('this start barrier carries provider-neutral metadata only')
    const hookId = HookId(input.hookId)
    const run = await this.deps.hook.getRun(hookId, input.deliveryKey)
    if (
      !run ||
      run.status !== 'running' ||
      run.agentId === null ||
      run.agentId !== AgentId(input.agentId) ||
      !snapshotMatches(run, input, reportingDaemonId)
    ) {
      denied('start dispatch fence does not match the accepted hook run')
    }
    if (run.orgId !== reportingOrgId) denied('organization does not match the accepted hook run')
    const projectId = BigInt(gitlab.projectId)
    const hook = await this.deps.hook.getUnscoped(hookId)
    const agent = await this.deps.agent.getUnscoped(run.agentId)
    if (!this.hookAuthorizes(hook, run, 'gitlab', projectId)) denied('hook is disabled or its project changed')
    if (!agent || agent.status !== 'active' || !(await this.serves(agent, reportingDaemonId))) {
      denied('agent is no longer active on the accepted dispatch daemon')
    }
    // Only a merge request has a revision; an issue or push subject records the turn time alone.
    const head = gitlab.target.kind === 'merge_request' ? gitlab.target : undefined
    const accepted = await this.deps.hook.recordStart(hookId, reportingDaemonId, {
      deliveryKey: input.deliveryKey,
      agentId: AgentId(input.agentId),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      configRevision: BigInt(input.configRevision),
      dispatchRevision: BigInt(input.dispatchRevision),
      dispatchDaemonId: DaemonId(input.dispatchDaemonId),
      reviewPolicySnapshot: input.reviewPolicy,
      reportingModeSnapshot: input.reportingMode,
      gateModeSnapshot: input.gateMode,
      // CP time is not part of the daemon request; a retry reuses the persisted barrier.
      startedAt: run.turnStartedAt ?? new Date(this.deps.clock.now()),
      ...(head?.headSha ? { headSha: head.headSha } : {}),
      ...(head?.baseSha ? { baseSha: head.baseSha } : {})
    })
    if (!accepted) denied('hook start reservation was rejected', 'CONFLICT')
  }

  /**
   * Authorize one attempt and acquire its publication lease.
   *
   * Authority is the accepted hook delivery plus the LIVE hook, agent, placement,
   * and project binding — re-resolved here, never taken from the request. The
   * merge-request IID and head come from the adapter's private active-turn state
   * (they are relay-delivered, signature-verified metadata, never model-visible
   * text) and are fenced against the accepted run wherever it carries them.
   */
  async authorize(
    input: CodeHostReviewAuthorize,
    reportingDaemonId: DaemonId,
    reportingOrgId?: string
  ): Promise<CodeHostReviewAuthorized> {
    if (!isCodeHostProvider(input.provider)) denied(`unknown code host provider ${input.provider}`)
    if (!verdictMatchesEvent(input.requestedEvent, input.requestedVerdict)) {
      denied('requested review event and verdict are incompatible')
    }
    const hookId = HookId(input.hookId)
    const run = await this.deps.hook.getRun(hookId, input.deliveryKey)
    if (
      !run ||
      run.status !== 'running' ||
      run.agentId === null ||
      !snapshotMatches(run, input.snapshot, reportingDaemonId)
    ) {
      denied('review dispatch fence does not match the accepted hook run')
    }
    if (reportingOrgId && run.orgId !== reportingOrgId) denied('organization does not match the accepted hook run')

    const projectId = BigInt(input.projectId)
    const hook = await this.deps.hook.getUnscoped(hookId)
    const agent = await this.deps.agent.getUnscoped(run.agentId)
    if (!this.hookAuthorizes(hook, run, input.provider, projectId)) denied('hook is disabled or its project changed')
    if (!agent || agent.status !== 'active' || !(await this.serves(agent, reportingDaemonId))) {
      denied('agent is no longer active on the accepted dispatch daemon')
    }
    if (!this.eventAllowed(run, hook!, input.requestedEvent)) {
      return refuse(input.attemptId, 'policy_denied', false)
    }
    // AgentConnect never assigns itself as a reviewer, so a request-changes attempt
    // fails before any draft exists rather than after (§15 step 7).
    if (input.requestedEvent === 'REQUEST_CHANGES' && input.serviceAccountIsReviewer !== true) {
      return refuse(input.attemptId, 'reviewer_assignment_required', false)
    }
    // A run the start barrier crossed always carries the head it was started on, so this binds for
    // every fresh attempt. A row started before that barrier existed carries none and stays graceful.
    if (run.headSha !== null ? run.headSha !== input.headSha : run.turnStartedAt !== null) {
      return refuse(input.attemptId, 'head_changed', false)
    }

    const publisher = await this.deps.publisher(run.orgId, input.provider, projectId, run.agentId)
    if (!publisher) return refuse(input.attemptId, 'binding_unavailable', true)

    const now = new Date(this.deps.clock.now())
    const acquired = await this.deps.leases.acquire({
      subject: {
        provider: input.provider,
        projectExternalId: projectId,
        mergeRequestIid: input.mergeRequestIid,
        serviceAccountExternalId: publisher.serviceAccountExternalId
      },
      orgId: run.orgId,
      attemptId: input.attemptId,
      daemonId: reportingDaemonId,
      agentId: AgentId(run.agentId),
      hookId,
      deliveryKey: input.deliveryKey,
      event: input.requestedEvent,
      verdict: input.requestedVerdict,
      headSha: input.headSha,
      leaseUntil: new Date(now.getTime() + CODE_HOST_REVIEW_LEASE_TTL_SEC * 1000),
      now
    })
    if (acquired.outcome === 'held') return refuse(input.attemptId, 'lease_held', true)
    // No timeout and no force unlock: recovery needs a definite outcome from the
    // old broker or positive provider evidence, so this is never retryable.
    if (acquired.outcome === 'locked') return refuse(input.attemptId, 'ambiguous_locked', false)

    const lease = acquired.lease
    return {
      authorized: true,
      attemptId: input.attemptId,
      provider: input.provider,
      projectId: input.projectId,
      mergeRequestIid: input.mergeRequestIid,
      ...(publisher.projectPath ? { projectPath: publisher.projectPath } : {}),
      expectedHeadSha: input.headSha,
      ...(input.baseSha ? { expectedBaseSha: input.baseSha } : {}),
      lease: {
        attemptId: input.attemptId,
        fence: lease.fence.toString(),
        leaseUntil: (lease.leaseUntil ?? now).toISOString(),
        serviceAccountUserId: lease.serviceAccountExternalId.toString()
      }
    }
  }

  /** One step of the single-use operation ledger. */
  async operate(
    input: CodeHostReviewOpRequest,
    reportingDaemonId: DaemonId,
    orgId: string
  ): Promise<CodeHostReviewOpAccepted> {
    const now = new Date(this.deps.clock.now())
    const base = { attemptId: input.attemptId, orgId, fence: BigInt(input.fence), daemonId: reportingDaemonId, now }
    const result: CodeHostReviewOpResult =
      input.op === 'issue'
        ? await this.deps.leases.issueOperation({
            ...base,
            kind: input.kind,
            method: input.method,
            target: input.target,
            ordinal: input.ordinal
          })
        : input.op === 'start'
          ? await this.deps.leases.startOperation({ ...base, recordId: input.recordId, startToken: input.startToken })
          : input.op === 'settle'
            ? await this.deps.leases.settleOperation({ ...base, recordId: input.recordId, outcome: input.outcome })
            : await this.deps.leases.returnOperationUnused({ ...base, recordId: input.recordId })

    if (!('outcome' in result)) this.throwOpFailure(result)
    return {
      op: input.op,
      recordId: result.record.id,
      attemptId: result.record.attemptId,
      fence: result.record.fence.toString(),
      kind: result.record.kind,
      ordinal: result.record.ordinal,
      state: result.record.state,
      phase: result.phase
    }
  }

  /** Owner-only extension. A stale fence or a foreign daemon renews nothing. */
  async renew(
    input: CodeHostReviewLeaseRenew,
    reportingDaemonId: DaemonId,
    orgId: string
  ): Promise<CodeHostReviewLeaseRenewed> {
    const now = this.deps.clock.now()
    const leaseUntil = new Date(now + CODE_HOST_REVIEW_LEASE_TTL_SEC * 1000)
    const lease = await this.deps.leases.renew({
      attemptId: input.attemptId,
      orgId,
      fence: BigInt(input.fence),
      daemonId: reportingDaemonId,
      leaseUntil
    })
    if (!lease) denied('this attempt does not own the publication lease', 'CONFLICT')
    return {
      attemptId: input.attemptId,
      fence: lease.fence.toString(),
      leaseUntil: (lease.leaseUntil ?? leaseUntil).toISOString(),
      phase: lease.phase
    }
  }

  /**
   * Record the terminal classification. This is the moment publication, reviewer
   * state, and any approval outcome become durably classified, so it is also the
   * moment the lease is released — or, for an outcome that proves nothing, the
   * moment the merge request locks.
   */
  async recordResult(
    input: CodeHostReviewResultReport,
    reportingDaemonId: DaemonId,
    reportingOrgId?: string
  ): Promise<CodeHostReviewResultOk> {
    if (!isCodeHostProvider(input.provider)) denied(`unknown code host provider ${input.provider}`)
    if (!verdictMatchesEvent(input.event, input.verdict)) denied('review event and verdict are incompatible')
    const hookId = HookId(input.hookId)
    const run = await this.deps.hook.getRun(hookId, input.deliveryKey)
    if (!run || !snapshotMatches(run, input.snapshot, reportingDaemonId)) {
      denied('review result fence does not match the accepted hook run')
    }
    if (reportingOrgId && run.orgId !== reportingOrgId) denied('organization does not match the accepted hook run')

    let externalIds: string[]
    try {
      externalIds = (input.externalIds ?? []).map((ref) => encodeExternalRef(ref.kind, ref.externalId))
    } catch {
      denied('review result named a published object that is not a kind and a numeric id')
    }

    const recorded = await this.deps.leases.recordOutcome({
      attemptId: input.attemptId,
      orgId: run.orgId,
      hookId,
      deliveryKey: input.deliveryKey,
      provider: input.provider,
      projectExternalId: BigInt(input.projectId),
      mergeRequestIid: input.mergeRequestIid,
      daemonId: reportingDaemonId,
      event: input.event,
      verdict: input.verdict,
      headSha: input.headSha,
      state: input.state,
      externalIds,
      now: new Date(this.deps.clock.now())
    })
    if (recorded.outcome === 'not_owner') denied('this attempt does not own the publication lease', 'CONFLICT')
    if (recorded.outcome === 'conflict') denied('review result does not match the reserved attempt', 'CONFLICT')
    return { accepted: true, phase: recorded.phase }
  }

  /** The hook must still be an enabled hook of this run's agent on that very project. */
  private hookAuthorizes(
    hook: HookRecord | null,
    run: HookRunRecord,
    provider: string,
    projectExternalId: bigint
  ): boolean {
    return (
      hook !== null &&
      hook.enabled &&
      hook.kind === provider &&
      hook.agentId !== null &&
      hook.agentId === run.agentId &&
      hook.repoId === projectExternalId &&
      run.dispatchRevision !== null &&
      hook.dispatchRevision === run.dispatchRevision
    )
  }

  /** The accepted snapshot and the live definition both have to permit the event. */
  private eventAllowed(run: HookRunRecord, hook: HookRecord, event: HookReviewEvent): boolean {
    if (run.reviewPolicySnapshot === null) return false
    return Math.min(POLICY_RANK[run.reviewPolicySnapshot], POLICY_RANK[hook.reviewPolicy]) >= EVENT_RANK[event]
  }

  private throwOpFailure(result: Exclude<CodeHostReviewOpResult, { outcome: 'ok' }>): never {
    switch (result.failure) {
      case 'no_lease':
      case 'not_owner':
      case 'no_record':
        denied('this daemon does not own that operation record')
        break
      case 'stale_fence':
        denied('operation record fence is stale', 'CONFLICT')
        break
      case 'lease_closed':
        denied('the publication lease is no longer open', 'CONFLICT')
        break
      case 'permit_conflict':
        denied('an operation record already exists for those coordinates', 'CONFLICT')
        break
      default:
        denied(`operation record cannot ${result.reason.replace(/_/g, ' ')}`, 'CONFLICT')
    }
  }
}

export type { CodeHostReviewSubject }
