// A background sub-session's runtime permission request, routed to the conversation it belongs to (assistant-mode.md §5.6).
import type { ApprovalRouteTarget } from '@agentconnect.md/protocol'
import { isAppendCoordinate } from '../session/append-coordinate.js'
import { isSubsessionCoordinate } from '../session/subsession-coordinate.js'

/** How long a sub-session's request waits when the policy sets no `permissionWaitHours`. */
export const DEFAULT_PERMISSION_WAIT_HOURS = 12

/** Where the request is shown besides the console: a Slack conversation, or the console alone (webchat and the rest). */
export type SubsessionApprovalPlace =
  { kind: 'slack'; integrationId: string; channel: string; thread?: string; external: boolean } | { kind: 'console' }

/** What a sub-session's request needs to reach its conversation. */
export interface SubsessionApprovalRoute {
  /** The conversation the sub-session belongs to, by its session's outward id. */
  parentSessionId: string
  /** The sub-session's title, when it has one. */
  title: string | null
  place: SubsessionApprovalPlace
  /** Hours the request waits before it is denied and the sub-session stops. */
  waitHours: number
}

/** The approver an external place's card goes to instead, as drafts route theirs (§5.5): a linked editor's DM, or the fallback conversation. */
export type SubsessionApprover =
  | { kind: 'member'; target: ApprovalRouteTarget; channel: string }
  | { kind: 'conversation'; integrationId: string; channel: string }

/** The approval record's decider once the wait ran out. */
export function waitExpiredDecider(hours: number): { resolvedBy: null; resolvedByName: string } {
  return { resolvedBy: null, resolvedByName: `No answer within ${hours} hour${hours === 1 ? '' : 's'}` }
}

/** The platform thread a card goes to, as a report into the conversation would: a coordinate the daemon minted is none, so it posts at the root. */
export function platformThread(thread: string | null | undefined): string | undefined {
  if (!thread || isAppendCoordinate(thread) || isSubsessionCoordinate(thread)) return undefined
  return thread
}
