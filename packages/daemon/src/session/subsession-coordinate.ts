// The assistant-mode sub-session coordinate (assistant-mode.md §5.6): a reserved thread segment of its own, minted per delegation.
import { SUBSESSION_COORDINATE_PREFIX, isSubsessionCoordinate } from '@agentconnect.md/protocol'

export { SUBSESSION_COORDINATE_PREFIX, isSubsessionCoordinate }

/** How a released daemon's self-delegation opened before message headers (send-message-guide.md §9.5); its cards still strip it. */
export const LEGACY_TASK_START_WRAPPER = 'From your own main conversation, as a background sub-session:'

/** The coordinate of the sub-session a delegation opens, from its daemon-minted delivery id. */
export function subsessionCoordinate(deliveryId: string): string {
  return `${SUBSESSION_COORDINATE_PREFIX}${deliveryId}`
}

// A follow-up (assistant-mode.md §5.12) runs its checks in one sub-session of its own, read-only, under the `check-` segment.
const CHECK_COORDINATE_PREFIX = `${SUBSESSION_COORDINATE_PREFIX}check-`

/** The coordinate of the sub-session a follow-up keeps for its checks, minted when it is taken. */
export function checkCoordinate(deliveryId: string): string {
  return `${CHECK_COORDINATE_PREFIX}${deliveryId}`
}

/** Whether a session's thread segment is a follow-up's: the daemon runs its read-only checks there. */
export function isCheckCoordinate(thread: string | null | undefined): boolean {
  return typeof thread === 'string' && thread.startsWith(CHECK_COORDINATE_PREFIX)
}

// A first look (assistant-mode.md §5.13) is a follow-up's check with a narrower reach, so its segment is a check's too.
export const FIRST_LOOK_COORDINATE_PREFIX = `${CHECK_COORDINATE_PREFIX}look-`

/** The coordinate of the sub-session a first look reads its place in. */
export function firstLookCoordinate(deliveryId: string): string {
  return `${FIRST_LOOK_COORDINATE_PREFIX}${deliveryId}`
}

/** Whether a session's thread segment is a first look's: only its own place's reads, bounded, and no memory capture. */
export function isFirstLookCoordinate(thread: string | null | undefined): boolean {
  return typeof thread === 'string' && thread.startsWith(FIRST_LOOK_COORDINATE_PREFIX)
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
  return isSubsessionCoordinate(thread) && !isCheckCoordinate(thread) && !isTaskCoordinate(thread)
}
