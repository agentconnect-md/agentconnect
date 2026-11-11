// `cron/self` (agent-cron-tools-v1): an agent lists, saves and deletes the crons bound to it, from the daemon that serves it.
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import type { Handler } from './index.js'

export const handleAgentCron: Handler = async (frame, conn, deps) => {
  if (!isFrame('cron/self')(frame)) return
  if (!deps.agentCrons) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'agent cron tools are not enabled', false)
    return
  }
  // eslint-disable-next-line no-restricted-syntax -- the authenticated connection's own daemon row
  const daemon = await deps.registry.getUnscoped(DaemonId(conn.daemonId))
  const orgId = frame.orgId ? OrgId(frame.orgId) : daemon?.orgId
  const agent = orgId ? await deps.agent.get(orgId, AgentId(frame.payload.agentId)) : null
  if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId))) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'agent is not served by this daemon', false)
    return
  }
  try {
    const p = frame.payload
    const result =
      p.op === 'list'
        ? await deps.agentCrons.list(agent)
        : p.op === 'save'
          ? await deps.agentCrons.save(agent, p.cron)
          : await deps.agentCrons.remove(agent, p.cronId)
    conn.replyTo(frame, 'cron/self/result', result)
  } catch (error) {
    deps.log.error({ error, agentId: agent.id, op: frame.payload.op }, 'agent cron operation failed')
    conn.sendError(frame.id, 'INTERNAL', 'agent cron operation failed', true)
  }
}
