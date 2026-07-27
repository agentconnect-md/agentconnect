import type { RcGithubRerequest, RcGithubRerequestResult } from '@agentconnect.md/protocol'
import type { HookRecord, HookRepo, HookReviewProjectionRecord, HookRunRecord } from '../persistence/ports.js'

export interface GithubRerequestDeps {
  hooks: Pick<
    HookRepo,
    'findReviewProjectionByCheckRunId' | 'listReviewProjectionsForSuiteRerequest' | 'get' | 'getMany' | 'getRunById'
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

/**
 * Resolve a signature-verified GitHub Check Run or Check Suite rerequest
 * without trusting the webhook to choose a hook or agent. Durable projections
 * are fenced to their current informational hooks and runs.
 */
export class GithubRerequestService {
  constructor(private readonly deps: GithubRerequestDeps) {}

  async resolve(req: RcGithubRerequest): Promise<RcGithubRerequestResult> {
    return 'checkRunId' in req ? this.resolveRun(req) : this.resolveSuite(req)
  }

  private async resolveRun(req: Extract<RcGithubRerequest, { checkRunId: string }>): Promise<RcGithubRerequestResult> {
    const projection = await this.deps.hooks.findReviewProjectionByCheckRunId(req.checkRunId)
    if (!this.matchesProjection(projection, req)) return { allowed: false }

    const [hook, run] = await Promise.all([
      this.deps.hooks.get(projection.hookId),
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
      this.deps.hooks.getMany(current.map((projection) => projection.hookId)),
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
}
