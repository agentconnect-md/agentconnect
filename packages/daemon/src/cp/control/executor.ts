import type { AnyFrame, ExecutorPrepareResult } from '@agentconnect.md/protocol'
import type { ControlHandler } from './context.js'

/** A relayed `executor/prepare` (session-executors.md §6). This daemon has no executor facet yet, so it says so at once instead of letting the Control Plane's relay run out its budget. */
export const executorPrepare: ControlHandler<unknown> = (frame: AnyFrame, _deps, wire) => {
  const refusal: ExecutorPrepareResult = { status: 'refused', reason: 'facet_off' }
  wire.reply(frame, 'executor/prepare/result', refusal)
}
