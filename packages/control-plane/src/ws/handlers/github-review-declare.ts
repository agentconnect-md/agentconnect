/** `github/review-declare`: the Agent is starting the review a mention offered, so its Check shows in progress. */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId, HookId } from '../../domain/ids.js'
import { GithubReviewBrokerError } from '../../github/review-broker.service.js'
import type { Handler } from './index.js'

export const handleGithubReviewDeclare: Handler = async (frame, conn, deps) => {
  if (!isFrame('github/review-declare')(frame)) return
  if (!deps.githubReviewBroker) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'github review broker is not enabled', false)
    return
  }
  try {
    await deps.githubReviewBroker.declare(
      frame.payload,
      DaemonId(conn.daemonId),
      frame.orgId ?? conn.orgId ?? undefined
    )
    // Converge before the ACK so a daemon retry closes a crash between the stamp and the Check.
    await deps.githubRunCoordinator?.afterReviewDeclared(HookId(frame.payload.hookId), frame.payload.deliveryKey)
    conn.replyTo(frame, 'github/review-declare/ok', { accepted: true })
  } catch (error) {
    if (error instanceof GithubReviewBrokerError) {
      conn.sendError(frame.id, error.code, error.message, error.retryable)
      return
    }
    conn.sendError(frame.id, 'INTERNAL', 'github review declaration failed', true)
  }
}
