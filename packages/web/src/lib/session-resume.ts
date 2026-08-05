export type SessionResumeState = 'available' | 'checking' | 'unavailable'

export interface SessionResumeMember {
  agentId: string
  /** Daemon that owns this session's local content. */
  daemonId: string | null | undefined
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

/**
 * A persisted conversation can resume only while every participating agent is
 * still placed on the daemon that owns its session. Agent moves do not copy ACP
 * state, transcripts, or worktrees to the new daemon.
 *
 * `null` members means session detail/roster metadata is still loading. Once the
 * metadata is present, missing ownership or placement fails closed.
 */
export function sessionResumeState(
  members: readonly SessionResumeMember[] | null,
  currentDaemonByAgent: ReadonlyMap<string, string | undefined>
): SessionResumeState {
  if (members === null) return 'checking'
  if (members.length === 0) return 'unavailable'
  return members.every(
    (member) => Boolean(member.daemonId) && currentDaemonByAgent.get(member.agentId) === member.daemonId
  )
    ? 'available'
    : 'unavailable'
}
