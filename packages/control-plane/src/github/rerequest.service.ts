import {
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  isGithubPullRequestRevisionEvent,
  type RcGithubRerequest,
  type RcGithubRerequestResult
} from '@agentconnect.md/protocol'
import type { HookRecord, HookRepo, HookReviewProjectionRecord, HookRunRecord } from '../persistence/ports.js'

export interface GithubRerequestDeps {
  hooks: Pick<
    HookRepo,
    | 'findReviewProjectionByCheckRunId'
    | 'listReviewProjectionsForSuiteRerequest'
    | 'listReviewRequestRequiredRuns'
    | 'getUnscoped'
    | 'getManyUnscoped'
    | 'getRunById'
  >
  appId: number
}

const TERMINAL_CHECK_STATES = new Set([
  'success',
  'action_required',
  'neutral',
  'skipped',
  'failure',
  'timed_out',
  'cancelled'
])

/** Resolve a signed GitHub review control against durable runs and current hook fences. */
export class GithubRerequestService {
  constructor(private readonly deps: GithubRerequestDeps) {}

  async resolve(req: RcGithubRerequest): Promise<RcGithubRerequestResult> {
    if ('checkRunId' in req) return this.resolveRun(req)
    return req.scope === 'suite' ? this.resolveSuite(req) : this.resolveWorkflow(req)
  }

  private async resolveRun(req: Extract<RcGithubRerequest, { checkRunId: string }>): Promise<RcGithubRerequestResult> {
    const projection = await this.deps.hooks.findReviewProjectionByCheckRunId(req.checkRunId)
    if (!this.matchesProjection(projection, req)) return { allowed: false }

    const [hook, run] = await Promise.all([
      // The hook behind a durable Check projection this resolver already matched.
      this.deps.hooks.getUnscoped(projection.hookId),
      this.deps.hooks.getRunById(projection.currentHookRunId)
    ])
    if (!this.matchesCurrentHook(hook, projection) || !this.matchesCurrentRun(run, projection)) {
      return { allowed: false }
    }

    return {
      allowed: true,
      hookId: hook.id,
      pullNumber: run.pullNumber,
      ...(req.includeBaseSha ? { baseSha: run.baseSha } : {}),
      configRevision: hook.configRevision.toString(),
      dispatchRevision: hook.dispatchRevision.toString()
    }
  }

  private async resolveSuite(req: Extract<RcGithubRerequest, { scope: 'suite' }>): Promise<RcGithubRerequestResult> {
    if (req.appId !== String(this.deps.appId)) return { allowed: false }

    const projections = await this.deps.hooks.listReviewProjectionsForSuiteRerequest(
      BigInt(req.repoId),
      req.headSha,
      BigInt(req.installationId)
    )
    if (
      projections.length === 0 ||
      new Set(projections.map((projection) => projection.hookId)).size !== projections.length ||
      projections.some((projection) => !this.matchesProjection(projection, req))
    ) {
      return { allowed: false }
    }

    const current = projections as Array<HookReviewProjectionRecord & { checkRunId: string; currentHookRunId: string }>
    const [hooks, runs] = await Promise.all([
      this.deps.hooks.getManyUnscoped(current.map((projection) => projection.hookId)),
      Promise.all(current.map((projection) => this.deps.hooks.getRunById(projection.currentHookRunId)))
    ])
    const hooksById = new Map(hooks.map((hook) => [hook.id, hook]))
    const targets = current.map((projection, index) => {
      const hook = hooksById.get(projection.hookId) ?? null
      const run = runs[index] ?? null
      if (!this.matchesCurrentHook(hook, projection) || !this.matchesCurrentRun(run, projection)) return null
      return {
        hookId: hook.id,
        pullNumber: run.pullNumber,
        baseSha: run.baseSha,
        configRevision: hook.configRevision.toString(),
        dispatchRevision: hook.dispatchRevision.toString()
      }
    })
    if (targets.some((target) => target === null)) return { allowed: false }
    return { allowed: true, targets: targets.filter((target) => target !== null) }
  }

