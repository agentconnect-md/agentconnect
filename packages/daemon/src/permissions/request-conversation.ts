import { isPatrolCoordinate, isSubsessionCoordinate } from '../session/subsession-coordinate.js'
import type { LocalStore } from '../store/local-store.js'

/** Where a stored approval request was asked, by outward ids (session-concept.md §1.1). */
export interface RequestConversation {
  /** The session that asked. */
  sessionId: string
  /** The conversation a background sub-session's request belongs to (assistant-mode.md §5.6); absent for any other. */
  parentSessionId?: string
}

/** The session a request was asked in and, for a background sub-session's, the conversation it belongs to; an unknown session keeps its ACP id. */
export async function requestConversation(
  store: LocalStore,
  agentId: string,
  acpSessionId: string,
  now: number
): Promise<RequestConversation> {
  const slot = await store.getSessionByAcpIdForAgent(agentId, acpSessionId)
  if (!slot) return { sessionId: acpSessionId }
  const parentSessionId =
    isSubsessionCoordinate(slot.thread) && !isPatrolCoordinate(slot.thread)
      ? (await store.assistantSubsessions.get(agentId, slot.key))?.parentSessionId
      : undefined
  return {
    sessionId: await store.ensureOutwardSessionId(slot.key, agentId, now),
    ...(parentSessionId ? { parentSessionId } : {})
  }
}

/** Whether a request belongs to the conversation `sessionId`: asked there, or by one of its background sub-sessions. */
export function inConversation(where: RequestConversation, sessionId: string): boolean {
  return where.sessionId === sessionId || where.parentSessionId === sessionId
}
