/** `assistant/follow-up-watch`: a daemon's watches for the follow-ups of an agent it serves (assistant-mode.md §5.14). */
import { FOLLOW_UP_WAKE_FEATURE, isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import type { Handler } from './index.js'

export const handleFollowUpWatch: Handler = async (frame, conn, deps) => {
  if (!isFrame('assistant/follow-up-watch')(frame)) return
  if (!deps.followUpWatch) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'event wake is not enabled', false)
    return
  }
  // eslint-disable-next-line no-restricted-syntax -- the authenticated connection's own daemon row
  const daemon = await deps.registry.getUnscoped(DaemonId(conn.daemonId))
  if (!daemon?.capabilities.features.includes(FOLLOW_UP_WAKE_FEATURE)) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'daemon did not advertise follow-up wake support', false)
    return
  }
  const orgId = frame.orgId ? OrgId(frame.orgId) : daemon.orgId
  const agent = orgId ? await deps.agent.get(orgId, AgentId(frame.payload.agentId)) : null
  if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId))) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'agent is not served by this daemon', false)
    return
  }
  try {
    conn.replyTo(frame, 'assistant/follow-up-watch/result', await deps.followUpWatch.apply(agent, frame.payload))
  } catch (error) {
    deps.log.error({ error, agentId: agent.id }, 'follow-up watch failed')
    conn.sendError(frame.id, 'INTERNAL', 'follow-up watch failed', true)
  }
}
