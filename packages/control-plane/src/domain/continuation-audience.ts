import {
  isDelegatedTaskCoordinate,
  isSubsessionCoordinate,
  TASK_PAGE_MESSAGES_FEATURE,
  WEBCHAT_THREADS_FEATURE
} from '@agentconnect.md/protocol'

/** What tells a task from any other session: its coordinate and lineage, or the task index its daemon reports. */
export interface ContinuationSubject {
  agentId: string
  platform?: string | null
  thread?: string | null
  parentSessionId?: string | null
  taskParentSessionId?: string | null
}

/** Whether a session is a task continued by its owning session's audience: a background one, or a webchat coordinator's by the task index (webchat-threads.md §5.4). */
function continuedAsTask(session: Omit<ContinuationSubject, 'agentId'>): boolean {
  return isSubsessionCoordinate(session.thread) || (session.platform === 'webchat' && !!session.taskParentSessionId)
}

/** The owning session a task's continuation is judged by, to load before {@link continuationAudience}; none for any other session. */
export function continuationParentId(session: Omit<ContinuationSubject, 'agentId'>): string | null {
  if (isSubsessionCoordinate(session.thread)) return session.parentSessionId ?? null
  return session.platform === 'webchat' ? (session.taskParentSessionId ?? null) : null
}

/** Whose audience decides a continuation (auto-session-mode.md §10): a task's owning session of the same agent, the session itself otherwise, and nobody for a task without one. */
export function continuationAudience<S extends ContinuationSubject, P extends { id?: string; agentId: string }>(
  session: S,
  parent: P | null
): S | P | null {
  if (!continuedAsTask(session)) return session
  const parentId = continuationParentId(session)
  return parent !== null && parentId !== null && parent.id === parentId && parent.agentId === session.agentId
    ? parent
    : null
}

/** The daemon feature a console-only task continuation needs: a delegated task's page, or a webchat coordinator's task in its thread (webchat-threads.md §6.3); none for any other session. */
export function taskContinuationFeature(session: Omit<ContinuationSubject, 'agentId'>): string | null {
  if (isSubsessionCoordinate(session.thread))
    return isDelegatedTaskCoordinate(session.thread) ? TASK_PAGE_MESSAGES_FEATURE : null
  return continuedAsTask(session) ? WEBCHAT_THREADS_FEATURE : null
}
