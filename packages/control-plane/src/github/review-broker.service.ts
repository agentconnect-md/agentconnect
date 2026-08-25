/**
 * Action-time broker for one formal GitHub review effect.
 *
 * The daemon supplies only the accepted dispatch identity plus the requested
 * review event + verdict. Repository / pull / revision authority always comes back out
 * of the durable HookRun; no prompt-derived target is accepted here. Token
 * minting happens after the durable attempt reservation and outside the
 * persistence transaction owned by HookRepo.
 */
import {
  isRetryableHookDeliveryReason,
  type ErrorCode,
  type GithubReviewAuthorize,
  type GithubReviewAuthorized,
  type GithubReviewResultReport,
  type HookConfigSnapshot,
  type HookReviewEvent,
  type HookStart
} from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { AgentId, DaemonId, HookId } from '../domain/ids.js'
import type {
  AgentRecord,
  AgentRepo,
  HookRecord,
  HookRepo,
  HookReviewResultInput,
  HookRunRecord
} from '../persistence/ports.js'
import { PLACEMENT_ONLY, type PlacementResolver } from '../orchestrator/placementResolver.js'
import { GitCredDeniedError, type GithubService } from './service.js'

type ReviewBrokerCode = Extract<ErrorCode, 'SCOPE_DENIED' | 'LEASE_DENIED' | 'RATE_LIMITED' | 'CONFLICT' | 'INTERNAL'>

/** A redacted, wire-ready broker failure. */
export class GithubReviewBrokerError extends Error {
  constructor(
    readonly code: ReviewBrokerCode,
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'GithubReviewBrokerError'
  }
}

export interface GithubReviewBrokerDeps {
  hook: Pick<HookRepo, 'getUnscoped' | 'getRun' | 'recordStart' | 'reserveReviewAttempt' | 'recordReviewResult'>
  agent: Pick<AgentRepo, 'getUnscoped'>
  github: Pick<GithubService, 'mintReviewForAgent' | 'validateReviewForAgent'>
  clock: Pick<Clock, 'now'>
  /** Absent (tests, or a deployment with no member set) ⇒ placement alone, the pre-duty behavior. */
  placement?: Pick<PlacementResolver, 'mayAct'>
}

const POLICY_RANK = {
  off: 0,
  comment: 1,
  request_changes: 2,
  full: 3
} as const

const EVENT_RANK: Record<HookReviewEvent, number> = {
  COMMENT: POLICY_RANK.comment,
  REQUEST_CHANGES: POLICY_RANK.request_changes,
  APPROVE: POLICY_RANK.full
}

function denied(message: string, code: ReviewBrokerCode = 'SCOPE_DENIED'): never {
  throw new GithubReviewBrokerError(code, message, false)
}

function bigintWire(value: string): bigint {
  // Protocol validation already constrains this to an unsigned decimal. Keep
  // the conversion at the broker boundary so persistence never sees strings.
  return BigInt(value)
}

function snapshotMatches(run: HookRunRecord, snapshot: HookConfigSnapshot, daemonId: DaemonId): boolean {
  return (
    run.configRevision !== null &&
    run.configRevision === bigintWire(snapshot.configRevision) &&
    run.dispatchRevision !== null &&
    run.dispatchRevision === bigintWire(snapshot.dispatchRevision) &&
    run.dispatchDaemonId !== null &&
    run.dispatchDaemonId === DaemonId(snapshot.dispatchDaemonId) &&
    run.dispatchDaemonId === daemonId &&
    run.reviewPolicySnapshot !== null &&
    run.reviewPolicySnapshot === snapshot.reviewPolicy &&
    run.reportingModeSnapshot !== null &&
    run.reportingModeSnapshot === snapshot.reportingMode &&
    run.gateModeSnapshot !== null &&
    run.gateModeSnapshot === snapshot.gateMode
  )
}

function requireAcceptedRun(
  run: HookRunRecord | null,
  snapshot: HookConfigSnapshot,
  daemonId: DaemonId,
  opts: { started: boolean }
): HookRunRecord {
  if (!run || run.status !== 'running' || !snapshotMatches(run, snapshot, daemonId)) {
    denied('review dispatch fence does not match the accepted hook run')
  }
  if (opts.started && run.turnStartedAt === null) denied('hook turn has not crossed the start barrier')
  return run
}

