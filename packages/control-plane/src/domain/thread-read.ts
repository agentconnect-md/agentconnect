import type { SessionThreadSummary } from '@agentconnect.md/protocol'

/** A thread footer as the console receives it: `readable` false means a task the viewer may not view holds it, so it has its count and no content. */
export type ThreadSummaryView = Omit<SessionThreadSummary, 'lastReply' | 'task'> & {
  lastReply?: { sender: string; senderName?: string; excerpt?: string }
  task?: { sessionId?: string; title?: string; state: 'open' | 'done' | 'failed'; starting?: true }
  readable: boolean
}

/** Each held task session the CP has a row for, and whether this viewer may view it; a task without one is still starting. */
export type ThreadTaskAccess = ReadonlyMap<string, boolean>

/** The task sessions a viewer must be able to view to read these threads (webchat-threads.md §7.1). */
export function threadTaskSessionIds(summaries: readonly SessionThreadSummary[]): string[] {
  return [...new Set(summaries.flatMap((s) => (s.task?.sessionId ? [s.task.sessionId] : [])))]
}

/** Whether a viewer may read a thread: an unowned one by the conversation's audience, a held one only through its task's session, and never before that session exists. */
export function threadReadable(summary: SessionThreadSummary, tasks: ThreadTaskAccess): boolean {
  if (!summary.task) return true
  return summary.task.sessionId !== undefined && tasks.get(summary.task.sessionId) === true
}

/** Whether a held thread's task has no session row yet, so it is unread because it is starting, not because it is withheld. */
function taskStarting(summary: SessionThreadSummary, tasks: ThreadTaskAccess): boolean {
  const id = summary.task?.sessionId
  return summary.task !== undefined && (id === undefined || !tasks.has(id))
}

/** A footer for this viewer: whole when readable, else without the root's and the latest reply's excerpts and the task's title. */
export function threadSummaryFor(summary: SessionThreadSummary, tasks: ThreadTaskAccess): ThreadSummaryView {
  if (threadReadable(summary, tasks)) return { ...summary, readable: true }
  const starting = taskStarting(summary, tasks)
  const { rootExcerpt: _rootExcerpt, lastReply, task, ...rest } = summary
  return {
    ...rest,
    ...(lastReply
      ? {
          lastReply: { sender: lastReply.sender, ...(lastReply.senderName ? { senderName: lastReply.senderName } : {}) }
        }
      : {}),
    ...(task
      ? {
          task: {
            ...(task.sessionId ? { sessionId: task.sessionId } : {}),
            state: task.state,
            ...(starting ? { starting: true as const } : {})
          }
        }
      : {}),
    readable: false
  }
}
