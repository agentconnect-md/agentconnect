// `computer-lease/acquire` and `computer-lease/release`: an agent daemon takes or gives up a Computer control lease (computer-use.md §4.4).
import { COMPUTER_LEASE_AGENT_NAME_MAX, isFrame } from '@agentconnect.md/protocol'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { AgentId, DaemonId, type OrgId } from '../../domain/ids.js'
import type { AgentRecord } from '../../persistence/ports.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

// Only a daemon that serves the agent may act for its sessions.
export async function servedAgent(
  orgId: OrgId,
  agentId: string,
  conn: DaemonConnection,
  deps: DaemonWsDeps
): Promise<AgentRecord | null> {
  const agent = await deps.agent.get(orgId, AgentId(agentId))
  if (!agent) return null
  return (await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, DaemonId(conn.daemonId))) ? agent : null
}

export const handleComputerLeaseAcquire: Handler = async (frame, conn, deps) => {
  if (!isFrame('computer-lease/acquire')(frame)) return
  const orgId = frameOrgId(frame, conn)
  const leases = deps.computerLeases
  if (!orgId || !leases) {
    conn.sendError(frame.id, orgId ? 'UNKNOWN_FRAME' : 'SCOPE_DENIED', 'computer leases are unavailable', false)
    return
  }
  const p = frame.payload
  try {
    const agent = await servedAgent(orgId, p.agentId, conn, deps)
    if (!agent) {
      conn.replyTo(frame, 'computer-lease/acquire/result', {
        granted: false,
        code: 'denied',
        message: 'this daemon does not serve the agent'
      })
      return
    }
    const outcome = await leases.acquire(
      orgId,
      p.computerId,
      {
        sessionId: p.sessionId,
        agentId: p.agentId,
        // Display names are unbounded; an over-long holder name would make the lease frames undecodable.
        agentName: (agent.displayName ?? agent.name).slice(0, COMPUTER_LEASE_AGENT_NAME_MAX),
        daemonId: conn.daemonId,
        turnAt: Date.parse(p.requestedAt)
      },
      p.waitMs === undefined ? undefined : { waitMs: p.waitMs, signal: conn.closedSignal }
    )
    conn.replyTo(
      frame,
      'computer-lease/acquire/result',
      outcome.granted
        ? { granted: true, lease: outcome.view }
        : {
            granted: false,
            code: outcome.code,
            message: outcome.message,
            ...(outcome.holder ? { holder: outcome.holder } : {}),
            ...(outcome.queued ? { queued: outcome.queued } : {})
          }
    )
  } catch (err) {
    deps.log.error({ err, computerId: p.computerId, sessionId: p.sessionId }, 'computer-lease/acquire failed')
    conn.sendError(frame.id, 'INTERNAL', 'computer lease acquire failed', true)
  }
}

export const handleComputerLeaseRelease: Handler = async (frame, conn, deps) => {
  if (!isFrame('computer-lease/release')(frame)) return
  const orgId = frameOrgId(frame, conn)
  const leases = deps.computerLeases
  if (!orgId || !leases) {
    conn.sendError(frame.id, orgId ? 'UNKNOWN_FRAME' : 'SCOPE_DENIED', 'computer leases are unavailable', false)
    return
  }
  const p = frame.payload
  try {
    if (!(await servedAgent(orgId, p.agentId, conn, deps))) {
      conn.replyTo(frame, 'ack', { ok: false, reason: 'this daemon does not serve the agent' })
      return
    }
    await leases.release(orgId, p.computerId, { sessionId: p.sessionId, agentId: p.agentId })
    conn.replyTo(frame, 'ack', { ok: true })
  } catch (err) {
    deps.log.error({ err, computerId: p.computerId, sessionId: p.sessionId }, 'computer-lease/release failed')
    conn.sendError(frame.id, 'INTERNAL', 'computer lease release failed', true)
  }
}
