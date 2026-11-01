import { isSubsessionCoordinate } from '@agentconnect.md/protocol'

/** The owning session a task's continuation is judged by, to load before {@link continuationAudience}; none for any other session. */
export function continuationParentId(session: {
  thread?: string | null
  parentSessionId?: string | null
}): string | null {
  return isSubsessionCoordinate(session.thread) ? (session.parentSessionId ?? null) : null
}

/** Whose audience decides a continuation (auto-session-mode.md §10): a task's owning session of the same agent, the session itself otherwise, and nobody for a task without one. */
export function continuationAudience<
  S extends { agentId: string; thread?: string | null; parentSessionId?: string | null },
  P extends { id?: string; agentId: string }
>(session: S, parent: P | null): S | P | null {
  if (!isSubsessionCoordinate(session.thread)) return session
  return parent !== null && parent.id === session.parentSessionId && parent.agentId === session.agentId ? parent : null
}
