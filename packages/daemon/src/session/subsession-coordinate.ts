// The assistant-mode sub-session coordinate (assistant-mode.md §5.6): a reserved thread segment of its own, minted per delegation.
import {
  APPROVED_TASK_COORDINATE_PREFIX,
  CHECK_COORDINATE_PREFIX,
  RESEARCH_COORDINATE_PREFIX,
  SUBSESSION_COORDINATE_PREFIX,
  isDelegatedTaskCoordinate,
  isSubsessionCoordinate
} from '@agentconnect.md/protocol'

export { SUBSESSION_COORDINATE_PREFIX, isSubsessionCoordinate }

/** How a released daemon's self-delegation opened before message headers (send-message-guide.md §9.5); its cards still strip it. */
export const LEGACY_TASK_START_WRAPPER = 'From your own main conversation, as a background sub-session:'

/** The coordinate of the sub-session a delegation opens, from its daemon-minted delivery id. */
export function subsessionCoordinate(deliveryId: string): string {
  return `${SUBSESSION_COORDINATE_PREFIX}${deliveryId}`
}

// A follow-up (assistant-mode.md §5.12) runs its checks in one sub-session of its own, read-only, under the `check-` segment.
/** The coordinate of the sub-session a follow-up keeps for its checks, minted when it is taken. */
export function checkCoordinate(deliveryId: string): string {
  return `${CHECK_COORDINATE_PREFIX}${deliveryId}`
}

/** Whether a session's thread segment is a follow-up's: the daemon runs its read-only checks there. */
export function isCheckCoordinate(thread: string | null | undefined): boolean {
  return typeof thread === 'string' && thread.startsWith(CHECK_COORDINATE_PREFIX)
}

// A getting-to-know task (assistant-mode.md §5.13) is a follow-up's check with a narrower reach, so its segment is a check's too.
export const GETTING_TO_KNOW_COORDINATE_PREFIX = `${CHECK_COORDINATE_PREFIX}look-`

/** The coordinate of the sub-session a getting-to-know task reads its place in. */
export function gettingToKnowCoordinate(deliveryId: string): string {
  return `${GETTING_TO_KNOW_COORDINATE_PREFIX}${deliveryId}`
}

/** Whether a session's thread segment is a getting-to-know task's: only its own place's reads and memory writes, bounded, and no memory capture. */
export function isGettingToKnowCoordinate(thread: string | null | undefined): boolean {
  return typeof thread === 'string' && thread.startsWith(GETTING_TO_KNOW_COORDINATE_PREFIX)
}

// An approved proposal (assistant-mode.md §5.10) runs in a sub-session of its own kind, never replayed after a cut (§5.7 step 1).
/** The coordinate of the sub-session an approved proposal runs in. */
export function taskCoordinate(deliveryId: string): string {
  return `${APPROVED_TASK_COORDINATE_PREFIX}${deliveryId}`
}

/** Whether a session's thread segment is an approved proposal's: run once, with the agent's own permissions. */
export function isTaskCoordinate(thread: string | null | undefined): boolean {
  return typeof thread === 'string' && thread.startsWith(APPROVED_TASK_COORDINATE_PREFIX)
}

// Organization research (assistant-mode.md §5.15) is a delegated task of its own segment: narrowed tools, the shared layer, its own host.
/** The coordinate of an agent's organization research task, minted at onboarding. */
export function researchCoordinate(deliveryId: string): string {
  return `${RESEARCH_COORDINATE_PREFIX}${deliveryId}`
}

/** Whether a session's thread segment is organization research's. */
export function isResearchCoordinate(thread: string | null | undefined): boolean {
  return typeof thread === 'string' && thread.startsWith(RESEARCH_COORDINATE_PREFIX)
}

/** Whether a logical session key (`platform:channel:thread:agentId[:scope]`) names a research task's session. */
export function isResearchSessionKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.includes(`:${RESEARCH_COORDINATE_PREFIX}`)
}

/** The research coordinate inside a task's session key, or undefined for any other key. */
export function researchThreadOf(key: string): string | undefined {
  return new RegExp(`:(${RESEARCH_COORDINATE_PREFIX}\\d+):`).exec(key)?.[1]
}

/** A `LIKE` pattern matching every research task's session key. */
export const RESEARCH_SESSION_KEY_PATTERN = `%:${RESEARCH_COORDINATE_PREFIX}%`

/** Whether a thread segment is a delegated sub-session's, the kind a parent can keep messaging across work rounds. */
export function isDelegationCoordinate(thread: string | null | undefined): boolean {
  return isSubsessionCoordinate(thread) && !isCheckCoordinate(thread) && !isTaskCoordinate(thread)
}

/** Whether a logical session key names a sub-session of any kind. */
export function isSubsessionKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.includes(`:${SUBSESSION_COORDINATE_PREFIX}`)
}

/** Whether a session on this coordinate may open tasks at all (auto-session-mode.md §6.3): any but a follow-up's check, an approved proposal or research; a task's own level is read from its index row. */
export function mayOpenTasksAt(thread: string | null | undefined): boolean {
  return !isSubsessionCoordinate(thread) || (isDelegationCoordinate(thread) && !isResearchCoordinate(thread))
}

/** Whether a session on this coordinate is a task that keeps its own summary (auto-session-mode.md §6.7): a delegated task's, never research's. */
export function keepsTaskSummaryAt(thread: string | null | undefined): boolean {
  return isDelegatedTaskCoordinate(thread)
}
