import { isFrame } from '@agentconnect.md/protocol'
import { DELEGATION_DENIED, INVOCATION_CONFLICT } from '../../registry/webchatMcpDelegationService.js'
import type { Handler } from './index.js'

/**
 * Mint a one-time MCP assertion for the authenticated daemon connection.
 *
 * The wire payload deliberately has no daemon id. Authority always comes from
 * the connection actor established by daemon authentication.
 */
export const handleMcpInvocationMint: Handler = async (frame, conn, deps) => {
  if (!isFrame('mcp/invocation/mint')(frame)) return

  try {
    const service = deps.webchatMcpDelegation
    if (!service) {
      conn.sendError(frame.id, 'DELEGATION_DENIED', DELEGATION_DENIED.message, false)
      return
    }
    const result = await service.mintInvocation({
      ...frame.payload,
      authenticatedDaemonId: conn.daemonId
    })
    if (result.kind === 'minted') {
      conn.replyTo(frame, 'mcp/invocation/minted', {
        invocationId: result.invocationId,
        assertion: result.assertion,
        expiresAt: result.expiresAt
      })
      return
    }
    if (result.kind === 'conflict') {
      conn.sendError(frame.id, 'INVOCATION_CONFLICT', INVOCATION_CONFLICT.message, false)
      return
    }
    // A same-binding invocation that already started/finished does not mint a
    // second credential and is not a binding conflict.
    conn.sendError(frame.id, 'DELEGATION_DENIED', DELEGATION_DENIED.message, false)
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'delegated MCP mint failed', true)
  }
}
