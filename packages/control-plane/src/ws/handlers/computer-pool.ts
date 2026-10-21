// `computer-pool/acquire`: an agent daemon asks for its session's managed computer, or to wake a granted one (computer-use.md §15.1).
import { isFrame } from '@agentconnect.md/protocol'
import type { Handler } from './index.js'
import { frameOrgId } from './frame-org.js'
import { servedAgent } from './computer-lease.js'

export const handleComputerPoolAcquire: Handler = async (frame, conn, deps) => {
  if (!isFrame('computer-pool/acquire')(frame)) return
  const orgId = frameOrgId(frame, conn)
  const pool = deps.computerPool
  if (!orgId || !pool) {
    conn.sendError(frame.id, orgId ? 'UNKNOWN_FRAME' : 'SCOPE_DENIED', 'managed computers are unavailable', false)
    return
  }
  const p = frame.payload
  try {
    if (!(await servedAgent(orgId, p.agentId, conn, deps))) {
      conn.replyTo(frame, 'computer-pool/acquire/result', {
        state: 'failed',
        code: 'denied',
        message: 'this daemon does not serve the agent'
      })
      return
    }
    conn.replyTo(frame, 'computer-pool/acquire/result', await pool.acquire(orgId, p))
  } catch (err) {
    deps.log.error({ err, agentId: p.agentId, sessionId: p.sessionId }, 'computer-pool/acquire failed')
    conn.sendError(frame.id, 'INTERNAL', 'managed computer acquire failed', true)
  }
}
