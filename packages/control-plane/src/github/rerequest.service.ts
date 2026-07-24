import type { RcGithubRerequest, RcGithubRerequestResult } from '@agentconnect.md/protocol'
import type { HookRecord, HookRepo, HookReviewProjectionRecord, HookRunRecord } from '../persistence/ports.js'

export interface GithubRerequestDeps {
  hooks: Pick<HookRepo, 'findReviewProjectionByCheckRunId' | 'get' | 'getRunById'>
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
 * Resolve a signature-verified GitHub Check Run rerequest without trusting the
 * webhook to choose a hook or agent. The opaque Check id is reverse-mapped to a
 * durable projection, then fenced to its current informational hook and run.
 */
export class GithubRerequestService {
  constructor(private readonly deps: GithubRerequestDeps) {}

  async resolve(req: RcGithubRerequest): Promise<RcGithubRerequestResult> {
    const projection = await this.deps.hooks.findReviewProjectionByCheckRunId(req.checkRunId)
    if (!this.matchesProjection(projection, req) || !projection.currentHookRunId) return { allowed: false }

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

  private matchesProjection(
    projection: HookReviewProjectionRecord | null,
    req: RcGithubRerequest
  ): projection is HookReviewProjectionRecord {
    return (
      projection !== null &&
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
