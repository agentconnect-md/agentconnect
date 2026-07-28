/**
 * `session/child-status` handler — the cross-daemon leg of a parent session following a child it
 * started (session-concept §5.4).
 *
 * A daemon-side agent calls `viewSessionStatus` on a child whose session lives on ANOTHER daemon.
 * Daemons cannot address each other (the relay carries message DELIVERY, not queries), and the CP
 * is the placement authority — so the CP resolves the child agent's owning daemon and forwards the
 * lineage pair there, returning that daemon's answer. Reply: `session/child-status/ok`.
 *
 * BODY-LOCALITY (§1/§12): this is bounded METADATA only — a status enum, a lifecycle state, and a
 * timestamp. No transcript, no message text, and the CP persists nothing it reads here.
 *
 * AUTHORIZATION IS TWO-SIDED, and neither half is sufficient alone:
 *   • HERE: `parentSessionId` is an untrusted claim from the asking daemon, so the CP verifies that
 *     session was actually reported by THIS daemon (and belongs to its org). Without this any
 *     daemon could name someone else's parent session and read its children.
 *   • ON THE OWNING DAEMON: it re-checks that the child's durable origin link really is that parent
 *     session. That is the real lineage rule and it is enforced where the session lives — the CP
 *     never asserts "this is your child", only "you own the session you claim to be asking as".
 *
 * Every negative outcome except an unreachable daemon collapses to `found:false`, matching the
 * daemon-local path: distinguishing "no such session" from "not yours" would let a caller probe for
 * sessions it may not read.
 */
import { isFrame } from '@agentconnect.md/protocol'
import type { ChildSessionStatus } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, SessionId } from '../../domain/ids.js'
import type { Handler } from './index.js'

const NOT_FOUND: ChildSessionStatus = { found: false }

export const handleChildSessionStatus: Handler = async (frame, conn, deps) => {
  if (!isFrame('session/child-status')(frame)) return
  const { parentSessionId, childSessionId, childAgentId } = frame.payload

  const daemon = await deps.registry.get(DaemonId(conn.daemonId))
  if (!daemon) return // unknown daemon (should not happen post-auth) — drop silently

  // (a) Prove the asking daemon owns the parent session it is asking AS. `daemonId` on the session
  // row is stamped by the CP from the authenticated socket and is never daemon-echoed, so it is
  // trustworthy here. Fail closed when the session is unknown to the CP.
  const parent = await deps.session.get(SessionId(parentSessionId))
  if (!parent || parent.daemonId !== conn.daemonId) {
    conn.replyTo(frame, 'session/child-status/ok', NOT_FOUND)
    return
  }

  // (b) Resolve the child agent's placement. Cross-org is refused outright: a status read must
  // never cross an org boundary even when both daemons are reachable.
  const childAgent = await deps.agent.get(AgentId(childAgentId))
  if (!childAgent || childAgent.orgId !== daemon.orgId || !childAgent.daemonId) {
    conn.replyTo(frame, 'session/child-status/ok', NOT_FOUND)
    return
  }

  // A child that turns out to live on the ASKING daemon needs no round trip — and forwarding it
  // back would deadlock the caller's own request. It should have been answered locally, so the only
  // way here is a stale placement view; answer the same way an unknown child is answered.
  if (childAgent.daemonId === conn.daemonId) {
    conn.replyTo(frame, 'session/child-status/ok', NOT_FOUND)
    return
  }

  const owner = deps.connReg.get(childAgent.daemonId)
  if (!owner || !owner.reachable) {
    // Transport-level, NOT an authorization verdict: the asking agent is told to retry rather than
    // that its child does not exist.
    conn.replyTo(frame, 'session/child-status/ok', { found: false, reason: 'offline' })
    return
  }

  try {
    const answer = await owner.conn.request<ChildSessionStatus>(
      'session/child-status/probe',
      { parentSessionId, childSessionId },
      { epoch: owner.sessionEpoch }
    )
    conn.replyTo(frame, 'session/child-status/ok', answer)
  } catch {
    // Timed out / socket dropped mid-flight. Same reasoning as the unreachable case above: report a
    // retryable transport failure, never a lineage denial.
    conn.replyTo(frame, 'session/child-status/ok', { found: false, reason: 'offline' })
  }
}
