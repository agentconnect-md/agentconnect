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
 * Trust boundary: the stamp only touches rows bound to the reported agent, and a daemon
 * the agent is no longer placed on stamps only the rows it recorded — on its own store
 * the content it purged was only ever there (#2246).
 *
 * WHAT THE REPLY MEANS, and why this does not use `runForReportingAgent`: the ACK
 * is what releases the daemon's receipt, and that receipt is the LAST COPY of the
 * fact — the local row is already gone, so an ACK that did not persist loses the
 * mark forever. That forces this handler to separate two outcomes the shared
 * helper collapses into one `false`:
 *   - the placement lease is held by a cold move (transient, and a move lasts as
 *     long as a drain) ⇒ retryable error, receipt KEPT;
 *   - the agent no longer exists (permanent) ⇒ ACK, because the claim can never
 *     be accepted and retrying it forever is worse than dropping it. This is what
 *     garbage-collects receipts for a deleted agent, whose `SessionMeta` rows
 *     cascaded away with it; a reporter the agent moved away from is ACKed too,
 *     after stamping what it recorded.
 */
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, SessionId } from '../../domain/ids.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleSessionPurged: Handler = async (frame, conn, deps) => {
  if (!isFrame('event/session-purged')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  const p = frame.payload
  const agentId = AgentId(p.agentId)
  const release = deps.agentMutations.tryBeginMutation(agentId)
  if (!release) {
    conn.sendError(frame.id, 'INTERNAL', 'agent placement is mutating; retry the purge receipt', true)
    return
  }
  try {
    const agent = await deps.agent.get(orgId, agentId)
    if (agent) {
      const reporter = DaemonId(conn.daemonId)
      const placed = await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, reporter)
      // A recorder the agent moved away from still purges what it recorded: on its own store the content was only ever there (#2246).
      await deps.session.markContentPurged(
        agentId,
        p.sessionIds.map((id) => SessionId(id)),
        p.reason,
        new Date(p.ts),
        placed ? undefined : reporter
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
