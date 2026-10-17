import { z } from 'zod'
import { FollowUpEventKind, FollowUpWatchState } from './follow-up-watch.js'
import { AGENT_PERMISSION_MAX_OPTIONS, AgentPermissionOption } from './agent.js'

// The console's Activity view of an assistant-mode agent (assistant-mode.md §1.7, §5.11): the owning daemon answers from its store, the Control Plane proxies and keeps nothing.

/** Daemon serves `assistant/activity/read` and `assistant/activity/write`; an older daemon ignores both, so the Control Plane checks first. */
export const ASSISTANT_ACTIVITY_FEATURE = 'assistant-activity-v1'

/** Daemon serves `decide-draft` on `assistant/activity/write`: an editor approves or discards a draft from the console. */
export const ASSISTANT_DRAFT_DECISION_FEATURE = 'assistant-draft-decision-v1'

/** Daemon serves a `subsessions` read narrowed to one conversation and `stop-subsession` writes; an older daemon would list every conversation's. */
export const ASSISTANT_SUBSESSION_PANEL_FEATURE = 'assistant-subsession-panel-v1'

/** Daemon serves a `drafts` read narrowed to one webchat conversation's proposals and a `decide-draft` bound to one; an older daemon would ignore both and answer for every draft. */
export const ASSISTANT_CONVERSATION_PROPOSALS_FEATURE = 'assistant-conversation-proposals-v1'

/** Daemon keeps follow-ups in place of items (assistant-mode.md §5.12): its `subsessions` read carries them, and it answers no items. */
export const FOLLOW_UP_TASKS_V1_FEATURE = 'follow-up-tasks-v1'

/** Daemon carries each follow-up's `id` and ends one by it with `stop-follow-up`, before its first check too, and reads one task by its session id with `task`. */
export const ASSISTANT_TASK_HANDLE_FEATURE = 'assistant-task-handle-v1'

/** JSON bytes one read result may take, leaving envelope headroom below the 256 KiB wire cap; a list stops short and says so. */
export const ASSISTANT_ACTIVITY_RESULT_BYTES = 192 * 1024

export const ASSISTANT_ACTIVITY_ITEMS_MAX = 100
export const ASSISTANT_ACTIVITY_SUBSESSIONS_MAX = 50
export const ASSISTANT_ACTIVITY_DRAFTS_MAX = 50
export const ASSISTANT_ACTIVITY_PERMISSIONS_MAX = 50
/** Distinct follower places carried per item. */
export const ASSISTANT_ACTIVITY_PLACES_MAX = 20
/** Newest observations carried by one item read. */
export const ASSISTANT_ACTIVITY_OBSERVATIONS_MAX = 10
/** Newest checks carried per follow-up. */
export const ASSISTANT_ACTIVITY_CHECKS_MAX = 5

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

/** Opaque to everyone but the daemon that minted it: where the next page of one conversation's background work starts. */
export const AssistantSubsessionCursor = z.string().min(1).max(1_024)

/** Which kind of task a row is; an older daemon names none. */
export const AssistantActivityTaskKind = z.enum(['delegated', 'follow-up', 'approved-proposal'])
export type AssistantActivityTaskKind = z.infer<typeof AssistantActivityTaskKind>

/** One finished check of a follow-up: when it started, what it saw (or why it failed), and whether its report reached the conversation. */
export const AssistantActivityCheck = z.object({
  at: time,
  observation: z.string().max(2_000),
  reported: z.boolean(),
  /** What started it: its scheduled time, a message, or events on what the follow-up watches (§5.14). */
  startedBy: z.enum(['time', 'message', 'wake']).optional(),
  /** The events it took from a wake, whatever started it. */
  events: z.array(FollowUpEventKind).max(FollowUpEventKind.options.length).optional()
})
export type AssistantActivityCheck = z.infer<typeof AssistantActivityCheck>

/** `waiting` between checks, `checking` while one runs, `paused` after five failed checks in a row until it is messaged, then `done` or `stopped`. */
export const AssistantActivityFollowUpStatus = z.enum(['waiting', 'checking', 'paused', 'done', 'stopped'])
export type AssistantActivityFollowUpStatus = z.infer<typeof AssistantActivityFollowUpStatus>

