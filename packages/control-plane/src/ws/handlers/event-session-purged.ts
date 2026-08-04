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
 * agent.
 *
 * WHAT THE REPLY MEANS, and why this does not use `runForReportingAgent`: the ACK
 * is what releases the daemon's receipt, and that receipt is the LAST COPY of the
 * fact — the local row is already gone, so an ACK that did not persist loses the
 * mark forever. That forces this handler to separate two outcomes the shared
 * helper collapses into one `false`:
 *   - the placement lease is held by a cold move (transient, and a move lasts as
 *     long as a drain) ⇒ retryable error, receipt KEPT;
 *   - the agent is not placed here / no longer exists (permanent) ⇒ ACK, because
 *     the claim can never be accepted and retrying it forever is worse than
 *     dropping it. This is also what garbage-collects receipts for a deleted
 *     agent, whose `SessionMeta` rows cascaded away with it.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, SessionId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleSessionPurged: Handler = async (frame, conn, deps) => {
  if (!isFrame('event/session-purged')(frame)) return
  const p = frame.payload
  const agentId = AgentId(p.agentId)
  const release = deps.agentMutations.tryBeginMutation(agentId)
  if (!release) {
    conn.sendError(frame.id, 'INTERNAL', 'agent placement is mutating; retry the purge receipt', true)
    return
  }
  try {
    const agent = await deps.agent.get(agentId)
    if (agent?.daemonId === DaemonId(conn.daemonId)) {
      await deps.session.markContentPurged(
        agentId,
        p.sessionIds.map((id) => SessionId(id)),
        p.reason,
        new Date(p.ts)
      )
    }
    // ACK only after the commit — the daemon releases its receipt on it.
    conn.replyTo(frame, 'ack', { ok: true })
  } catch {
    // Retryable: the receipt stays in the daemon's durable outbox and is
    // re-reported on the next sweep or reconnect.
    conn.sendError(frame.id, 'INTERNAL', 'session purge receipt failed to persist', true)
  } finally {
    release()
  }
}
