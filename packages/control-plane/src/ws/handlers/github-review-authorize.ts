/** `github/review-authorize`: reserve and mint one action-scoped review token. */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import { GithubReviewBrokerError } from '../../github/review-broker.service.js'
import type { Handler } from './index.js'

export const handleGithubReviewAuthorize: Handler = async (frame, conn, deps) => {
  if (!isFrame('github/review-authorize')(frame)) return
  if (!deps.githubReviewBroker) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'github review broker is not enabled', false)
    return
  }
  try {
    const authorized = await deps.githubReviewBroker.authorize(
      frame.payload,
      DaemonId(conn.daemonId),
      frame.orgId ?? conn.orgId ?? undefined
    )
    conn.replyTo(frame, 'github/review-authorized', authorized)
  } catch (error) {
    if (error instanceof GithubReviewBrokerError) {
      conn.sendError(frame.id, error.code, error.message, error.retryable)
      return
    }
    conn.sendError(frame.id, 'INTERNAL', 'github review authorization failed', true)
  }
}
