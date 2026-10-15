// The assistant-mode sub-session coordinate (assistant-mode.md §5.6): a reserved thread segment of its own, minted per delegation.
import { SUBSESSION_COORDINATE_PREFIX, isSubsessionCoordinate } from '@agentconnect.md/protocol'

export { SUBSESSION_COORDINATE_PREFIX, isSubsessionCoordinate }

/** How a released daemon's self-delegation opened before message headers (send-message-guide.md §9.5); its cards still strip it. */
export const LEGACY_TASK_START_WRAPPER = 'From your own main conversation, as a background sub-session:'

/** The coordinate of the sub-session a delegation opens, from its daemon-minted delivery id. */
export function subsessionCoordinate(deliveryId: string): string {
  return `${SUBSESSION_COORDINATE_PREFIX}${deliveryId}`
}

// A follow-up (assistant-mode.md §5.12) runs its checks in one sub-session of its own, read-only, under the old `patrol-` segment.
const PATROL_COORDINATE_PREFIX = `${SUBSESSION_COORDINATE_PREFIX}patrol-`

/** The coordinate of the sub-session a follow-up keeps for its checks, minted when it is taken. */
export function patrolCoordinate(deliveryId: string): string {
  return `${PATROL_COORDINATE_PREFIX}${deliveryId}`
}

/** Whether a session's thread segment is a follow-up's: the daemon runs its read-only checks there. */
export function isPatrolCoordinate(thread: string | null | undefined): boolean {
  return typeof thread === 'string' && thread.startsWith(PATROL_COORDINATE_PREFIX)
}

// An approved proposal (assistant-mode.md §5.10) runs in a sub-session of its own kind, never replayed after a cut (§5.7 step 1).
const TASK_COORDINATE_PREFIX = `${SUBSESSION_COORDINATE_PREFIX}task-`

/** The coordinate of the sub-session an approved proposal runs in. */
export function taskCoordinate(deliveryId: string): string {
  return `${TASK_COORDINATE_PREFIX}${deliveryId}`
}

/** Whether a session's thread segment is an approved proposal's: run once, with the agent's own permissions. */
export function isTaskCoordinate(thread: string | null | undefined): boolean {
  return typeof thread === 'string' && thread.startsWith(TASK_COORDINATE_PREFIX)
}

/** Whether a thread segment is a delegated sub-session's, the kind a parent can keep messaging across work rounds. */
export function isDelegationCoordinate(thread: string | null | undefined): boolean {
  return isSubsessionCoordinate(thread) && !isPatrolCoordinate(thread) && !isTaskCoordinate(thread)
}
