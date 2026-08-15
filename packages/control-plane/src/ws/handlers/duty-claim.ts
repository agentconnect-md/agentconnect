// `duty/claim` handler — the activation rendezvous (design §4.4). A member
// handed a trigger for an agent it does not serve claims that agent's group
// here. Winning creates or takes the lease and the member serves the trigger;
// losing names the incumbent so the relay can re-route in one more hop.
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleDutyClaim: Handler = async (frame, conn, deps) => {
  if (!isFrame('duty/claim')(frame)) return
  // The duty ledger is install-wide: an org-scoped connection never holds duties.
  if (conn.orgId !== null) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'duty ledger requires an install-wide connection', false)
    return
  }
  const agentId = AgentId(frame.payload.agentId)
  // The CP resolves the org from the agent itself — a claimant never asserts it.
  const agent = await deps.agent.getUnscoped(agentId)
  if (!agent) {
    conn.replyTo(frame, 'duty/claim/ok', { granted: false })
    return
  }
  // The ledger applies the placement predicate to this member's own set membership rather than
  // trusting the trigger that got it here.
  const claim = await deps.dutyLease.claimAgentHome(agent.orgId, agentId, DaemonId(conn.daemonId))
  conn.replyTo(frame, 'duty/claim/ok', claim)
}
