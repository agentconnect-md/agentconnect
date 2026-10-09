import type { AnyFrame, AssistantActivityReadReq, AssistantActivityWriteReq } from '@agentconnect.md/protocol'
import { AssistantActivityViolationError, type AssistantActivity } from '../assistant-activity.js'
import type { ControlHandler, ControlWire } from './context.js'

export interface AssistantControlDeps {
  /** The Activity view's store seam; absent ⇒ every request is refused as for an unknown agent. */
  assistantActivity?: AssistantActivity
}

export const assistantActivityRead: ControlHandler<AssistantControlDeps> = (frame: AnyFrame, deps, wire) => {
  const req = frame.payload as AssistantActivityReadReq
  if (!deps.assistantActivity) return refuseUnwired(wire, frame.id, 'assistant/activity/read', req.agentId)
  deps.assistantActivity
    .read(req)
    .then((result) => wire.reply(frame, 'assistant/activity/read/result', result))
    .catch((err) => activityError(wire, frame.id, 'assistant/activity/read', err))
}

export const assistantActivityWrite: ControlHandler<AssistantControlDeps> = (frame: AnyFrame, deps, wire) => {
  const req = frame.payload as AssistantActivityWriteReq
  if (!deps.assistantActivity) return refuseUnwired(wire, frame.id, 'assistant/activity/write', req.agentId)
  deps.assistantActivity
    .write(req)
    .then((result) => wire.reply(frame, 'assistant/activity/write/result', result))
    .catch((err) => activityError(wire, frame.id, 'assistant/activity/write', err))
}

function refuseUnwired(wire: ControlWire, corr: string, op: string, agentId: string): void {
  wire.sendError(corr, 'BAD_PAYLOAD', `${op} failed: unknown agent "${agentId}"`, false, { reason: 'unknown-agent' })
}

/** A refused request → BAD_PAYLOAD with its machine reason; anything else → INTERNAL with a generic message. */
function activityError(wire: ControlWire, corr: string, op: string, err: unknown): void {
  if (err instanceof AssistantActivityViolationError) {
    wire.sendError(corr, 'BAD_PAYLOAD', `${op} failed: ${err.message}`, false, { reason: err.reason })
    return
  }
  wire.log.warn(`cp: ${op} failed: ${(err as Error)?.message}`)
  wire.sendError(corr, 'INTERNAL', `${op} failed`, false)
}
