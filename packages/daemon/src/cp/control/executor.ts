import type { AnyFrame, ExecutorPrepareReq, ExecutorPrepareResult } from '@agentconnect.md/protocol'
import type { ControlHandler } from './context.js'

export interface ExecutorControlDeps {
  /** The executor facet's `prepare`; absent on a daemon that has none. Its `ready` answer carries the pipe's key. */
  executorPrepare?: (req: ExecutorPrepareReq) => Promise<ExecutorPrepareResult>
}

/** A relayed `executor/prepare` (session-executors.md §6). This control connection is its only way in: the facet's listener parses nothing. */
export const executorPrepare: ControlHandler<ExecutorControlDeps> = async (frame: AnyFrame, deps, wire) => {
  // Answered at once either way: an ignored frame costs the Control Plane its whole relay budget.
  const facetOff: ExecutorPrepareResult = { status: 'refused', reason: 'facet_off' }
  if (!deps.executorPrepare) return wire.reply(frame, 'executor/prepare/result', facetOff)
  try {
    // NEVER log the result: its `ready` arm is the key.
    wire.reply(frame, 'executor/prepare/result', await deps.executorPrepare(frame.payload as ExecutorPrepareReq))
  } catch (err) {
    wire.log.warn(`cp: executor/prepare failed: ${(err as Error)?.message}`)
    // Retryable: the launch is given up here, and the holder's next one carries a higher generation.
    wire.sendError(frame.id, 'INTERNAL', 'executor/prepare failed', true)
  }
}
