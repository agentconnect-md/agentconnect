/**
 * `TaskReader` — the daemon-local seam answering the CP's `task/list` REQ for the console's
 * Tasks panel. Task ids, descriptions and states live only in the daemon's in-memory
 * background-task lease (background-task-aware-reclaim.md §7); the CP proxies one snapshot and
 * never persists it.
 *
 * Read-only by construction: there is no cancel counterpart, because no ACP primitive can
 * address one background task (see `frames/task.ts`). So this seam cannot touch the lease at
 * all — it projects it, which is also what keeps the panel off the reclaim path.
 *
 * Everything except an unknown agent is DATA: a session with no lease answers
 * `tracked:false`, a lease with nothing in it answers an empty list.
 */
import type { TaskErrorReason, TaskList, TaskListReq } from '@agentconnect.md/protocol'

/** Bad-request violation → `BAD_PAYLOAD` on the wire. `reason` rides along in the error frame's
 *  `details` so the CP can answer with a status the console can branch on rather than the 503
 *  that reads as an offline daemon. */
export class TaskViolationError extends Error {
  readonly reason: TaskErrorReason
  constructor(message: string, reason: TaskErrorReason) {
    super(message)
    this.name = 'TaskViolationError'
    this.reason = reason
  }
}

/** The seam the CP client dispatches `task/list` to. */
export interface TaskReader {
  list(req: TaskListReq): Promise<TaskList>
}
