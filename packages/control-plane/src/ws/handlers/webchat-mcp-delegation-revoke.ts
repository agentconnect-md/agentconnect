import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import { DELEGATION_DENIED } from '../../registry/webchatMcpDelegationService.js'
import type { Handler } from './index.js'

const deny = (frameId: string, conn: Parameters<Handler>[1]): void => {
  conn.sendError(frameId, 'DELEGATION_DENIED', DELEGATION_DENIED.message, false)
}

/** Best-effort logical-session revocation, fenced to the authenticated daemon. */
export const handleWebchatMcpDelegationRevoke: Handler = async (frame, conn, deps) => {
  if (!isFrame('webchat/mcp-delegation/revoke')(frame)) return

  try {
    const delegations = deps.webchatMcpDelegations
    if (!delegations) {
      deny(frame.id, conn)
      return
    }
    const current = await delegations.get(frame.payload.delegationId)
    if (!current || current.daemonId !== conn.daemonId || current.generation !== frame.payload.generation) {
      deny(frame.id, conn)
      return
    }

    const revoked = await delegations.revoke({
      delegationId: current.id,
      conversationId: current.conversationId,
      generation: current.generation,
      userId: current.userId,
      orgId: OrgId(current.orgId),
      agentId: AgentId(current.agentId),
      daemonId: DaemonId(current.daemonId),
      revokedAt: new Date(deps.clock.now()),
      reason: frame.payload.reason
    })
    if (!revoked) {
      deny(frame.id, conn)
      return
    }

    conn.replyTo(frame, 'webchat/mcp-delegation/revoked', {
      delegationId: current.id,
      generation: current.generation,
      revoked: true
    })
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'delegated MCP revoke failed', true)
  }
}
