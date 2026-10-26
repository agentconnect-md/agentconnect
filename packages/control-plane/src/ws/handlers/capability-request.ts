/** `capability/request`, `capability/withdraw`, `capability/decide`: an agent's capability requests from the daemon that serves it (capability-requests.md §4.1, §4.4.4). */
import { CAPABILITY_REQUESTS_FEATURE, isFrame, type AnyFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import type { AgentRecord } from '../../persistence/ports.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import type { Handler } from './index.js'

/** The agent the frame names, when this daemon serves it and capability requests are on; otherwise the frame is refused. */
async function servedAgent(
  frame: AnyFrame & { payload: { agentId: string } },
  conn: DaemonConnection,
  deps: DaemonWsDeps
): Promise<AgentRecord | null> {
  if (!deps.capabilityRequests) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'capability requests are not enabled', false)
    return null
  }
  // eslint-disable-next-line no-restricted-syntax -- the authenticated connection's own daemon row
  const daemon = await deps.registry.getUnscoped(DaemonId(conn.daemonId))
  if (!daemon?.capabilities.features.includes(CAPABILITY_REQUESTS_FEATURE)) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'daemon did not advertise capability request support', false)
    return null
  }
  const orgId = frame.orgId ? OrgId(frame.orgId) : daemon.orgId
  const agent = orgId ? await deps.agent.get(orgId, AgentId(frame.payload.agentId)) : null
  if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId))) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'agent is not served by this daemon', false)
    return null
  }
  return agent
}

export const handleCapabilityRequest: Handler = async (frame, conn, deps) => {
  if (!isFrame('capability/request')(frame)) return
  const agent = await servedAgent(frame, conn, deps)
  if (!agent) return
  try {
    conn.replyTo(frame, 'capability/request/result', await deps.capabilityRequests!.request(agent, frame.payload))
  } catch (error) {
    deps.log.error({ error, agentId: agent.id }, 'capability request failed')
    conn.sendError(frame.id, 'INTERNAL', 'capability request failed', true)
  }
}

export const handleCapabilityWithdraw: Handler = async (frame, conn, deps) => {
  if (!isFrame('capability/withdraw')(frame)) return
  const agent = await servedAgent(frame, conn, deps)
  if (!agent) return
  try {
    conn.replyTo(frame, 'capability/withdraw/result', await deps.capabilityRequests!.withdraw(agent, frame.payload))
  } catch (error) {
    deps.log.error({ error, agentId: agent.id }, 'capability withdraw failed')
    conn.sendError(frame.id, 'INTERNAL', 'capability withdraw failed', true)
  }
}

export const handleCapabilityDecide: Handler = async (frame, conn, deps) => {
  if (!isFrame('capability/decide')(frame)) return
  const agent = await servedAgent(frame, conn, deps)
  if (!agent) return
  try {
    conn.replyTo(frame, 'capability/decide/result', await deps.capabilityRequests!.decide(agent, frame.payload))
  } catch (error) {
    deps.log.error({ error, agentId: agent.id }, 'capability decide failed')
    conn.sendError(frame.id, 'INTERNAL', 'capability decide failed', true)
  }
}
