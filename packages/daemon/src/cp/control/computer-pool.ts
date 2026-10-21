import type { AnyFrame, ComputerPoolOp, ComputerPoolOpResult } from '@agentconnect.md/protocol'
import type { ControlHandler } from './context.js'

/** `computer-pool/op` — the CP driving one managed computer's desktop claim on this pool member (computer-use.md §15.1). */
export interface ComputerPoolControlDeps {
  /** Undefined on a daemon that serves no desktop claims: every op answers not ok. */
  computerPoolOp?: (op: ComputerPoolOp) => Promise<ComputerPoolOpResult>
}

export const computerPoolOp: ControlHandler<ComputerPoolControlDeps> = (frame: AnyFrame, deps, wire) => {
  const op = frame.payload as ComputerPoolOp
  const work = deps.computerPoolOp?.(op)
  if (!work) {
    wire.reply(frame, 'computer-pool/op/result', {
      ok: false,
      error: 'this daemon serves no desktop claims'
    } satisfies ComputerPoolOpResult)
    return
  }
  work
    .then((result) => wire.reply(frame, 'computer-pool/op/result', result))
    .catch((err: unknown) => {
      wire.log.warn(`cp: computer-pool/op failed: ${(err as Error)?.message}`)
      wire.sendError(frame.id, 'INTERNAL', 'computer-pool/op failed', true)
    })
}
