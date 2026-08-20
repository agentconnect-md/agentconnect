import type { AnyFrame, TaskListReq } from '@agentconnect.md/protocol'
import { TaskViolationError, type TaskReader } from '../task-reader.js'
import type { ControlHandler, ControlWire } from './context.js'

export interface TaskControlDeps {
  /** Read-only projection of the in-memory background-task lease (§3.5 of webchat-side-panels.md). */
  taskReader: TaskReader
}

export const taskList: ControlHandler<TaskControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Background tasks of ONE ACP session, projected live from the lease. A session with no
  // lease and a session with no tasks are both results (`tracked` tells them apart).
  deps.taskReader
    .list(frame.payload as TaskListReq)
    .then((result) => wire.reply(frame, 'task/list/result', result))
    .catch((err) => taskError(wire, frame.id, 'task/list', err))
}

/** Unknown agent → BAD_PAYLOAD with the machine reason; anything else → INTERNAL with a generic
 *  message. There is no CONFLICT arm because `task/list` reads in-memory state and mutates
 *  nothing, so no lifecycle state can make it a legal-but-refused request. */
function taskError(wire: ControlWire, corr: string, op: string, err: unknown): void {
  if (err instanceof TaskViolationError) {
    wire.sendError(corr, 'BAD_PAYLOAD', `${op} failed: ${err.message}`, false, { reason: err.reason })
    return
  }
  wire.log.warn(`cp: ${op} failed: ${(err as Error)?.message}`)
  wire.sendError(corr, 'INTERNAL', `${op} failed`, false)
}
