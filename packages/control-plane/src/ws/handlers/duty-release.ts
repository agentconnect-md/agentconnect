// `duty/release` handler — a draining member returns duty groups explicitly,
// vacating them now instead of waiting out T_reassign. Holder-conditional in
// the repo, so a stale releaser cannot vacate a successor's grant.
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleDutyRelease: Handler = async (frame, conn, deps) => {
  if (!isFrame('duty/release')(frame)) return
  // The duty ledger is install-wide: an org-scoped connection never holds duties.
  if (conn.orgId !== null) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'duty ledger requires an install-wide connection', false)
    return
  }
  await deps.dutyLease.release(DaemonId(conn.daemonId), frame.payload.groupIds)
  conn.replyTo(frame, 'ack', { ok: true })
}
