/** `github/review-result`: converge one body-free review POST outcome. */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId, HookId } from '../../domain/ids.js'
import { GithubReviewBrokerError } from '../../github/review-broker.service.js'
import type { Handler } from './index.js'

export const handleGithubReviewResult: Handler = async (frame, conn, deps) => {
  if (!isFrame('github/review-result')(frame)) return
  if (!deps.githubReviewBroker) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'github review broker is not enabled', false)
    return
  }
  try {
    await deps.githubReviewBroker.recordResult(
      frame.payload,
      DaemonId(conn.daemonId),
      frame.orgId ?? conn.orgId ?? undefined
    )
    // Only a submitted mutation changes the informational Check. Await that
    // convergence before ACK so a daemon retry can close a crash window. A
    // proved non-effect has no projection edge to converge.
    if (frame.payload.result.state === 'submitted') {
      await deps.githubRunCoordinator?.afterReviewResult(HookId(frame.payload.hookId), frame.payload.deliveryKey)
    }
    conn.replyTo(frame, 'github/review-result/ok', { accepted: true })
  } catch (error) {
    if (error instanceof GithubReviewBrokerError) {
      conn.sendError(frame.id, error.code, error.message, error.retryable)
      return
    }
    conn.sendError(frame.id, 'INTERNAL', 'github review result persistence failed', true)
  }
}
