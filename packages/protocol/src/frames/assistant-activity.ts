import { z } from 'zod'

// The console's Activity view of an assistant-mode agent (assistant-mode.md §1.7, §5.11): the owning daemon answers from its store, the Control Plane proxies and keeps nothing.

/** Daemon serves `assistant/activity/read` and `assistant/activity/write`; an older daemon ignores both, so the Control Plane checks first. */
export const ASSISTANT_ACTIVITY_FEATURE = 'assistant-activity-v1'

/** JSON bytes one read result may take, leaving envelope headroom below the 256 KiB wire cap; a list stops short and says so. */
export const ASSISTANT_ACTIVITY_RESULT_BYTES = 192 * 1024

export const ASSISTANT_ACTIVITY_ITEMS_MAX = 100
export const ASSISTANT_ACTIVITY_SUBSESSIONS_MAX = 50
export const ASSISTANT_ACTIVITY_DRAFTS_MAX = 50
export const ASSISTANT_ACTIVITY_GRANTS_MAX = 200
/** Distinct follower places carried per item. */
export const ASSISTANT_ACTIVITY_PLACES_MAX = 20
/** Newest observations carried by one item read. */
export const ASSISTANT_ACTIVITY_OBSERVATIONS_MAX = 10

/** Why the daemon refused a request, carried on a `BAD_PAYLOAD` error frame's `details.reason`. */
export const AssistantActivityErrorReason = z.enum(['unknown-agent', 'assistant-mode-off'])
export type AssistantActivityErrorReason = z.infer<typeof AssistantActivityErrorReason>

const agentId = z.string().uuid()
const ref = z.string().min(1).max(512)
const time = z.string().datetime()
const name = z.string().max(512).nullable()

/** A conversation by its platform and the platform's own id; the console names it from the agent's integrations. */
export const AssistantActivityPlace = z.object({ platform: z.string().min(1).max(64), channel: ref })
export type AssistantActivityPlace = z.infer<typeof AssistantActivityPlace>

export const AssistantActivityItemStatus = z.enum(['active', 'waiting', 'done', 'dropped'])
export type AssistantActivityItemStatus = z.infer<typeof AssistantActivityItemStatus>

/** One ledger item as the team sees it: never a follower's identity, never a conversation's wording. */
export const AssistantActivityItem = z.object({
  id: ref,
  title: z.string().max(300),
  status: AssistantActivityItemStatus,
  doneWhen: z.string().max(2_000).nullable(),
  /** When the agent noted it should check next; nothing wakes it for this yet. */
  nextCheck: time.nullable(),
  origin: AssistantActivityPlace,
  /** The distinct places its followers follow it from. */
  places: z.array(AssistantActivityPlace).max(ASSISTANT_ACTIVITY_PLACES_MAX),
  createdAt: time,
  updatedAt: time
})
export type AssistantActivityItem = z.infer<typeof AssistantActivityItem>

export const AssistantActivityObservation = z.object({ text: z.string().max(2_000), at: time })
export type AssistantActivityObservation = z.infer<typeof AssistantActivityObservation>

/** An item with its summary and its newest observations, newest first. */
export const AssistantActivityItemDetail = AssistantActivityItem.extend({
  summary: z.string().max(8_000),
  observations: z.array(AssistantActivityObservation).max(ASSISTANT_ACTIVITY_OBSERVATIONS_MAX)
})
export type AssistantActivityItemDetail = z.infer<typeof AssistantActivityItemDetail>

/** `open` until it reported back (`done`) or ended without reporting (`failed`). */
export const AssistantActivitySubsessionState = z.enum(['open', 'done', 'failed'])
export type AssistantActivitySubsessionState = z.infer<typeof AssistantActivitySubsessionState>

export const AssistantActivitySubsession = z.object({
  /** The sub-session's outward id; null until its session exists. */
  sessionId: ref.nullable(),
  /** The conversation that opened it, by its session's outward id. */
  parentSessionId: ref,
  state: AssistantActivitySubsessionState,
  createdAt: time
})
export type AssistantActivitySubsession = z.infer<typeof AssistantActivitySubsession>

