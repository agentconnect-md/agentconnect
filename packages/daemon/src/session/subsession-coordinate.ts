// The assistant-mode sub-session coordinate (assistant-mode.md §5.6): a reserved thread segment of its own, minted per delegation.
import { SUBSESSION_COORDINATE_PREFIX, isSubsessionCoordinate } from '@agentconnect.md/protocol'

export { SUBSESSION_COORDINATE_PREFIX, isSubsessionCoordinate }

/** The coordinate of the sub-session a delegation opens, from its daemon-minted delivery id. */
export function subsessionCoordinate(deliveryId: string): string {
  return `${SUBSESSION_COORDINATE_PREFIX}${deliveryId}`
}

// A patrol (assistant-mode.md §5.9) is a sub-session too, so everything a sub-session coordinate gets applies to it.
const PATROL_COORDINATE_PREFIX = `${SUBSESSION_COORDINATE_PREFIX}patrol-`

/** The coordinate of the read-only sub-session a patrol runs in. */
export function patrolCoordinate(deliveryId: string): string {
  return `${PATROL_COORDINATE_PREFIX}${deliveryId}`
}

/** Whether a session's thread segment is a patrol's: the daemon started it, read-only. */
export function isPatrolCoordinate(thread: string | null | undefined): boolean {
  return typeof thread === 'string' && thread.startsWith(PATROL_COORDINATE_PREFIX)
}