/** Fail-closed mirror of the repository's claimed pre-dispatch recovery guard. */
function isClaimedDeliveryRecoveryCandidate(run: HookRunRecord): boolean {
  return (
    run.status === 'failed' &&
    isRetryableHookDeliveryReason(run.reason) &&
    run.redeliveryAttempts > 0 &&
    run.redeliveryLastRequestedAt !== null &&
    run.turnStartedAt === null &&
    run.orphanedAt === null &&
    run.durationMs === null &&
    run.sessionId === null &&
    run.reviewAttemptId === null &&
    run.reviewAttemptState === null &&
    run.reviewErrorCode === null &&
    run.reviewId === null &&
    run.reviewEvent === null &&
    run.verdict === null &&
    run.reviewCommitId === null &&
    run.publishedCommentKind === null &&
    run.publishedCommentId === null
  )
}

function requireCurrentHookForStart(hook: HookRecord | null, run: HookRunRecord, daemonId: DaemonId): HookRecord {
  if (
    !hook ||
    !hook.enabled ||
    hook.kind !== 'github' ||
    hook.agentId === null ||
    hook.agentId !== run.agentId ||
    hook.configRevision !== run.configRevision ||
    hook.dispatchRevision !== run.dispatchRevision ||
    run.projectionEpoch === null ||
    hook.projectionEpoch !== run.projectionEpoch ||
    hook.reviewPolicy !== run.reviewPolicySnapshot ||
    hook.reportingMode !== run.reportingModeSnapshot ||
    hook.gateMode !== run.gateModeSnapshot ||
    run.dispatchDaemonId !== daemonId
  ) {
    denied('hook definition changed before the accepted turn started')
  }
  return hook
}

function eventAllowed(
  snapshotPolicy: HookRunRecord['reviewPolicySnapshot'],
  current: HookRecord,
  event: HookReviewEvent
) {
  if (snapshotPolicy === null) return false
  return Math.min(POLICY_RANK[snapshotPolicy], POLICY_RANK[current.reviewPolicy]) >= EVENT_RANK[event]
}

function requireCurrentActionAuthority(
  hook: HookRecord | null,
  agent: AgentRecord | null,
  run: HookRunRecord,
  daemonId: DaemonId,
  event: HookReviewEvent,
  /** Whether the reporting daemon still serves the agent — placement ∪ live duty holders. */
  agentIsServed: boolean
): { hook: HookRecord; agent: AgentRecord } {
  if (
    !hook ||
    !hook.enabled ||
    hook.kind !== 'github' ||
    hook.agentId === null ||
    hook.agentId !== run.agentId ||
    hook.repoId === null ||
    run.repoId === null ||
    hook.repoId !== run.repoId ||
    run.projectionEpoch === null ||
    hook.projectionEpoch !== run.projectionEpoch ||
    run.dispatchRevision === null ||
    hook.dispatchRevision !== run.dispatchRevision
  ) {
    denied('hook is disabled or its agent changed')
  }
  // A persisted accepted tuple lets its old daemon finish bookkeeping after a
  // placement move, but does not authorize a new external effect.
  if (
    !agent ||
    agent.id !== run.agentId ||
    agent.status !== 'active' ||
    !agentIsServed ||
    run.dispatchDaemonId !== daemonId
  ) {
    denied('agent is no longer active on the accepted dispatch daemon')
  }
  if (!eventAllowed(run.reviewPolicySnapshot, hook, event)) {
    denied(`review policy does not allow ${event}`)
  }
  return { hook, agent }
}

function requireTrustedPullTarget(run: HookRunRecord): {
  repoId: bigint
  repoFullName: string
  pullNumber: number
  headSha: string
  baseSha: string
} {
  if (
    run.repoId === null ||
    run.repoFullName === null ||
    run.subjectKind !== 'pull_request' ||
    run.pullNumber === null ||
    run.headSha === null ||
    run.baseSha === null
  ) {
    denied('accepted hook run does not contain a complete trusted pull revision')
  }
  return {
    repoId: run.repoId,
    repoFullName: run.repoFullName,
    pullNumber: run.pullNumber,
    headSha: run.headSha,
    baseSha: run.baseSha
  }
}

function submittedVerdictIsValid(event: HookReviewEvent, verdict: 'pass' | 'fail' | 'neutral'): boolean {
  if (event === 'APPROVE') return verdict === 'pass'
  if (event === 'REQUEST_CHANGES') return verdict === 'fail'
  return true
}

export class GithubReviewBrokerService {
  constructor(private readonly deps: GithubReviewBrokerDeps) {}

  /** May the reporting daemon act for this agent — its placement, or a duty it currently holds. */
  private serves(agent: AgentRecord, daemonId: DaemonId): Promise<boolean> {
    return (this.deps.placement ?? PLACEMENT_ONLY).mayAct(agent, daemonId)
  }

