import { isFrame } from '@agentconnect.md/protocol'
import type { Handler } from './index.js'

const denied = (frameId: string, conn: Parameters<Handler>[1]) =>
  conn.sendError(frameId, 'DELEGATION_DENIED', 'Remote MCP grant is not authorized.', false)

export const handleWebchatMcpGrantIssue: Handler = async (frame, conn, deps) => {
  if (!isFrame('webchat/mcp-grant/issue')(frame)) return
  try {
    const issued = await deps.webchatRemoteMcp?.issue({
      ...frame.payload,
      authenticatedDaemonId: conn.daemonId
    })
    if (!issued) return denied(frame.id, conn)
    conn.replyTo(frame, 'webchat/mcp-grant/issued', issued)
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'remote MCP grant issuance failed', true)
  }
}

export const handleWebchatMcpGrantAccept: Handler = async (frame, conn, deps) => {
  if (!isFrame('webchat/mcp-grant/accept')(frame)) return
  try {
    const activated = await deps.webchatRemoteMcp?.accept({
      ...frame.payload,
      authenticatedDaemonId: conn.daemonId
    })
    if (!activated) return denied(frame.id, conn)
    conn.replyTo(frame, 'webchat/mcp-grant/activate', { ...frame.payload, activated: true })
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'remote MCP grant activation failed', true)
  }
}

export const handleWebchatMcpGrantRevoke: Handler = async (frame, conn, deps) => {
  if (!isFrame('webchat/mcp-grant/revoke')(frame)) return
  try {
    const revoked =
      (await deps.webchatRemoteMcp?.revoke({
        ...frame.payload,
        authenticatedDaemonId: conn.daemonId
      })) ?? false
    if (!revoked) return denied(frame.id, conn)
    conn.replyTo(frame, 'webchat/mcp-grant/revoked', {
      authorityId: frame.payload.authorityId,
      authorityGeneration: frame.payload.authorityGeneration,
      conversationId: frame.payload.conversationId,
      revoked: true
    })
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'remote MCP grant revocation failed', true)
  }
}
