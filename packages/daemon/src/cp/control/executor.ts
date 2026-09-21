import type {
  AnyFrame,
  ExecutorPrepareReq,
  ExecutorPrepareResult,
  ExecutorReleaseReq,
  ExecutorReleaseResult
} from '@agentconnect.md/protocol'
import type { ControlHandler } from './context.js'

export interface ExecutorControlDeps {
  /** The executor facet's `prepare`; absent on a daemon that has none. Its `ready` answer carries the pipe's key. */
  executorPrepare?: (req: ExecutorPrepareReq) => Promise<ExecutorPrepareResult>
  /** The executor facet's `release`; absent on a daemon that has none, which then knows no environment to remove. */
  executorRelease?: (req: ExecutorReleaseReq) => Promise<ExecutorReleaseResult>
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
    // Retryable: the launch is given up here, and the holder's next one carries a new launch id.
    wire.sendError(frame.id, 'INTERNAL', 'executor/prepare failed', true)
  }
}

/** A relayed `executor/release` (session-executors.md §7): the holder retired the session, so its environment goes. */
export const executorRelease: ControlHandler<ExecutorControlDeps> = async (frame: AnyFrame, deps, wire) => {
  // A daemon with no facet hosts nothing, which is what `unknown` says — and it keeps the release idempotent.
  if (!deps.executorRelease) return wire.reply(frame, 'executor/release/result', { status: 'unknown' })
  try {
    wire.reply(frame, 'executor/release/result', await deps.executorRelease(frame.payload as ExecutorReleaseReq))
  } catch (err) {
    wire.log.warn(`cp: executor/release failed: ${(err as Error)?.message}`)
    // Retryable: the environment is still here, and the backstop reconcile collects it if nobody asks again.
    wire.sendError(frame.id, 'INTERNAL', 'executor/release failed', true)
  }
}
