export type SessionResumeState = 'available' | 'checking' | 'unavailable'

export interface SessionResumeMember {
  agentId: string
  /** Daemon that recorded this session's content. */
  daemonId: string | null | undefined
  /** The shared-store pool set the content went to; null/absent ⇒ the recorder's private store. */
  contentSetId?: string | null
}

/** Where a participant agent is placed NOW — the one machine of a `daemon` placement, or the set. */
export interface SessionResumePlacement {
  daemonId?: string | null
  setId?: string | null
}

/**
 * Select the ownership rows used by the resume gate. A session route may still
 * represent a multi-agent conversation (notably the diagnostic `view=flat`
 * route), so resolved conversation membership takes precedence over the
 * selected session. While that lookup is pending, fail closed.
 */
export function sessionResumeMembers(
  conversationMembers: readonly SessionResumeMember[] | null | undefined,
  currentSession: SessionResumeMember | null,
  lookupRequired: boolean,
  lookupPending: boolean
): readonly SessionResumeMember[] | null {
  if (lookupPending) return null
  if (conversationMembers?.length) return conversationMembers
  if (lookupRequired) return []
  return currentSession ? [currentSession] : null
}

/** Resumable only while every participant's CURRENT placement still reaches its content: a `daemon` placement must be the recorder (moves copy nothing), a pool placement needs the content in the pool's shared store (`contentSetId`) — no member id survives a rollout. `null` members = still loading; anything missing fails closed. */
export function sessionResumeState(
  members: readonly SessionResumeMember[] | null,
  placementByAgent: ReadonlyMap<string, SessionResumePlacement | undefined>
): SessionResumeState {
  if (members === null) return 'checking'
  if (members.length === 0) return 'unavailable'
  return members.every((member) => {
    const placement = placementByAgent.get(member.agentId)
    if (!placement) return false
    if (member.daemonId && placement.daemonId === member.daemonId) return true
    return Boolean(member.contentSetId) && placement.setId === member.contentSetId
  })
    ? 'available'
    : 'unavailable'
}