  /** Re-read hook + agent and re-apply the current action fence at one authorization checkpoint. */
  private async requireLiveActionAuthority(
    hookId: HookId,
    agentId: AgentId,
    run: HookRunRecord,
    reportingDaemonId: DaemonId,
    event: HookReviewEvent
  ): Promise<{ hook: HookRecord; agent: AgentRecord }> {
    const hook = await this.deps.hook.getUnscoped(hookId)
    const agent = await this.deps.agent.getUnscoped(agentId)
    return requireCurrentActionAuthority(
      hook,
      agent,
      run,
      reportingDaemonId,
      event,
      agent ? await this.serves(agent, reportingDaemonId) : false
    )
  }

  /** Re-read the durable attempt at each authorization checkpoint. Keeping
   * this guard named makes the repeated TOCTOU fences visible without
   * repeating their field-by-field comparison. */
  private async requireActiveReservation(
    input: GithubReviewAuthorize,
    reportingDaemonId: DaemonId,
    message: string
  ): Promise<HookRunRecord> {
    const run = requireAcceptedRun(
      await this.deps.hook.getRun(HookId(input.hookId), input.deliveryKey),
      input.snapshot,
      reportingDaemonId,
      { started: true }
    )
    if (
      run.reviewAttemptId !== input.attemptId ||
      (run.reviewAttemptState !== 'reserved' && run.reviewAttemptState !== 'blocked') ||
      run.reviewEvent !== input.requestedEvent ||
      run.verdict !== input.requestedVerdict
    ) {
      denied(message, 'CONFLICT')
    }
    return run
  }

  /** Persist the exact start barrier before a GitHub hook enters the prompt. */
  async start(input: HookStart, reportingDaemonId: DaemonId, reportingOrgId?: string): Promise<void> {
    const hookId = HookId(input.hookId)
    const initial = await this.deps.hook.getRun(hookId, input.deliveryKey)
    if (!initial) denied('review dispatch fence does not match the accepted hook run')
    if (reportingOrgId && initial.orgId !== reportingOrgId) denied('organization does not match the accepted hook run')
    if (initial.agentId === null || initial.agentId !== AgentId(input.agentId)) {
      denied('hook start agent does not match the accepted hook run')
    }

    // HookStart is a provider one-of since gitcred v2; this broker serves GitHub only.
    const github = input.github
    if (!github) denied('hook start requires github metadata on this broker')
    if (
      initial.repoId === null ||
      initial.repoId !== bigintWire(github.repoId) ||
      initial.repoFullName === null ||
      initial.repoFullName !== github.repoFullName ||
      initial.sourceInstallationId === null ||
      initial.sourceInstallationId !== bigintWire(github.sourceInstallationId) ||
      initial.subjectKind === null ||
      initial.subjectKind !== github.subjectKind ||
      (initial.event !== null && input.event !== undefined && initial.event !== input.event) ||
      (initial.pullNumber !== null && initial.pullNumber !== github.pullNumber) ||
      (initial.headSha !== null && initial.headSha !== github.headSha) ||
      (initial.baseSha !== null && initial.baseSha !== github.baseSha) ||
      (initial.reportSha !== null && initial.reportSha !== github.reportSha) ||
      (initial.isDraft !== null && initial.isDraft !== github.isDraft) ||
      (initial.baseChanged !== null && initial.baseChanged !== github.baseChanged)
    ) {
      denied('hook start metadata does not match the accepted hook run')
    }
    if (github.subjectKind === 'pull_request' && (!github.pullNumber || !github.headSha || !github.baseSha)) {
      denied('hook start requires a complete pull revision')
    }

    const startInput = {
      deliveryKey: input.deliveryKey,
      agentId: AgentId(input.agentId),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      configRevision: bigintWire(input.configRevision),
      dispatchRevision: bigintWire(input.dispatchRevision),
      dispatchDaemonId: DaemonId(input.dispatchDaemonId),
      reviewPolicySnapshot: input.reviewPolicy,
      reportingModeSnapshot: input.reportingMode,
      gateModeSnapshot: input.gateMode,
      // CP time is not part of the daemon request. Reuse the persisted barrier
      // on retries so a lost reply/afterStart failure remains idempotent.
      startedAt: initial.turnStartedAt ?? new Date(this.deps.clock.now()),
      repoId: bigintWire(github.repoId),
      repoFullName: github.repoFullName,
      sourceInstallationId: bigintWire(github.sourceInstallationId),
      subjectKind: github.subjectKind,
      ...(github.pullNumber !== undefined ? { pullNumber: github.pullNumber } : {}),
      ...(github.headSha ? { headSha: github.headSha } : {}),
      ...(github.baseSha ? { baseSha: github.baseSha } : {}),
      ...(github.reportSha ? { reportSha: github.reportSha } : {}),
      ...(github.isDraft !== undefined ? { isDraft: github.isDraft } : {}),
      ...(github.baseChanged !== undefined ? { baseChanged: github.baseChanged } : {})
    } as const

    const recovering = isClaimedDeliveryRecoveryCandidate(initial)
    if (recovering && !(await this.deps.hook.recordStart(hookId, reportingDaemonId, startInput))) {
      denied('hook start reservation was rejected', 'CONFLICT')
    }

    const run = requireAcceptedRun(
      recovering ? await this.deps.hook.getRun(hookId, input.deliveryKey) : initial,
      input,
      reportingDaemonId,
      { started: recovering }
    )
    requireCurrentHookForStart(await this.deps.hook.getUnscoped(hookId), run, reportingDaemonId)
    const agent = await this.deps.agent.getUnscoped(run.agentId!)
    if (!agent || agent.status !== 'active' || !(await this.serves(agent, reportingDaemonId))) {
      denied('agent is no longer active on the accepted dispatch daemon')
    }

    const accepted = recovering || (await this.deps.hook.recordStart(hookId, reportingDaemonId, startInput))
    if (!accepted) denied('hook start reservation was rejected', 'CONFLICT')
  }

