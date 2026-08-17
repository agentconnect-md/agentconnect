// `duty/claim` handler — the activation rendezvous (design §4.4). A member
// handed a trigger for an agent it does not serve claims that agent's group
// here. Winning creates or takes the lease and the member serves the trigger;
// losing names the incumbent so the relay can re-route in one more hop.
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleDutyClaim: Handler = async (frame, conn, deps) => {
  if (!isFrame('duty/claim')(frame)) return
  // The ledger's door (daemon-groups.md §3): whoever is in a member set may claim, whatever its
  // tenancy; a connection in no set holds its agents outright and never enters the ledger. The
  // per-agent narrowing is the predicate's, inside the transaction.
  if (conn.setId === null) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'duty ledger requires membership in a member set', false)
    return
  }
  const agentId = AgentId(frame.payload.agentId)
  // The CP resolves the org from the agent itself — a claimant never asserts it. An org-scoped
  // member reads org-fenced: the write-time invariants make it ineligible for every other org's
  // agents anyway, so nothing is lost by never loading one.
  // Install-wide read (INSTALL_WIDE_FRAME_TYPES): `duty/claim` carries no org by design,
  // because the member is asking about an agent it does not yet serve.
  const agent = conn.orgId
    ? await deps.agent.get(OrgId(conn.orgId), agentId)
    : // eslint-disable-next-line no-restricted-syntax -- install-wide rendezvous frame, no frame org exists
      await deps.agent.getUnscoped(agentId)
  if (!agent) {
    conn.replyTo(frame, 'duty/claim/ok', { granted: false })
    return
  }
  // The ledger applies the placement predicate to this member's own set membership rather than
  // trusting the trigger that got it here.
  const claim = await deps.dutyLease.claimAgentHome(agent.orgId, agentId, DaemonId(conn.daemonId))
  conn.replyTo(frame, 'duty/claim/ok', claim)
}
