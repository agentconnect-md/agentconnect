export type SessionResumeState = 'available' | 'checking' | 'unavailable'

export interface SessionResumeMember {
  agentId: string
  /** Daemon that owns this session's local content. */
  daemonId: string | null | undefined
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
