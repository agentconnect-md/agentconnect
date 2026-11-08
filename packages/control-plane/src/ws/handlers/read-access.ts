// Resolve an asker's session visibility only for a daemon currently serving the agent.
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleReadAccess: Handler = async (frame, conn, deps) => {
  if (!isFrame('agent/read-access')(frame)) return
  try {
    const orgId = frameOrgId(frame, conn)
    const servesAgent = async () => {
      const agent = orgId ? await deps.agent.get(orgId, AgentId(frame.payload.agentId)) : null
      return agent !== null && (await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId))
    }
    if (!(await servesAgent())) {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon does not serve that agent', false)
      return
    }
    const answer = deps.readAccess
      ? await deps.readAccess(frame.payload, orgId!)
      : { asker: 'unidentifiable' as const, visibleSessionIds: [] }
    if (!(await servesAgent())) {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'this daemon no longer serves that agent', false)
      return
    }
    conn.replyTo(frame, 'agent/read-access/ok', answer)
  } catch (error) {
    deps.log.error({ error, agentId: frame.payload.agentId }, 'read access lookup failed')
    conn.sendError(frame.id, 'INTERNAL', 'read access lookup failed', true)
  }
}