/** A follow-up's own fields (assistant-mode.md §5.12); its row's `state` is `open` until it is done or stopped. */
export const AssistantActivityFollowUp = z.object({
  /** Its own id from a daemon with `assistant-task-handle-v1`, which `stop-follow-up` ends it by. */
  id: ref.optional(),
  /** Its label; shown only where the row's conversation may be viewed. */
  title: z.string().max(300),
  doneWhen: z.string().max(2_000).nullable(),
  status: AssistantActivityFollowUpStatus,
  /** The next scheduled check; null when it waits until it is messaged, or has ended. */
  nextCheck: time.nullable(),
  /** Newest first. */
  recentChecks: z.array(AssistantActivityCheck).max(ASSISTANT_ACTIVITY_CHECKS_MAX),
  /** A first look of its place (assistant-mode.md §5.13), which ends after one check. */
  firstLook: z.boolean().optional(),
  /** The one object it watches (§5.14): its URL, its label once taken, and why it is not watched. */
  watch: z
    .object({
      url: z.string().max(500),
      target: z.string().max(400).nullable(),
      state: FollowUpWatchState,
      reason: z.string().max(64).nullable()
    })
    .optional()
})
export type AssistantActivityFollowUp = z.infer<typeof AssistantActivityFollowUp>

export const AssistantActivitySubsession = z.object({
  /** The background work's outward session id; null until its session exists. */
  sessionId: ref.nullable(),
  /** The conversation that opened it, by its session's outward id; for a follow-up, its place's current long session. */
  parentSessionId: ref,
  state: AssistantActivitySubsessionState,
  createdAt: time,
  kind: AssistantActivityTaskKind.optional(),
  /** Present on a follow-up, from a daemon with `follow-up-tasks-v1`. */
  followUp: AssistantActivityFollowUp.optional()
})
export type AssistantActivitySubsession = z.infer<typeof AssistantActivitySubsession>

/** The longest sentence a proposal's card leads with. */
export const ASSISTANT_PROPOSAL_SENTENCE_MAX = 300
/** The longest reason a proposal gives. */
export const ASSISTANT_PROPOSAL_WHY_MAX = 2_000
/** The longest task a proposal asks to run. */
export const ASSISTANT_PROPOSAL_TASK_MAX = 8_000

/** The follow-up a proposal's follow-up form takes once approved (assistant-mode.md §5.13), in place of a task. */
export const AssistantActivityProposalFollowUp = z.object({
  title: z.string().min(1).max(300),
  doneWhen: z.string().max(2_000),
  /** Its first check; null waits until it is messaged. */
  nextCheck: time.nullable(),
  /** The URL it would watch (§5.14). */
  watch: z.string().max(500).optional()
})
export type AssistantActivityProposalFollowUp = z.infer<typeof AssistantActivityProposalFollowUp>

/** What a follow-up's check proposes to do (assistant-mode.md §5.10): the card's sentence, its reason and its follow-up, by `itemId`; the task is the draft's `text`. */
export const AssistantActivityProposal = z.object({
  sentence: z.string().min(1).max(ASSISTANT_PROPOSAL_SENTENCE_MAX),
  why: z.string().max(ASSISTANT_PROPOSAL_WHY_MAX),
  itemId: ref,
  /** The follow-up's title as the daemon last saw it; null once it is gone. */
  itemTitle: z.string().max(300).nullable(),
  /** The follow-up form: what an approval takes, with the approver as its asker; the draft's `text` is then its title. */
  followUp: AssistantActivityProposalFollowUp.optional()
})
export type AssistantActivityProposal = z.infer<typeof AssistantActivityProposal>

/** A draft awaiting approval: where it would post, the exact text, who approves, and when it lapses; a `task` is a proposal, run in its follow-up's place once approved. */
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
  /** A webchat proposal, decided on its conversation's page by whoever may continue it; its `approver` is null. */
  inConversation: z.boolean().optional(),
  createdAt: time,
  expiresAt: time
})
export type AssistantActivityDraft = z.infer<typeof AssistantActivityDraft>

/** A webchat conversation by its session's outward id. */
export const AssistantActivityConversation = z.object({ sessionId: ref })
export type AssistantActivityConversation = z.infer<typeof AssistantActivityConversation>

