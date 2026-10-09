import { z } from 'zod'

// The console's Activity view of an assistant-mode agent (assistant-mode.md §1.7, §5.11): the owning daemon answers from its store, the Control Plane proxies and keeps nothing.

/** Daemon serves `assistant/activity/read` and `assistant/activity/write`; an older daemon ignores both, so the Control Plane checks first. */
export const ASSISTANT_ACTIVITY_FEATURE = 'assistant-activity-v1'

/** Daemon serves `decide-draft` on `assistant/activity/write`: an editor approves or discards a draft from the console. */
export const ASSISTANT_DRAFT_DECISION_FEATURE = 'assistant-draft-decision-v1'

/** Daemon serves a `subsessions` read narrowed to one conversation and `stop-subsession` writes; an older daemon would list every conversation's. */
export const ASSISTANT_SUBSESSION_PANEL_FEATURE = 'assistant-subsession-panel-v1'

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

/** Why the daemon refused a request, carried on a `BAD_PAYLOAD` error frame's `details.reason`; `bad-cursor` is a page cursor it did not mint. */
export const AssistantActivityErrorReason = z.enum(['unknown-agent', 'assistant-mode-off', 'bad-cursor'])
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

/** Opaque to everyone but the daemon that minted it: where the next page of one conversation's sub-sessions starts. */
export const AssistantSubsessionCursor = z.string().min(1).max(1_024)

export const AssistantActivitySubsession = z.object({
  /** The sub-session's outward id; null until its session exists. */
  sessionId: ref.nullable(),
  /** The conversation that opened it, by its session's outward id. */
  parentSessionId: ref,
  state: AssistantActivitySubsessionState,
  createdAt: time
})
export type AssistantActivitySubsession = z.infer<typeof AssistantActivitySubsession>

/** The longest sentence a proposal's card leads with. */
export const ASSISTANT_PROPOSAL_SENTENCE_MAX = 300
/** The longest reason a proposal gives. */
export const ASSISTANT_PROPOSAL_WHY_MAX = 2_000
/** The longest task a proposal asks to run. */
export const ASSISTANT_PROPOSAL_TASK_MAX = 8_000

/** What a patrol proposes to do (assistant-mode.md §5.10): the card's sentence, its reason and the item it came from; the task is the draft's `text`. */
export const AssistantActivityProposal = z.object({
  sentence: z.string().min(1).max(ASSISTANT_PROPOSAL_SENTENCE_MAX),
  why: z.string().max(ASSISTANT_PROPOSAL_WHY_MAX),
  itemId: ref,
  /** The item's title as the daemon last saw it; null once the item is gone. */
  itemTitle: z.string().max(300).nullable()
})
export type AssistantActivityProposal = z.infer<typeof AssistantActivityProposal>

