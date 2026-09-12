/**
 * `hook/report` handler (webhook-triggers-and-github-events.md decision 12).
 *
 * A correlated REQ: the daemon's completion report for a hook
 * fire it received over the relay's rd/* wire — closes the `HookRun` row the
 * relay's `rc/run-report` opened. Same discipline as `cron/report`: the repo
 * write is scoped (the REPORTING daemon must be the run's dispatch target or
 * serve its agent now) and last-writer-wins (a late completion overwrites a reaped
 * `orphaned`). Unknown or foreign reports receive a permanent CONFLICT so the
 * daemon can dead-letter its durable outbox entry; exact duplicates ACK.
 * A completion whose delivery report was lost (CP down at fire time) still
 * creates the row. ACK is sent only after the durable run and its R2a
 * projection converge, allowing the daemon to release the report outbox body.
 */
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
  try {
    await deps.githubRunCoordinator?.afterReport(HookId(p.hookId), p.deliveryKey)
    // The run projection's terminal edge (§16, gitea §10.4) is recorded before the ACK so a retried report cannot outrun the ledger.
    if (host && hook.kind === host.provider) {
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
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'hook completion projection failed', true)
  }
}
