// What the calling session may do with tasks (auto-session-mode.md §5.1), judged by the daemon at call time.
import { mayOpenTasksAt, type TaskReach } from '../../session/subsession-coordinate.js'
import type { SessionContext } from './context.js'

export interface TaskReachDeps {
  /** The calling session's reach; every task tool its coordinate allows when absent. */
  taskReach?: (ctx: SessionContext) => Promise<TaskReach>
}

/** The calling session's reach, from its coordinate alone when the daemon does not say. */
export async function taskReachOf(ctx: SessionContext, deps: TaskReachDeps): Promise<TaskReach> {
  return (await deps.taskReach?.(ctx)) ?? (mayOpenTasksAt(ctx.thread) ? 'delegate' : 'none')
}
