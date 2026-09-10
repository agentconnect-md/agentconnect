import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'

export const handleDaemonLifecycleProgress: Handler = async (frame, conn, deps) => {
  if (!isFrame('daemon/lifecycle/progress')(frame)) return
  const ok = await deps.lifecycleOps.recordProgress(
    DaemonId(conn.daemonId),
    BigInt(conn.sessionEpoch),
    frame.payload,
    new Date(deps.clock.now())
  )
  conn.replyTo(frame, 'ack', { ok })
}
