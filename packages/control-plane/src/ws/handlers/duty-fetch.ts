// `duty/fetch` handler — a duty grant opens the SERVING gate, it does not
// install. A member that won a duty for an agent it has never had pulls that
// agent's complete definition here, so grants stay thin and a member asks only
// for what it lacks. Holding the duty IS the authorization: the CP answers only
// for an agent this daemon currently holds an unexpired lease on.
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleDutyFetch: Handler = async (frame, conn, deps) => {
  if (!isFrame('duty/fetch')(frame)) return
  // The duty ledger is install-wide: an org-scoped connection never holds duties.
  if (conn.orgId !== null) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'duty ledger requires an install-wide connection', false)
    return
  }
  const agentId = AgentId(frame.payload.agentId)
  // The CP resolves the org from the agent itself — an asker never asserts it.
  const agent = await deps.agent.getUnscoped(agentId)
  // Unknown agent, no duty, or no assembler wired: all answer "install nothing".
  // An empty reply, never an error frame — the member's behavior is the same.
  if (!agent || !deps.agentBundle) {
    conn.replyTo(frame, 'duty/fetch/ok', {})
    return
  }
  if (!(await deps.dutyLease.holdsAgent(DaemonId(conn.daemonId), agentId))) {
    conn.replyTo(frame, 'duty/fetch/ok', {})
    return
  }
  conn.replyTo(frame, 'duty/fetch/ok', { bundle: await deps.agentBundle(agent) })
}
