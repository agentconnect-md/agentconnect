// `computer-channel/grant`: an agent daemon asks for a per-session token to reach a desktop daemon's `/mcp` (computer-use.md §3.7).
import { isFrame } from '@agentconnect.md/protocol'
import type { Handler } from './index.js'
import { frameOrgId } from './frame-org.js'
import { servedAgent } from './computer-lease.js'

export const handleComputerChannelGrant: Handler = async (frame, conn, deps) => {
  if (!isFrame('computer-channel/grant')(frame)) return
  const orgId = frameOrgId(frame, conn)
  const grants = deps.computerChannelGrants
  if (!orgId || !grants) {
    conn.sendError(frame.id, orgId ? 'UNKNOWN_FRAME' : 'SCOPE_DENIED', 'computer channels are unavailable', false)
    return
  }
  const p = frame.payload
  try {
    if (!(await servedAgent(orgId, p.agentId, conn, deps))) {
      conn.replyTo(frame, 'computer-channel/grant/result', {
        granted: false,
        code: 'denied',
        message: 'this daemon does not serve the agent'
      })
      return
    }
    const result = await grants.grant(orgId, p.computerId, {
      agentId: p.agentId,
      sessionId: p.sessionId,
      daemonId: conn.daemonId
    })
    // The reply carries a bearer token and is never logged.
    conn.replyTo(frame, 'computer-channel/grant/result', result)
  } catch (err) {
    deps.log.error({ err, computerId: p.computerId, sessionId: p.sessionId }, 'computer-channel/grant failed')
    conn.sendError(frame.id, 'INTERNAL', 'computer channel grant failed', true)
  }
}