/** A draft awaiting approval: where it would post, the exact text, who approves, and when it lapses; a `task` is a proposal, run in the item's place once approved. */
export const AssistantActivityDraft = z.object({
  id: ref,
  kind: z.enum(['reply', 'elsewhere', 'task']),
  target: z.object({
    platform: z.string().min(1).max(64),
    /** Null only for a proposal in a place with no integration (webchat). */
    integrationId: ref.nullable(),
    channel: ref,
    thread: ref.nullable(),
    /** The conversation's name, or the direct message recipient's, as resolved when the draft was written. */
    name,
    dm: z.boolean(),
    external: z.boolean()
  }),
  text: z.string().min(1).max(40_000),
  /** The card offers "always allow from here to there". */
  offerAlways: z.boolean().default(false),
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
  /** Present on a `task`: what it would do and why. */
  proposal: AssistantActivityProposal.optional(),
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
    limit: z.number().int().min(1).max(ASSISTANT_ACTIVITY_SUBSESSIONS_MAX),
    /** Only the sub-sessions this conversation opened, newest first and paged; absent lists the agent's, running first. */
    parent: z.object({ sessionId: ref, cursor: AssistantSubsessionCursor.optional() }).optional()
  }),
  z.object({
    agentId,
    operation: z.literal('drafts'),
    limit: z.number().int().min(1).max(ASSISTANT_ACTIVITY_DRAFTS_MAX),
    /** Also list proposals (`kind: 'task'`); an older daemon ignores it and has none. */
    proposals: z.boolean().optional()
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
    truncated: z.boolean(),
    /** Where the next page of a `parent` read starts; null on its last page and on every unnarrowed read. */
    nextCursor: AssistantSubsessionCursor.nullable().optional()
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

/** How an editor decides a draft; `always` also allows later posts from here to there, where the card offers it. */
export const AssistantDraftChoice = z.enum(['approve', 'always', 'discard'])
export type AssistantDraftChoice = z.infer<typeof AssistantDraftChoice>

export const AssistantDraftStatus = z.enum([
  'awaiting_review',
  'executing',
  'succeeded',
  'failed',
  'outcome_unknown',
  'denied',
  'expired'
])
export type AssistantDraftStatus = z.infer<typeof AssistantDraftStatus>

/** C→D REQ: an editor deleting an item, revoking a grant or deciding a draft, or someone who may continue a sub-session stopping it; the Control Plane has already checked the caller. */
export const AssistantActivityWriteReq = z.discriminatedUnion('operation', [
  z.object({ agentId, operation: z.literal('delete-item'), itemId: ref }),
  z.object({ agentId, operation: z.literal('revoke-grant'), grantId: z.string().regex(/^[0-9a-f]{32}$/) }),
  z.object({
    agentId,
    operation: z.literal('decide-draft'),
    draftId: ref,
    choice: AssistantDraftChoice,
    /** The console user deciding, stamped by the Control Plane. */
    decider: z.object({ userId: ref, name })
  }),
  z.object({
    agentId,
    operation: z.literal('stop-subsession'),
    /** The sub-session's outward id; the daemon interrupts it only if its index holds it for this agent. */
    sessionId: ref,
    /** The console user stopping it, stamped by the Control Plane and named in its transcript. */
    actor: z.object({ userId: ref, name })
  })
])
export type AssistantActivityWriteReq = z.infer<typeof AssistantActivityWriteReq>

/** `decided` when this call settled the draft; otherwise why it could not, and this call posted nothing; `busy` leaves a proposal waiting while the agent's sub-sessions are at their limit. */
export const AssistantDraftDecisionResult = z.enum(['decided', 'not-found', 'expired', 'already-decided', 'busy'])
export type AssistantDraftDecisionResult = z.infer<typeof AssistantDraftDecisionResult>

/** `stopped` interrupted its current turn; `not-running` found no turn to interrupt; `not-found` is no sub-session of this agent. */
export const AssistantSubsessionStopResult = z.enum(['stopped', 'not-running', 'not-found'])
export type AssistantSubsessionStopResult = z.infer<typeof AssistantSubsessionStopResult>

/** D→C REP: `found` is false when there was nothing to delete or revoke; a decision reports the draft's status after it. */
export const AssistantActivityWriteResult = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('delete-item'), found: z.boolean() }),
  z.object({ operation: z.literal('revoke-grant'), found: z.boolean() }),
  z.object({
    operation: z.literal('decide-draft'),
    result: AssistantDraftDecisionResult,
    status: AssistantDraftStatus.nullable(),
    /** This decision recorded "always allow from here to there". */
    granted: z.boolean(),
    failure: z.string().max(2_000).nullable()
  }),
  z.object({ operation: z.literal('stop-subsession'), result: AssistantSubsessionStopResult })
])
export type AssistantActivityWriteResult = z.infer<typeof AssistantActivityWriteResult>

/** Whether a read result fits the byte budget the daemon trims to. */
export function assistantActivityResultFits(result: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(result)).byteLength <= ASSISTANT_ACTIVITY_RESULT_BYTES
}
