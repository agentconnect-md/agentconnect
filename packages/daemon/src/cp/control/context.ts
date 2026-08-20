import type { AnyFrame } from '@agentconnect.md/protocol'
import type { Logger } from '../../log.js'

/** The socket-facing half of a control handler: the client owns the transport, so a handler
 *  only ever asks it to answer the frame, refuse it, emit an uncorrelated EVT, or log. */
export interface ControlWire {
  /** Correlated reply to `req`, echoing its org. */
  reply(req: AnyFrame, type: string, payload: unknown): void
  sendError(corr: string, code: string, message: string, retryable: boolean, details?: Record<string, unknown>): void
  /** Emit an uncorrelated EVT (e.g. `drain/progress`). */
  emit(type: string, payload: unknown): void
  log: Logger
}

/** One C→D control frame kind's handler: the frame, its domain's deps slice, and the wire. */
export type ControlHandler<D> = (frame: AnyFrame, deps: D, wire: ControlWire) => void | Promise<void>