  /** Reserve one attempt, revalidate live policy/placement, then mint its token. */
  async authorize(
    input: GithubReviewAuthorize,
    reportingDaemonId: DaemonId,
    reportingOrgId?: string
  ): Promise<GithubReviewAuthorized> {
    const hookId = HookId(input.hookId)
    const initial = requireAcceptedRun(
      await this.deps.hook.getRun(hookId, input.deliveryKey),
      input.snapshot,
      reportingDaemonId,
      { started: true }
    )
    if (initial.agentId === null) denied('accepted hook run has no agent identity')
    if (reportingOrgId && initial.orgId !== reportingOrgId) denied('organization does not match the accepted hook run')
    if (!submittedVerdictIsValid(input.requestedEvent, input.requestedVerdict)) {
      denied('requested review event and verdict are incompatible')
    }
    const target = requireTrustedPullTarget(initial)
    const current = await this.requireLiveActionAuthority(
      hookId,
      initial.agentId,
      initial,
      reportingDaemonId,
      input.requestedEvent
    )

    const reservation = await this.deps.hook.reserveReviewAttempt(hookId, reportingDaemonId, {
      deliveryKey: input.deliveryKey,
      attemptId: input.attemptId,
      agentId: initial.agentId,
      configRevision: initial.configRevision!,
      dispatchRevision: initial.dispatchRevision!,
      dispatchDaemonId: initial.dispatchDaemonId!,
      requestedEvent: input.requestedEvent,
      requestedVerdict: input.requestedVerdict
    })
    if (reservation === 'rejected') denied('another review attempt already owns this hook run', 'CONFLICT')

    await this.requireActiveReservation(input, reportingDaemonId, 'review attempt reservation is no longer active')

    let cred: Awaited<ReturnType<GithubService['mintReviewForAgent']>>
    try {
      cred = await this.deps.github.mintReviewForAgent(
        current.agent,
        target.repoId,
        target.repoFullName,
        input.requestedEvent
      )
    } catch (error) {
      // A newly-created reservation has never exposed a token, so this is a
      // proven no-effect path. An idempotent reservation may represent a prior
      // authorization (or an ambiguous blocked POST); keep it pinned for
      // marker reconciliation instead of making a second attempt possible.
      if (reservation === 'reserved') {
        await this.releaseReservation(hookId, reportingDaemonId, input.deliveryKey, input.attemptId)
      }
      if (error instanceof GitCredDeniedError) {
        throw new GithubReviewBrokerError(error.code, error.message, error.retryable)
      }
      throw new GithubReviewBrokerError('INTERNAL', 'review credential mint failed', true)
    }

    // Close the policy/placement race across the GitHub token mint and confirm
    // that no result/reaper displaced this exact reservation before exposing
    // bearer material to the daemon.
    const finalRun = await this.requireActiveReservation(
      input,
      reportingDaemonId,
      'review attempt reservation changed while authorizing'
    )
    try {
      const finalAuthority = await this.requireLiveActionAuthority(
        hookId,
        initial.agentId,
        finalRun,
        reportingDaemonId,
        input.requestedEvent
      )
      // Re-read the numeric repo grant and installation-effective permission
      // *after* token minting. This is the action's authorization linearization
      // point: a revoke that committed during mint is observed before bearer
      // material can cross to the daemon; a later revoke is ordered after it.
      const live = await this.deps.github.validateReviewForAgent(
        finalAuthority.agent,
        target.repoId,
        target.repoFullName,
        input.requestedEvent
      )
      if (live.installation.installationId !== cred.installationId) {
        denied('github installation changed while authorizing the review', 'LEASE_DENIED')
      }

      // Validation itself may perform live repo resolution. Close the final
      // hook/placement/reservation race once more immediately before exposure.
      const exposureRun = await this.requireActiveReservation(
        input,
        reportingDaemonId,
        'review attempt reservation changed while authorizing'
      )
      await this.requireLiveActionAuthority(
        hookId,
        initial.agentId,
        exposureRun,
        reportingDaemonId,
        input.requestedEvent
      )
    } catch (error) {
      if (reservation === 'reserved') {
        await this.releaseReservation(hookId, reportingDaemonId, input.deliveryKey, input.attemptId)
      }
      if (error instanceof GitCredDeniedError) {
        throw new GithubReviewBrokerError(error.code, error.message, error.retryable)
      }
      if (!(error instanceof GithubReviewBrokerError)) {
        throw new GithubReviewBrokerError('INTERNAL', 'review authority changed while minting', true)
      }
      throw error
    }

    return {
      attemptId: input.attemptId,
      token: cred.token,
      ttlSec: cred.ttlSec,
      expiresAt: cred.expiresAt,
      repoId: target.repoId.toString(),
      repoFullName: target.repoFullName,
      pullNumber: target.pullNumber,
      expectedHeadSha: target.headSha,
      expectedBaseSha: target.baseSha
    }
  }

