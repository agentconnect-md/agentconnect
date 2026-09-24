/** Persist active GitHub review preparation before projecting it into Checks. */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId, HookId } from '../../domain/ids.js'
import { GithubReviewBrokerError } from '../../github/review-broker.service.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleHookPreparing: Handler = async (frame, conn, deps) => {
  if (!isFrame('hook/preparing')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  if (!deps.githubReviewBroker) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'github review broker is not enabled', false)
    return
  }
  try {
    await deps.githubReviewBroker.prepare(frame.payload, DaemonId(conn.daemonId), orgId)
    await deps.githubRunCoordinator?.afterPreparing(HookId(frame.payload.hookId), frame.payload.deliveryKey)
    conn.replyTo(frame, 'hook/preparing/ok', { accepted: true })
  } catch (error) {
    if (error instanceof GithubReviewBrokerError) {
      conn.sendError(frame.id, error.code, error.message, error.retryable)
      return
    }
    conn.sendError(frame.id, 'INTERNAL', 'hook preparation reporting failed', true)
  }
}
