import type { DaemonBootstrapResult } from '@agentconnect.md/protocol'
import type { Handler } from './index.js'

/** Record installer failure; installation success still requires READY. */
export const handleDaemonBootstrapResult: Handler = async (frame, conn, deps) => {
  if (frame.type !== 'daemon/bootstrap/result') return
  const result = frame.payload as DaemonBootstrapResult
  const op = await deps.lifecycleOps.getById(result.operationId)
  if (!op || op.daemonId !== conn.daemonId || op.status !== 'pending' || op.op !== 'upgrade') {
    conn.replyTo(frame, 'ack', { ok: false, reason: 'bootstrap operation is not pending for this daemon' })
    return
  }
  if (result.status === 'failed') {
    await deps.lifecycleOps.settle(
      op.id,
      'failed',
      result.reason ?? 'daemon bootstrap upgrade failed',
      new Date(deps.clock.now())
    )
  }
  conn.replyTo(frame, 'ack', { ok: true })
}
