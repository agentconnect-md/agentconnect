// A background sub-session's runtime permission request, routed to the conversation it belongs to (assistant-mode.md §5.6).
import type { ApprovalRouteTarget } from '@agentconnect.md/protocol'
import { SESSION_MESSAGE_HEADER } from '../collab/session-message.js'
import { isAppendCoordinate } from '../session/append-coordinate.js'
import { deriveTitle } from '../session/derive-title.js'
import { isSubsessionCoordinate, LEGACY_TASK_START_WRAPPER } from '../session/subsession-coordinate.js'

/** How long a sub-session's request waits when the policy sets no `permissionWaitHours`. */
export const DEFAULT_PERMISSION_WAIT_HOURS = 12

/** Where the request is shown besides the console: a conversation on a platform with approval cards, or the console alone (webchat and the rest). */
export type SubsessionApprovalPlace =
  { kind: 'chat'; integrationId: string; channel: string; thread?: string; external: boolean } | { kind: 'console' }

/** What a sub-session's request needs to reach its conversation. */
export interface SubsessionApprovalRoute {
  /** The conversation the sub-session belongs to, by its session's outward id. */
  parentSessionId: string
  /** The sub-session's label ({@link subsessionLabel}); null when it has none. */
  title: string | null
  place: SubsessionApprovalPlace
  /** Hours the request waits before it is denied and the sub-session stops. */
  waitHours: number
}

/** The approver an external place's card goes to instead, as drafts route theirs (§5.5): the responsible user's DM. */
export interface SubsessionApprover {
  target: ApprovalRouteTarget
  channel: string
}

// What a task's first message opens with, which names nothing: a header, or a released daemon's wrapper.
const unwrapped = (text: string | null | undefined): string | undefined => {
  const trimmed = text?.trimStart()
  // send-message-guide.md §9.5: a task's first message opens with its session-message header line.
  const header = trimmed !== undefined ? SESSION_MESSAGE_HEADER.exec(trimmed) : null
  if (header) return trimmed!.slice(header[0].length)
  return trimmed?.startsWith(LEGACY_TASK_START_WRAPPER) ? trimmed.slice(LEGACY_TASK_START_WRAPPER.length) : undefined
}

/** A sub-session's name on its cards: its title, else its task without the delegation wrapper, truncated; null when neither says anything. */
export function subsessionLabel(title: string | null | undefined, task: string | undefined): string | null {
  const own = title?.trim()
  if (own && unwrapped(own) === undefined) return own
  return deriveTitle(unwrapped(task) ?? task) ?? deriveTitle(unwrapped(own)) ?? null
}

/** The approval record's decider once the wait ran out. */
export function waitExpiredDecider(hours: number): { resolvedBy: null; resolvedByName: string } {
  return { resolvedBy: null, resolvedByName: `No answer within ${hours} hour${hours === 1 ? '' : 's'}` }
}

/** The platform thread a card goes to, as a report into the conversation would: a coordinate the daemon minted is none, so it posts at the root. */
export function platformThread(thread: string | null | undefined): string | undefined {
  if (!thread || isAppendCoordinate(thread) || isSubsessionCoordinate(thread)) return undefined
  return thread
}
