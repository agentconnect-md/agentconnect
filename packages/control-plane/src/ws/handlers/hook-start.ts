/** `hook/start` metadata barrier: persist before the accepted turn is prompted. */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId, HookId } from '../../domain/ids.js'
import { GithubReviewBrokerError } from '../../github/review-broker.service.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleHookStart: Handler = async (frame, conn, deps) => {
  if (!isFrame('hook/start')(frame)) return
  if (!deps.githubReviewBroker) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'github review broker is not enabled', false)
    return
  }
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
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