/** A runtime permission request from background work awaiting a human (assistant-mode.md §5.6): which background work, which tool, and when its wait runs out. */
export const AssistantActivityPermission = z.object({
  requestId: z.string().uuid(),
  /** The background work's outward session id. */
  sessionId: ref,
  /** The conversation it belongs to, by its session's outward id. */
  parentSessionId: ref,
  /** What it asks to run, secret-masked and bounded as the approval queue shows it. */
  tool: z.string().max(240),
  createdAt: time,
  /** When it is denied and the background work stops, unless someone answers first. */
  expiresAt: time,
  /** The request's own options; absent when it takes a plain Allow or Deny. */
  options: z.array(AgentPermissionOption).max(AGENT_PERMISSION_MAX_OPTIONS).optional()
})
export type AssistantActivityPermission = z.infer<typeof AssistantActivityPermission>

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
    /** Only the background work this conversation started, newest first and paged; absent lists the agent's, running first. */
    parent: z.object({ sessionId: ref, cursor: AssistantSubsessionCursor.optional() }).optional()
  }),
  /** One task by its own session's outward id, from a daemon with `assistant-task-handle-v1`. */
  z.object({ agentId, operation: z.literal('task'), sessionId: ref }),
  z.object({
    agentId,
    operation: z.literal('drafts'),
    limit: z.number().int().min(1).max(ASSISTANT_ACTIVITY_DRAFTS_MAX),
    /** Also list proposals (`kind: 'task'`); an older daemon ignores it and has none. */
    proposals: z.boolean().optional(),
    /** Also list background work's pending permission requests; an older daemon ignores it and lists none. */
    permissions: z.boolean().optional(),
    /** Only this webchat conversation's proposals, no posts and no permission requests; an older daemon ignores it. */
    conversation: AssistantActivityConversation.optional()
  })
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
    nextCursor: AssistantSubsessionCursor.nullable().optional(),
    /** True from a daemon with `follow-up-tasks-v1`: follow-ups are rows here, and it keeps no items. */
    followUps: z.boolean().optional()
  }),
  /** Null when the agent's index holds no task by that session. */
  z.object({ operation: z.literal('task'), task: AssistantActivitySubsession.nullable() }),
  z.object({
    operation: z.literal('drafts'),
    drafts: z.array(AssistantActivityDraft).max(ASSISTANT_ACTIVITY_DRAFTS_MAX),
    truncated: z.boolean(),
    /** Present only when asked for, oldest first. */
    permissions: z.array(AssistantActivityPermission).max(ASSISTANT_ACTIVITY_PERMISSIONS_MAX).optional()
  })
])
export type AssistantActivityReadResult = z.infer<typeof AssistantActivityReadResult>

/** How an editor decides a draft. */
export const AssistantDraftChoice = z.enum(['approve', 'discard'])
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

/** C→D REQ: an editor deleting an item or deciding a draft, someone who may continue a webchat conversation deciding its proposal, or one who may continue background work stopping it; the Control Plane has already checked the caller. */
export const AssistantActivityWriteReq = z.discriminatedUnion('operation', [
  z.object({ agentId, operation: z.literal('delete-item'), itemId: ref }),
  z.object({
    agentId,
    operation: z.literal('decide-draft'),
    draftId: ref,
    choice: AssistantDraftChoice,
    /** The console user deciding, stamped by the Control Plane. */
    decider: z.object({ userId: ref, name }),
    /** Decide only a proposal of this webchat conversation; any other draft answers `not-found`. */
    conversation: AssistantActivityConversation.optional()
  }),
  z.object({
    agentId,
    operation: z.literal('stop-subsession'),
    /** The background work's outward session id; the daemon interrupts it only if its index holds it for this agent. */
    sessionId: ref,
    /** The console user stopping it, stamped by the Control Plane and named in its transcript. */
    actor: z.object({ userId: ref, name })
  }),
  /** End a follow-up by its id, from a daemon with `assistant-task-handle-v1`; only while its row names `parentSessionId`, the conversation the Control Plane checked the caller against. */
  z.object({
    agentId,
    operation: z.literal('stop-follow-up'),
    followUpId: ref,
    parentSessionId: ref,
    actor: z.object({ userId: ref, name })
  })
])
export type AssistantActivityWriteReq = z.infer<typeof AssistantActivityWriteReq>

/** `decided` when this call settled the draft; otherwise why it could not, and this call posted nothing; `busy` leaves a proposal waiting while the agent's background work is at its limit. */
export const AssistantDraftDecisionResult = z.enum(['decided', 'not-found', 'expired', 'already-decided', 'busy'])
export type AssistantDraftDecisionResult = z.infer<typeof AssistantDraftDecisionResult>

/** `stopped` interrupted its current turn; `not-running` found no turn to interrupt; `not-found` is no background work of this agent. */
export const AssistantSubsessionStopResult = z.enum(['stopped', 'not-running', 'not-found'])
export type AssistantSubsessionStopResult = z.infer<typeof AssistantSubsessionStopResult>

/** D→C REP: `found` is false when there was nothing to delete; a decision reports the draft's status after it. */
export const AssistantActivityWriteResult = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('delete-item'), found: z.boolean() }),
  z.object({
    operation: z.literal('decide-draft'),
    result: AssistantDraftDecisionResult,
    status: AssistantDraftStatus.nullable(),
    failure: z.string().max(2_000).nullable(),
    /** The follow-up an approved follow-up form took, and the conversation it belongs to by its session's outward id. */
    followUp: z.object({ id: ref, parentSessionId: ref }).optional()
  }),
  z.object({ operation: z.literal('stop-subsession'), result: AssistantSubsessionStopResult }),
  z.object({ operation: z.literal('stop-follow-up'), result: AssistantSubsessionStopResult })
])
export type AssistantActivityWriteResult = z.infer<typeof AssistantActivityWriteResult>

/** Whether a read result fits the byte budget the daemon trims to. */
export function assistantActivityResultFits(result: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(result)).byteLength <= ASSISTANT_ACTIVITY_RESULT_BYTES
}