  /** Fold the daemon's body-free POST outcome into the durable reservation. */
  async recordResult(
    input: GithubReviewResultReport,
    reportingDaemonId: DaemonId,
    reportingOrgId?: string
  ): Promise<void> {
    const hookId = HookId(input.hookId)
    const run = requireAcceptedRun(
      await this.deps.hook.getRun(hookId, input.deliveryKey),
      input.snapshot,
      reportingDaemonId,
      { started: true }
    )
    if (reportingOrgId && run.orgId !== reportingOrgId) denied('organization does not match the accepted hook run')
    if (run.reviewAttemptId !== input.attemptId) denied('review result does not own this hook run', 'CONFLICT')

    const result = input.result
    let persisted: HookReviewResultInput
    if (result.state === 'submitted') {
      if (
        run.reviewEvent !== result.event ||
        run.verdict !== result.verdict ||
        run.headSha === null ||
        run.headSha !== result.commitId ||
        !submittedVerdictIsValid(result.event, result.verdict)
      ) {
        denied('submitted review metadata does not match the reserved action')
      }
      if (run.reviewAttemptState === 'submitted') {
        if (
          run.reviewId === result.reviewId &&
          run.reviewEvent === result.event &&
          run.verdict === result.verdict &&
          run.reviewCommitId === result.commitId
        ) {
          return
        }
        denied('review attempt already has a different submitted result', 'CONFLICT')
      }
      if (run.reviewAttemptState !== 'reserved' && run.reviewAttemptState !== 'blocked') {
        denied('review attempt can no longer accept a result', 'CONFLICT')
      }
      persisted = {
        deliveryKey: input.deliveryKey,
        attemptId: input.attemptId,
        state: 'submitted',
        reviewId: result.reviewId,
        event: result.event,
        verdict: result.verdict,
        commitId: result.commitId
      }
    } else if (result.state === 'not_submitted') {
      if (run.reviewAttemptState !== 'reserved' && run.reviewAttemptState !== 'blocked') {
        denied('review attempt can no longer be released', 'CONFLICT')
      }
      persisted = {
        deliveryKey: input.deliveryKey,
        attemptId: input.attemptId,
        state: 'released',
        code: result.code
      }
    } else {
      if (run.reviewAttemptState === 'blocked') return
      if (run.reviewAttemptState !== 'reserved') denied('review attempt can no longer be blocked', 'CONFLICT')
      persisted = {
        deliveryKey: input.deliveryKey,
        attemptId: input.attemptId,
        state: 'blocked',
        code: result.code
      }
    }

    const accepted = await this.deps.hook.recordReviewResult(hookId, reportingDaemonId, persisted)
    if (!accepted) denied('review result lost its reservation race', 'CONFLICT')
  }

  private async releaseReservation(
    hookId: HookId,
    reportingDaemonId: DaemonId,
    deliveryKey: string,
    attemptId: string
  ): Promise<void> {
    await this.deps.hook.recordReviewResult(hookId, reportingDaemonId, {
      deliveryKey,
      attemptId,
      state: 'released'
    })
  }
}