/** A draft awaiting approval: where it would post, the exact text, who approves, and when it lapses. */
export const AssistantActivityDraft = z.object({
  id: ref,
  kind: z.enum(['reply', 'elsewhere']),
  target: z.object({
    platform: z.string().min(1).max(64),
    integrationId: ref,
    channel: ref,
    thread: ref.nullable(),
    /** The conversation's name, or the direct message recipient's, as resolved when the draft was written. */
    name,
    dm: z.boolean(),
    external: z.boolean()
  }),
  text: z.string().min(1).max(40_000),
  approver: z
    .object({
      kind: z.enum(['member', 'conversation']),
      integrationId: ref,
      channel: ref,
      userId: ref.nullable(),
      consoleUserId: ref.nullable(),
      /** The member's display name the daemon last saw; null when it has none. */
      name
    })
    .nullable(),
  createdAt: time,
  expiresAt: time
})
export type AssistantActivityDraft = z.infer<typeof AssistantActivityDraft>

/** One end of a grant; webchat has no integration. */
export const AssistantActivityGrantPlace = z.object({
  platform: z.string().min(1).max(64),
  integrationId: ref.nullable(),
  channel: ref
})
export type AssistantActivityGrantPlace = z.infer<typeof AssistantActivityGrantPlace>

/** "Always allow from here to there", named by a digest of its pair of places. */
export const AssistantActivityGrant = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  source: AssistantActivityGrantPlace,
  target: AssistantActivityGrantPlace,
  grantedByName: name,
  grantedAt: time
})
export type AssistantActivityGrant = z.infer<typeof AssistantActivityGrant>

/** C→D REQ: one section of the view. `items` lists the open ones (active, waiting) or the closed ones (done, dropped). */
export const AssistantActivityReadReq = z.discriminatedUnion('operation', [
  z.object({
    agentId,
    operation: z.literal('items'),
    section: z.enum(['open', 'closed']),
    limit: z.number().int().min(1).max(ASSISTANT_ACTIVITY_ITEMS_MAX)
  }),
  z.object({ agentId, operation: z.literal('item'), itemId: ref }),
  z.object({
    agentId,
    operation: z.literal('subsessions'),
    limit: z.number().int().min(1).max(ASSISTANT_ACTIVITY_SUBSESSIONS_MAX)
  }),
  z.object({
    agentId,
    operation: z.literal('drafts'),
    limit: z.number().int().min(1).max(ASSISTANT_ACTIVITY_DRAFTS_MAX)
  }),
  z.object({ agentId, operation: z.literal('grants') })
])
export type AssistantActivityReadReq = z.infer<typeof AssistantActivityReadReq>

/** D→C REP; `truncated` says the daemon held more than the answer carries. */
export const AssistantActivityReadResult = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('items'),
    items: z.array(AssistantActivityItem).max(ASSISTANT_ACTIVITY_ITEMS_MAX),
    truncated: z.boolean()
  }),
  z.object({ operation: z.literal('item'), item: AssistantActivityItemDetail.nullable() }),
  z.object({
    operation: z.literal('subsessions'),
    subsessions: z.array(AssistantActivitySubsession).max(ASSISTANT_ACTIVITY_SUBSESSIONS_MAX),
    truncated: z.boolean()
  }),
  z.object({
    operation: z.literal('drafts'),
    drafts: z.array(AssistantActivityDraft).max(ASSISTANT_ACTIVITY_DRAFTS_MAX),
    truncated: z.boolean()
  }),
  z.object({
    operation: z.literal('grants'),
    grants: z.array(AssistantActivityGrant).max(ASSISTANT_ACTIVITY_GRANTS_MAX),
    truncated: z.boolean()
  })
])
export type AssistantActivityReadResult = z.infer<typeof AssistantActivityReadResult>

/** C→D REQ: an editor deleting an item or revoking a grant; the Control Plane has already checked the caller. */
export const AssistantActivityWriteReq = z.discriminatedUnion('operation', [
  z.object({ agentId, operation: z.literal('delete-item'), itemId: ref }),
  z.object({ agentId, operation: z.literal('revoke-grant'), grantId: z.string().regex(/^[0-9a-f]{32}$/) })
])
export type AssistantActivityWriteReq = z.infer<typeof AssistantActivityWriteReq>

/** D→C REP: `found` is false when there was nothing to delete or revoke. */
export const AssistantActivityWriteResult = z.object({
  operation: z.enum(['delete-item', 'revoke-grant']),
  found: z.boolean()
})
export type AssistantActivityWriteResult = z.infer<typeof AssistantActivityWriteResult>

/** Whether a read result fits the byte budget the daemon trims to. */
export function assistantActivityResultFits(result: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(result)).byteLength <= ASSISTANT_ACTIVITY_RESULT_BYTES
}
