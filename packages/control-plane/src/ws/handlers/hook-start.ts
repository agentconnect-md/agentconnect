/** `hook/start` metadata barrier: persist before the accepted turn is prompted. */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId, HookId } from '../../domain/ids.js'
import { CodeHostReviewBrokerError } from '../../codehost/review-lease.service.js'
import { GithubReviewBrokerError } from '../../github/review-broker.service.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleHookStart: Handler = async (frame, conn, deps) => {
  if (!isFrame('hook/start')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  // The provider one-of routes the barrier (§17.2): the GitLab arm records the started head on the
  // accepted run and opens the §16 projection's `running` edge, with no GitHub review broker in it.
  if (frame.payload.gitlab) {
    if (!deps.codeHostReviewBroker) {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'code-host reviews are not enabled on this control plane', false)
      return
    }
    const hook = await deps.hook.get(orgId, HookId(frame.payload.hookId))
    if (!hook || hook.kind !== 'gitlab') {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'hook is not a gitlab hook in this organization', false)
      return
    }
    try {
      await deps.codeHostReviewBroker.start(frame.payload, DaemonId(conn.daemonId), orgId)
      // The OK is the daemon's prompt barrier, so the durable start and its projection generation
      // both converge before it is sent; a retry is safe because both writes are idempotent.
      await deps.codeHostNoteProjection?.afterStart({
        hookId: frame.payload.hookId,
        agentId: frame.payload.agentId,
        deliveryKey: frame.payload.deliveryKey,
        orgId,
        state: 'running',
        ...(frame.payload.sessionId ? { sessionId: frame.payload.sessionId } : {}),
        gitlab: frame.payload.gitlab,
        snapshot: frame.payload,
        at: new Date(deps.clock.now())
      })
      conn.replyTo(frame, 'hook/start/ok', { accepted: true })
    } catch (error) {
      if (error instanceof CodeHostReviewBrokerError) {
        conn.sendError(frame.id, error.code, error.message, error.retryable)
        return
      }
      conn.sendError(frame.id, 'INTERNAL', 'hook start barrier failed', true)
    }
    return
  }
  if (!deps.githubReviewBroker) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'github review broker is not enabled', false)
    return
  }
  try {
    await deps.githubReviewBroker.start(frame.payload, DaemonId(conn.daemonId), orgId)
    // The OK is the daemon's prompt barrier. Do not acknowledge until both the
    // authoritative HookRun start and its durable R2a projection intent have
    // converged; a retry is safe because both writes are idempotent.
    await deps.githubRunCoordinator?.afterStart(HookId(frame.payload.hookId), frame.payload.deliveryKey)
    conn.replyTo(frame, 'hook/start/ok', { accepted: true })
  } catch (error) {
    if (error instanceof GithubReviewBrokerError) {
      conn.sendError(frame.id, error.code, error.message, error.retryable)
      return
    }
    conn.sendError(frame.id, 'INTERNAL', 'hook start barrier failed', true)
  }
}
