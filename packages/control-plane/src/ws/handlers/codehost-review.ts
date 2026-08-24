/**
 * `codehost/*` — the provider-neutral formal-review control surface
 * (gitlab-com-integration.md §15.1, §15.2, §17.2).
 *
 * Four correlated REQs: authorize an attempt and take the publication lease, run
 * the single-use operation ledger, renew the lease, and record the one body-free
 * terminal outcome. Every one of them is organization-scoped, so an install-wide
 * connection must name its org on the frame.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import { CodeHostReviewBrokerError } from '../../codehost/review-lease.service.js'
import { frameOrgId } from './frame-org.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import type { Handler } from './index.js'

/** Shared prelude: the broker has to exist and the frame has to name its org. */
function ready(frameId: string, conn: DaemonConnection, deps: DaemonWsDeps, orgId: string | null): boolean {
  if (!deps.codeHostReviewBroker) {
    conn.sendError(frameId, 'SCOPE_DENIED', 'code-host reviews are not enabled on this control plane', false)
    return false
  }
  if (!orgId) {
    conn.sendError(frameId, 'SCOPE_DENIED', 'organization is required', false)
    return false
  }
  return true
}

function fail(frameId: string, conn: DaemonConnection, error: unknown, fallback: string): void {
  if (error instanceof CodeHostReviewBrokerError) {
    conn.sendError(frameId, error.code, error.message, error.retryable)
    return
  }
  conn.sendError(frameId, 'INTERNAL', fallback, true)
}

export const handleCodeHostReviewAuthorize: Handler = async (frame, conn, deps) => {
  if (!isFrame('codehost/review-authz')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!ready(frame.id, conn, deps, orgId)) return
  try {
    const answer = await deps.codeHostReviewBroker!.authorize(frame.payload, DaemonId(conn.daemonId), orgId!)
    conn.replyTo(frame, 'codehost/review-authz/result', answer)
  } catch (error) {
    fail(frame.id, conn, error, 'code-host review authorization failed')
  }
}

export const handleCodeHostReviewOp: Handler = async (frame, conn, deps) => {
  if (!isFrame('codehost/review-op')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!ready(frame.id, conn, deps, orgId)) return
  try {
    const accepted = await deps.codeHostReviewBroker!.operate(frame.payload, DaemonId(conn.daemonId), orgId!)
    conn.replyTo(frame, 'codehost/review-op/ok', accepted)
  } catch (error) {
    fail(frame.id, conn, error, 'code-host review operation record failed')
  }
}

export const handleCodeHostReviewLeaseRenew: Handler = async (frame, conn, deps) => {
  if (!isFrame('codehost/review-lease-renew')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!ready(frame.id, conn, deps, orgId)) return
  try {
    const renewed = await deps.codeHostReviewBroker!.renew(frame.payload, DaemonId(conn.daemonId), orgId!)
    conn.replyTo(frame, 'codehost/review-lease-renew/ok', renewed)
  } catch (error) {
    fail(frame.id, conn, error, 'code-host review lease renewal failed')
  }
}

export const handleCodeHostReviewResult: Handler = async (frame, conn, deps) => {
  if (!isFrame('codehost/review-result')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!ready(frame.id, conn, deps, orgId)) return
  try {
    const accepted = await deps.codeHostReviewBroker!.recordResult(frame.payload, DaemonId(conn.daemonId), orgId!)
    conn.replyTo(frame, 'codehost/review-result/ok', accepted)
  } catch (error) {
    fail(frame.id, conn, error, 'code-host review result persistence failed')
  }
}
