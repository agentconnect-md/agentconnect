// `computer-pool/acquire`: an agent daemon asks for its session's managed computer, or to wake a granted one (computer-use.md §15.1).
import { COMPUTER_POOL_QUOTA_FEATURE, isFrame, type ComputerPoolAcquireResult } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
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
    conn.replyTo(frame, 'computer-pool/acquire/result', await forDaemon(await pool.acquire(orgId, p), conn, deps))
  } catch (err) {
    deps.log.error({ err, agentId: p.agentId, sessionId: p.sessionId }, 'computer-pool/acquire failed')
    conn.sendError(frame.id, 'INTERNAL', 'managed computer acquire failed', true)
  }
}

// A daemon from before quotas cannot decode `quota_exceeded`, so it gets `failed` with the same message.
async function forDaemon(
  result: ComputerPoolAcquireResult,
  conn: DaemonConnection,
  deps: DaemonWsDeps
): Promise<ComputerPoolAcquireResult> {
  if (result.state !== 'failed' || result.code !== 'quota_exceeded') return result
  let reads = false
  try {
    // eslint-disable-next-line no-restricted-syntax -- the authenticated connection's own daemon row
    const daemon = await deps.registry.getUnscoped(DaemonId(conn.daemonId))
    reads = daemon?.capabilities.features.includes(COMPUTER_POOL_QUOTA_FEATURE) ?? false
  } catch {
    reads = false
  }
  return reads ? result : { ...result, code: 'failed' }
}
