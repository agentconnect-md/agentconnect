import type { AnyFrame, AutoMergeSetReq, AutoMergeStateReq } from '@agentconnect.md/protocol'
import { AutoMergeViolationError, type AutoMergeWatcher } from '../../github/auto-merge/watcher.js'
import type { ControlHandler, ControlWire } from './context.js'

export interface AutoMergeControlDeps {
  /** The edge's in-memory merge-when-ready registry; absent on a daemon that serves no agents. */
  autoMerge?: AutoMergeWatcher
}

export const autoMergeSet: ControlHandler<AutoMergeControlDeps> = (frame: AnyFrame, deps, wire) => {
  const req = frame.payload as AutoMergeSetReq
  answer(wire, frame, 'automerge/set', 'automerge/set/result', deps.autoMerge?.set(req, req.enabled))
}

export const autoMergeState: ControlHandler<AutoMergeControlDeps> = (frame: AnyFrame, deps, wire) => {
  const req = frame.payload as AutoMergeStateReq
  answer(wire, frame, 'automerge/state', 'automerge/state/result', deps.autoMerge?.state(req))
}

/** One shape for both ops: a watcher-less daemon is an INTERNAL error rather than a fabricated
 *  "not armed" — the console must not read "nothing is watching" off a daemon that cannot watch. */
function answer(
  wire: ControlWire,
  frame: AnyFrame,
  op: string,
  reply: 'automerge/set/result' | 'automerge/state/result',
  work: Promise<unknown> | undefined
): void {
  if (!work) {
    wire.sendError(frame.id, 'INTERNAL', `${op} failed: this daemon serves no merge-when-ready watcher`, false)
    return
  }
  work.then((result) => wire.reply(frame, reply, result)).catch((err) => fail(wire, frame.id, op, err))
}

/** An unknown agent or an image with no watcher → BAD_PAYLOAD with the machine reason, so the CP
 *  answers with a code the console branches on; anything else → INTERNAL with a generic message. */
function fail(wire: ControlWire, corr: string, op: string, err: unknown): void {
  if (err instanceof AutoMergeViolationError) {
    wire.sendError(corr, 'BAD_PAYLOAD', `${op} failed: ${err.message}`, false, { reason: err.reason })
    return
  }
  wire.log.warn(`cp: ${op} failed: ${(err as Error)?.message}`)
  wire.sendError(corr, 'INTERNAL', `${op} failed`, false)
}