  private async resolveWorkflow(
    req: Extract<RcGithubRerequest, { scope: 'workflow' }>
  ): Promise<RcGithubRerequestResult> {
    const runs = await this.deps.hooks.listReviewRequestRequiredRuns(BigInt(req.repoId), req.headSha, req.pullNumber)
    if (
      runs.length === 0 ||
      new Set(runs.map((run) => run.hookId)).size !== runs.length ||
      new Set(runs.map((run) => run.pullNumber)).size !== 1
    ) {
      return { allowed: false }
    }

    const hooks = await this.deps.hooks.getManyUnscoped(runs.map((run) => run.hookId))
    const hooksById = new Map(hooks.map((hook) => [hook.id, hook]))
    const targets = runs.flatMap((run) => {
      const hook = hooksById.get(run.hookId) ?? null
      if (!this.matchesWorkflowRun(run, req) || !this.matchesWorkflowHook(hook, run)) return []
      return [
        {
          hookId: hook.id,
          pullNumber: run.pullNumber,
          baseSha: run.baseSha,
          configRevision: hook.configRevision.toString(),
          dispatchRevision: hook.dispatchRevision.toString()
        }
      ]
    })
    return targets.length > 0 ? { allowed: true, targets } : { allowed: false }
  }

  private matchesProjection(
    projection: HookReviewProjectionRecord | null,
    req: Pick<RcGithubRerequest, 'repoId' | 'headSha'>
  ): projection is HookReviewProjectionRecord & { checkRunId: string; currentHookRunId: string } {
    return (
      projection !== null &&
      projection.checkRunId !== null &&
      projection.currentHookRunId !== null &&
      projection.mode === 'check' &&
      projection.gateMode === 'informational' &&
      projection.tombstonedAt === null &&
      projection.writePhase === null &&
      projection.pendingIntent === null &&
      projection.repoId === BigInt(req.repoId) &&
      projection.headSha === req.headSha &&
      projection.reportSha === req.headSha &&
      projection.observedState !== null &&
      TERMINAL_CHECK_STATES.has(projection.observedState)
    )
  }

  private matchesCurrentHook(
    hook: HookRecord | null,
    projection: HookReviewProjectionRecord
  ): hook is HookRecord & { agentId: NonNullable<HookRecord['agentId']> } {
    return (
      hook !== null &&
      hook.enabled &&
      hook.kind === 'github' &&
      hook.agentId !== null &&
      hook.agentId === projection.agentId &&
      hook.repoId === projection.repoId &&
      hook.reportingMode === 'check' &&
      hook.gateMode === 'informational' &&
      hook.projectionEpoch === projection.projectionEpoch
    )
  }

  private matchesCurrentRun(
    run: HookRunRecord | null,
    projection: HookReviewProjectionRecord
  ): run is HookRunRecord & { pullNumber: number; baseSha: string } {
    return (
      run !== null &&
      run.id === projection.currentHookRunId &&
      run.hookId === projection.hookId &&
      run.projectionId === projection.id &&
      run.repoId === projection.repoId &&
      run.subjectKind === 'pull_request' &&
      run.pullNumber !== null &&
      run.headSha === projection.headSha &&
      run.reportSha === projection.reportSha &&
      run.baseSha !== null
    )
  }

  private matchesWorkflowRun(
    run: HookRunRecord,
    req: Extract<RcGithubRerequest, { scope: 'workflow' }>
  ): run is HookRunRecord & { pullNumber: number; baseSha: string; agentId: NonNullable<HookRunRecord['agentId']> } {
    return (
      run.status === 'failed' &&
      run.reason === HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED &&
      isGithubPullRequestRevisionEvent(run.event ?? undefined, { baseChanged: run.baseChanged === true }) &&
      run.projectionIntent === 'revision_event' &&
      run.repoId === BigInt(req.repoId) &&
      run.sourceInstallationId === BigInt(req.installationId) &&
      run.subjectKind === 'pull_request' &&
      run.pullNumber !== null &&
      (req.pullNumber === undefined || run.pullNumber === req.pullNumber) &&
      run.headSha === req.headSha &&
      run.reportSha === req.headSha &&
      run.baseSha !== null &&
      run.agentId !== null &&
      run.projectionEpoch !== null &&
      run.completedAt !== null &&
      run.turnStartedAt === null &&
      run.orphanedAt === null &&
      run.sessionId === null &&
      run.reviewAttemptId === null &&
      run.reviewAttemptState === null &&
      run.reviewErrorCode === null &&
      run.reviewId === null &&
      run.reviewEvent === null &&
      run.verdict === null
    )
  }

  private matchesWorkflowHook(
    hook: HookRecord | null,
    run: HookRunRecord & { agentId: NonNullable<HookRunRecord['agentId']> }
  ): hook is HookRecord & { agentId: NonNullable<HookRecord['agentId']> } {
    return (
      hook !== null &&
      hook.enabled &&
      hook.kind === 'github' &&
      hook.agentId === run.agentId &&
      hook.repoId === run.repoId &&
      hook.reviewPolicy !== 'off' &&
      hook.projectionEpoch === run.projectionEpoch
    )
  }
}
