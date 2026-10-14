// Persist hook completion and its projections before acknowledging the durable outbox report.
import { codeHostHookMetadataOf, isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, HookId } from '../../domain/ids.js'
import { reportedNoteState } from '../../codehost/note-projection.service.js'
import { githubHookRunSubject } from '../../github/hook-run-subject.js'
import { githubProjectionIntent } from '../../github/projection-intent.js'
import { hookRuntimeProjectionState } from '../../github/projection-state.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleHookReport: Handler = async (frame, conn, deps) => {
  if (!isFrame('hook/report')(frame)) return
  const p = frame.payload
  try {
    // The hook must live in the org the frame acts in (M4): a cross-org id reads as absent through the scoped read.
    const orgId = frameOrgId(frame, conn)
    const hook = orgId ? await deps.hook.get(orgId, HookId(p.hookId)) : null
    if (!orgId || !hook) {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'hook is not in the organization this frame acts in', false)
      return
    }
    const host = codeHostHookMetadataOf(p)
    const projectionIntent = githubProjectionIntent(
      p.event,
      host?.provider === 'github' ? host.metadata : undefined,
      p.reviewPolicy
    )
    const projectionDesiredState =
      p.reviewResult?.state === 'submitted'
        ? p.reviewResult.event === 'REQUEST_CHANGES' || p.reviewResult.verdict === 'fail'
          ? 'action_required'
          : p.reviewResult.verdict === 'pass'
            ? 'success'
            : 'neutral'
        : p.reviewResult
          ? 'failure'
          : (hookRuntimeProjectionState(p) ?? 'failure')
    const completedAt = new Date(deps.clock.now())
    const accepted = await deps.hook.recordReport(
      HookId(p.hookId),
      DaemonId(conn.daemonId),
      {
        deliveryKey: p.deliveryKey,
        ...(p.event ? { event: p.event } : {}),
        status: p.status,
        agentId: AgentId(p.agentId),
        ...(p.configRevision !== undefined ? { configRevision: BigInt(p.configRevision) } : {}),
        ...(p.dispatchRevision !== undefined ? { dispatchRevision: BigInt(p.dispatchRevision) } : {}),
        ...(p.dispatchDaemonId !== undefined ? { dispatchDaemonId: DaemonId(p.dispatchDaemonId) } : {}),
        ...(p.reviewPolicy !== undefined ? { reviewPolicySnapshot: p.reviewPolicy } : {}),
        ...(p.reportingMode !== undefined ? { reportingModeSnapshot: p.reportingMode } : {}),
        ...(p.gateMode !== undefined ? { gateModeSnapshot: p.gateMode } : {}),
        projectionIntent,
        ...githubHookRunSubject(host),
        ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        ...(p.reason ? { reason: p.reason } : {}),
        ...(p.publishedComment ? { publishedComment: p.publishedComment } : {}),
        ...(p.reviewAttemptId && p.reviewResult
          ? {
              reviewAttemptId: p.reviewAttemptId,
              reviewAttemptState:
                p.reviewResult.state === 'submitted'
                  ? ('submitted' as const)
                  : p.reviewResult.state === 'not_submitted'
                    ? ('released' as const)
                    : ('blocked' as const),
              ...(p.reviewResult.state === 'submitted'
                ? {
                    reviewId: p.reviewResult.reviewId,
                    reviewEvent: p.reviewResult.event,
                    verdict: p.reviewResult.verdict,
                    reviewCommitId: p.reviewResult.commitId
                  }
                : { reviewErrorCode: p.reviewResult.code })
            }
          : {}),
        projectionDesiredState,
        projectionNextAttemptAt: completedAt
      },
      completedAt
    )
    if (!accepted) {
      conn.sendError(frame.id, 'CONFLICT', 'hook completion does not match the accepted dispatch', false)
      return
    }
    await deps.githubRunCoordinator?.afterReport(HookId(p.hookId), p.deliveryKey)
    // The run projection's terminal edge (§16, gitea §10.4) is recorded before the ACK so a retried report cannot outrun the ledger.
    if (host && hook.kind === host.provider) {
      if (p.publishedOutput?.provider === host.provider) {
        await deps.codeHostFeedback?.outputPublished(
          orgId,
          p.agentId,
          host,
          `${p.publishedOutput.kind}:${p.publishedOutput.externalId}`,
          p.sessionId
        )
      }
      const edge = {
        hookId: p.hookId,
        agentId: p.agentId,
        deliveryKey: p.deliveryKey,
        orgId,
        state: reportedNoteState(p.status, p.reason),
        reason: p.reason ?? null,
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        snapshot: p,
        at: completedAt
      }
      if (host.provider === 'gitlab') await deps.codeHostNoteProjection?.afterReport({ ...edge, gitlab: host.metadata })
      else if (host.provider === 'gitea')
        await deps.giteaStatusProjection?.afterReport({ ...edge, gitea: host.metadata })
    }
    conn.replyTo(frame, 'ack', { ok: true })
  } catch (err) {
    deps.log.error({ err, daemonId: conn.daemonId, hookId: p.hookId }, 'hook/report: completion report failed')
    conn.sendError(frame.id, 'INTERNAL', 'hook completion report failed', true)
  }
}
