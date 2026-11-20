// Answer which addresses may write to an agent by mail, only for a daemon currently serving the agent; absent resolver admits nobody.
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleEmailMembers: Handler = async (frame, conn, deps) => {
  if (!isFrame('agent/email-members')(frame)) return
  try {
    const orgId = frameOrgId(frame, conn)
    const agent = orgId ? await deps.agent.get(orgId, AgentId(frame.payload.agentId)) : null
    if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId))) {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon does not serve that agent', false)
      return
    }
    const answer = deps.emailMembers ? await deps.emailMembers(frame.payload, orgId!) : { members: [] }
    conn.replyTo(frame, 'agent/email-members/ok', answer)
  } catch (error) {
    // A failed read is retryable, so the daemon does not admit the message and mail's own redelivery absorbs it (§4).
    deps.log.error({ error, agentId: frame.payload.agentId }, 'email member lookup failed')
    conn.sendError(frame.id, 'INTERNAL', 'email member lookup failed', true)
  }
}
