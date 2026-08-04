/**
 * `event/session-purged` handler — the retention-GC receipt (#485).
 *
 * A correlated REQ: the owning daemon deleted these sessions' local rows (and any
 * per-session worktree) once `sessions.retention` elapsed, so their transcripts
 * can never be pulled again. The CP KEEPS the metadata row — it is all that is
 * left of the session — and stamps `contentPurgedAt`, which is what lets the
 * console say "the transcript was deleted" instead of rendering a permanently
 * empty history as "this session said nothing".
 *
 * Trust boundary: same as `event/session` — the reported agent must be placed on
 * the authenticated daemon, and the stamp only touches rows already bound to that
 * agent. A claim failing either check is still ACKed: the daemon's local row is
 * gone either way, so its durable receipt has nothing left to converge and an
 * error would make it retry a report that can never be accepted.
 *
 * ACK only after the commit — the daemon releases the receipt on it, and that
 * receipt is the last copy of the fact.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, SessionId } from '../../domain/ids.js'
import type { Handler } from './index.js'
import { runForReportingAgent } from './reporting-agent.js'

export const handleSessionPurged: Handler = async (frame, conn, deps) => {
  if (!isFrame('event/session-purged')(frame)) return
  const p = frame.payload
  const agentId = AgentId(p.agentId)
  try {
    await runForReportingAgent(agentId, DaemonId(conn.daemonId), deps, async () => {
      await deps.session.markContentPurged(
        agentId,
        p.sessionIds.map((id) => SessionId(id)),
        p.reason,
        new Date(p.ts)
      )
    })
    conn.replyTo(frame, 'ack', { ok: true })
  } catch {
    // Retryable: the receipt stays in the daemon's durable outbox and is
    // re-reported on the next sweep or reconnect.
    conn.sendError(frame.id, 'INTERNAL', 'session purge receipt failed to persist', true)
  }
}
