// The console's Activity view of an agent (assistant-mode.md §1.7, §5.11), answered from this daemon's store; follow-ups and proposals only in assistant mode.
import {
  ASSISTANT_ACTIVITY_CHECKS_MAX,
  ASSISTANT_ACTIVITY_RESULT_BYTES,
  type AssistantActivityDraft,
  type AssistantActivityErrorReason,
  type AssistantActivityFollowUp,
  type AssistantActivityPermission,
  type AssistantActivityReadReq,
  type AssistantActivityReadResult,
  type AssistantActivitySubsession,
  type AssistantActivityWriteReq,
  type AssistantActivityWriteResult,
  type AssistantDraftChoice
} from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'
import type { DecisionConversation, DraftDecision } from '../assistant/drafts.js'
import { assistantModeOn } from '../mcp/ops/assistant-items.js'
import {
  isSubsessionCoordinate,
  isTaskCoordinate,
  SUBSESSION_COORDINATE_PREFIX
} from '../session/subsession-coordinate.js'
import type { AssistantDraft, AssistantDraftLedger } from '../store/assistant-drafts.js'
import type { AssistantItem, AssistantItemLedger } from '../store/assistant-items.js'
import type { AssistantPatrolLedger } from '../store/assistant-patrols.js'
import type { AssistantSubsession, AssistantSubsessionIndex } from '../store/assistant-subsessions.js'
import type { SessionRecord } from '../store/local-store.js'

/** A refused request → `BAD_PAYLOAD` with `reason` in the error frame's details. */
export class AssistantActivityViolationError extends Error {
  constructor(
    message: string,
    readonly reason: AssistantActivityErrorReason
  ) {
    super(message)
    this.name = 'AssistantActivityViolationError'
  }
}

/** What the view reads and edits; every query is scoped by the agent the request names. */
export interface AssistantActivityStore {
  assistantItems: Pick<AssistantItemLedger, 'get' | 'byTaskKey'>
  assistantPatrols: Pick<AssistantPatrolLedger, 'get' | 'checks'>
  assistantDrafts: Pick<AssistantDraftLedger, 'listPending' | 'get'>
  assistantSubsessions: Pick<AssistantSubsessionIndex, 'list' | 'listForParent' | 'get' | 'adoptFollowUps'>
  getSession(key: string): Promise<SessionRecord | undefined>
  getSessionByOutwardId(sessionId: string, agentId?: string): Promise<SessionRecord | undefined>
  placeSession(
    agentId: string,
    platform: string,
    channel: string,
    transportScope?: string | null
  ): Promise<SessionRecord | undefined>
  getDisplayNames(ids: string[]): Promise<Map<string, string>>
}

export interface AssistantActivityDeps {
  store(): AssistantActivityStore
  agent(agentId: string): Pick<Agent, 'assistantMode'> | undefined
  now(): number
  /** The draft decision a card click runs, entered from the console; `conversation` binds it to one webchat conversation's proposals. */
  decideDraft(input: {
    agentId: string
    draftId: string
    choice: AssistantDraftChoice
    decider: { userId: string; name: string | null }
    conversation?: DecisionConversation
  }): Promise<DraftDecision>
  /** The `!cancel` core every stop surface shares; true when it interrupted a turn. */
  stopSession(key: string, actor: { userId: string; name?: string }): Promise<boolean>
  /** End a follow-up from the console (assistant-mode.md §5.12); `ended` when it already had. */
  stopFollowUp?(
    agentId: string,
    item: AssistantItem,
    actor: { userId: string; name?: string }
  ): Promise<'stopped' | 'ended'>
  /** Background sub-sessions' permission requests still waiting on a human (assistant-mode.md §5.6), decided through the approval queue. */
  pendingPermissions?(agentId: string): AssistantActivityPermission[]
}

/** The seam the CP client dispatches `assistant/activity/*` to. */
export interface AssistantActivity {
  read(req: AssistantActivityReadReq): Promise<AssistantActivityReadResult>
  write(req: AssistantActivityWriteReq): Promise<AssistantActivityWriteResult>
}

// Room for the answer's own fields around its list.
const ANSWER_OVERHEAD_BYTES = 1_024

export function createAssistantActivity(deps: AssistantActivityDeps): AssistantActivity {
  // Only an agent this daemon holds; true while it is in assistant mode, whose follow-ups and proposals the view adds.
  const admit = (agentId: string): boolean => {
    const agent = deps.agent(agentId)
    if (!agent) throw new AssistantActivityViolationError(`unknown agent "${agentId}"`, 'unknown-agent')
    return assistantModeOn(agent)
  }
  // A proposal changed outside assistant mode is refused, as every write once was.
  const modeOff = (agentId: string): AssistantActivityViolationError =>
    new AssistantActivityViolationError(`agent "${agentId}" is not in assistant mode`, 'assistant-mode-off')
  // Whether the draft is one of the agent's proposals.
  const isProposal = async (store: AssistantActivityStore, agentId: string, draftId: string): Promise<boolean> => {
    const draft = await store.assistantDrafts.get(draftId)
    return draft?.agentId === agentId && draft.action === 'task'
  }
  // The agent's own webchat conversation by its session's outward id; a sub-session's page is none.
  const webchatConversation = async (
    store: AssistantActivityStore,
    agentId: string,
    sessionId: string
  ): Promise<DecisionConversation | undefined> => {
    const rec = await store.getSessionByOutwardId(sessionId, agentId)
    if (rec?.agentId !== agentId || rec.platform !== 'webchat' || isSubsessionCoordinate(rec.thread)) return undefined
    return { platform: rec.platform, channel: rec.channel }
  }
  // A conversation that is its place's current long session owns the place's follow-ups, so they are listed under it.
  const adoptInto = async (store: AssistantActivityStore, agentId: string, sessionId: string): Promise<void> => {
    const rec = await store.getSessionByOutwardId(sessionId, agentId)
    if (rec?.agentId !== agentId || isSubsessionCoordinate(rec.thread)) return
    const place = await store.placeSession(agentId, rec.platform, rec.channel, rec.transportScope ?? null)
    if (place?.key !== rec.key) return
    await store.assistantSubsessions.adoptFollowUps(
      agentId,
      { platform: rec.platform, channel: rec.channel, transportScope: rec.transportScope ?? null },
      { sessionId, key: rec.key }
    )
  }

  return {
    async read(req) {
      const assistant = admit(req.agentId)
      const store = deps.store()
      switch (req.operation) {
        // Items became follow-ups (assistant-mode.md §5.12), which the task list carries.
        case 'items':
          return { operation: 'items', items: [], truncated: false }
        case 'item':
          return { operation: 'item', item: null }
        case 'subsessions': {
          const subsessionOf = (row: AssistantSubsession) => taskOf(store, req.agentId, row)
          // Follow-ups are listed only in assistant mode.
          const delegationsOnly = !assistant
          if (!req.parent) {
            const rows = await store.assistantSubsessions.list(req.agentId, req.limit + 1, { delegationsOnly })
            // A follow-up row carries its checks, so the wire budget, not the row limit, bounds the answer.
            const { kept, trimmed } = withinBudget(await Promise.all(rows.slice(0, req.limit).map(subsessionOf)))
            return {
              operation: 'subsessions',
              subsessions: kept,
              truncated: rows.length > req.limit || trimmed,
              followUps: true
            }
          }
          if (assistant && req.parent.cursor === undefined) await adoptInto(store, req.agentId, req.parent.sessionId)
          const after = req.parent.cursor === undefined ? undefined : cursorPosition(req.parent.cursor)
          const rows = await store.assistantSubsessions.listForParent(req.agentId, req.parent.sessionId, {
            limit: req.limit + 1,
            ...(after ? { after } : {}),
            delegationsOnly
          })
          const page = rows.slice(0, req.limit)
          const { kept, trimmed } = withinBudget(await Promise.all(page.map(subsessionOf)))
          // The next page starts after the last row this answer actually carries.
          const last = page[kept.length - 1]
          const more = (rows.length > req.limit || trimmed) && last !== undefined
          return {
            operation: 'subsessions',
            subsessions: kept,
            truncated: more,
            nextCursor: more ? cursorOf(last) : null,
            followUps: true
          }
        }
        case 'task': {
          const child = await store.getSessionByOutwardId(req.sessionId, req.agentId)
          const row =
            child?.agentId === req.agentId ? await store.assistantSubsessions.get(req.agentId, child.key) : undefined
          // A follow-up is shown only in assistant mode, as the list does.
          if (!row || (row.kind === 'patrol' && !assistant)) return { operation: 'task', task: null }
          return { operation: 'task', task: await taskOf(store, req.agentId, row) }
        }
        case 'drafts': {
          // One webchat conversation's proposals only, none for a session that is not one, and none outside assistant mode.
          const place =
            req.conversation && assistant
              ? await webchatConversation(store, req.agentId, req.conversation.sessionId)
              : undefined
          // Proposals only for a Control Plane that asked: an older one cannot read them.
          const rows =
            req.conversation && !place
              ? []
              : await store.assistantDrafts.listPending(req.agentId, req.limit + 1, deps.now(), {
                  tasks: assistant && req.proposals === true,
                  ...(place ? { place } : {})
                })
          const page = rows.slice(0, req.limit)
          const names = await store.getDisplayNames(
            page.flatMap((d) => (d.approver?.userId ? [d.approver.userId] : []))
          )
          const titles = new Map<string, string | null>()
          for (const draft of page) {
            const itemId = draft.proposal?.itemId
            if (itemId && !titles.has(itemId))
              titles.set(itemId, (await store.assistantItems.get(req.agentId, itemId))?.title ?? null)
          }
          const { kept, trimmed } = withinBudget(page.map((draft) => draftOf(draft, names, titles)))
          // Permission requests only for a Control Plane that asked, as proposals are, and never with one conversation's proposals.
          const permissions =
            req.permissions === true && !req.conversation ? (deps.pendingPermissions?.(req.agentId) ?? []) : undefined
          return {
            operation: 'drafts',
            drafts: kept,
            truncated: rows.length > req.limit || trimmed,
            ...(permissions ? { permissions } : {})
          }
        }
      }
    },

    async write(req) {
      const assistant = admit(req.agentId)
      const store = deps.store()
      switch (req.operation) {
        // Items became follow-ups, which the console stops instead.
        case 'delete-item':
          return { operation: 'delete-item', found: false }
        case 'decide-draft': {
          // Bound to one webchat conversation: a session that is not one has no proposal to decide.
          const { conversation: bound, ...decide } = req
          if (!assistant && (bound || (await isProposal(store, req.agentId, req.draftId)))) throw modeOff(req.agentId)
          const conversation = bound ? await webchatConversation(store, req.agentId, bound.sessionId) : undefined
          if (bound && !conversation)
            return { operation: 'decide-draft', result: 'not-found', status: null, failure: null }
          const decision = await deps.decideDraft({ ...decide, ...(conversation ? { conversation } : {}) })
          return { operation: 'decide-draft', ...decision, failure: clipText(decision.failure, 1_000) }
        }
        case 'stop-subsession': {
          // Only a sub-session this agent's index holds, so the console's stop reaches no other session.
          const child = await store.getSessionByOutwardId(req.sessionId, req.agentId)
          const row = child ? await store.assistantSubsessions.get(req.agentId, child.key) : undefined
          if (!child || !row) return { operation: 'stop-subsession', result: 'not-found' }
          const { userId, name } = req.actor
          const actor = { userId, ...(name ? { name } : {}) }
          // A follow-up's Stop ends it (assistant-mode.md §5.12), not just its check.
          if (row.kind === 'patrol') {
            const item = await store.assistantItems.byTaskKey(req.agentId, row.childSessionKey)
            if (!item || !deps.stopFollowUp) return { operation: 'stop-subsession', result: 'not-found' }
            const ended = await deps.stopFollowUp(req.agentId, item, actor)
            return { operation: 'stop-subsession', result: ended === 'stopped' ? 'stopped' : 'not-running' }
          }
          const result = await stopIndexedSubsession(row, deps.stopSession, actor)
          return { operation: 'stop-subsession', result }
        }
        case 'stop-follow-up': {
          // Only while its row names the conversation the Control Plane checked the caller against, so no other place's follow-up ends.
          const item = await store.assistantItems.get(req.agentId, req.followUpId)
          const row = item ? await store.assistantSubsessions.get(req.agentId, item.taskKey) : undefined
          if (!item || row?.kind !== 'patrol' || row.parentSessionId !== req.parentSessionId || !deps.stopFollowUp)
            return { operation: 'stop-follow-up', result: 'not-found' }
          const { userId, name } = req.actor
          const ended = await deps.stopFollowUp(req.agentId, item, { userId, ...(name ? { name } : {}) })
          return { operation: 'stop-follow-up', result: ended === 'stopped' ? 'stopped' : 'not-running' }
        }
      }
    }
  }
}

/** The Stop every surface shares (assistant-mode.md §5.8): an indexed sub-session's current turn, only while it is open. */
export async function stopIndexedSubsession(
  row: Pick<AssistantSubsession, 'childSessionKey' | 'state'>,
  stopSession: AssistantActivityDeps['stopSession'],
  actor: { userId: string; name?: string }
): Promise<'stopped' | 'not-running'> {
  if (row.state !== 'open') return 'not-running'
  return (await stopSession(row.childSessionKey, actor)) ? 'stopped' : 'not-running'
}

/** One indexed task as the list and the single read carry it: its session once it exists, its kind, and a follow-up's own fields. */
async function taskOf(
  store: AssistantActivityStore,
  agentId: string,
  row: AssistantSubsession
): Promise<AssistantActivitySubsession> {
  const child = await store.getSession(row.childSessionKey)
  const base = {
    sessionId: child?.agentId === agentId ? (child.sessionId ?? null) : null,
    parentSessionId: row.parentSessionId,
    createdAt: iso(row.createdAt)
  }
  if (row.kind === 'patrol') {
    const item = await store.assistantItems.byTaskKey(agentId, row.childSessionKey)
    const followUp = item ? await followUpOf(store, row, item) : undefined
    const ended = followUp?.status === 'done' || followUp?.status === 'stopped'
    return { ...base, state: ended ? 'done' : 'open', kind: 'follow-up', ...(followUp ? { followUp } : {}) }
  }
  return {
    ...base,
    // A sub-session whose failure report is still on its way has ended, as `failed` shows.
    state: row.state === 'reporting' ? 'failed' : row.state,
    kind: isTaskCoordinate(coordinateOf(row.childSessionKey)) ? 'approved-proposal' : 'delegated'
  }
}

/** A follow-up as the task list carries it: its id, state, next check and newest finished checks. */
async function followUpOf(
  store: AssistantActivityStore,
  row: AssistantSubsession,
  item: AssistantItem
): Promise<AssistantActivityFollowUp> {
  const state = await store.assistantPatrols.get(item.agentId, item.id)
  const open = item.status === 'active' || item.status === 'waiting'
  const status: AssistantActivityFollowUp['status'] = !open
    ? item.status === 'done'
      ? 'done'
      : 'stopped'
    : row.state === 'open'
      ? 'checking'
      : state?.stopped
        ? 'paused'
        : 'waiting'
  const checks = await store.assistantPatrols.checks(item.agentId, item.id, ASSISTANT_ACTIVITY_CHECKS_MAX + 1)
  return {
    id: item.id,
    title: item.title,
    doneWhen: item.doneWhen,
    status,
    nextCheck: open && item.nextCheck !== null ? iso(item.nextCheck) : null,
    recentChecks: checks
      .filter((check) => check.endedAt !== null && check.observation !== null)
      .slice(0, ASSISTANT_ACTIVITY_CHECKS_MAX)
      .map((check) => ({ at: iso(check.startedAt), observation: check.observation!, reported: check.reported }))
  }
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** The child key's coordinate, from its reserved prefix on. */
const coordinateOf = (key: string): string | undefined => {
  const at = key.indexOf(`:${SUBSESSION_COORDINATE_PREFIX}`)
  return at >= 0 ? key.slice(at + 1) : undefined
}

/** Where a page of one conversation's sub-sessions ends, in a form only this module reads back. */
const cursorOf = (row: AssistantSubsession): string =>
  Buffer.from(JSON.stringify([row.createdAt, row.childSessionKey]), 'utf8').toString('base64url')

function cursorPosition(cursor: string): { createdAt: number; childSessionKey: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (Array.isArray(value) && Number.isSafeInteger(value[0]) && typeof value[1] === 'string' && value.length === 2)
      return { createdAt: value[0] as number, childSessionKey: value[1] }
  } catch {
    // Falls through to the refusal below.
  }
  throw new AssistantActivityViolationError('the task page cursor is not one this daemon issued', 'bad-cursor')
}

const clipText = (text: string | null, max: number): string | null =>
  text === null ? null : [...text].slice(0, max).join('')

// A display name is a platform's to choose; the wire bounds it.
const clip = (name: string | null): string | null => clipText(name, 256)

function draftOf(
  draft: AssistantDraft,
  names: Map<string, string>,
  titles: Map<string, string | null>
): AssistantActivityDraft {
  // A webchat place has no integration to name: its people decide on the conversation's page.
  const inConversation = draft.approver?.kind === 'place' && draft.approver.integrationId === ''
  const approver = inConversation ? null : draft.approver
  const proposal = draft.proposal
  return {
    id: draft.id,
    kind: draft.kind,
    target: {
      platform: draft.target.platform,
      integrationId: draft.target.integrationId || null,
      channel: draft.target.channel,
      thread: draft.target.thread,
      name: clip(draft.destination.name),
      dm: draft.targetDm,
      external: draft.targetExternal
    },
    text: draft.text,
    approver: approver
      ? {
          // A proposal carded in its own place is approved by people there, which the wire names as a conversation.
          kind: approver.kind === 'member' ? 'member' : 'conversation',
          integrationId: approver.integrationId,
          channel: approver.channel,
          userId: approver.userId,
          consoleUserId: approver.consoleUserId,
          name: approver.userId ? clip(names.get(approver.userId) ?? null) : null
        }
      : null,
    ...(proposal
      ? {
          proposal: {
            sentence: proposal.sentence,
            why: proposal.why,
            itemId: proposal.itemId,
            itemTitle: titles.get(proposal.itemId) ?? null
          }
        }
      : {}),
    ...(inConversation ? { inConversation } : {}),
    createdAt: iso(draft.createdAt),
    expiresAt: iso(draft.expiresAt)
  }
}

/** Keeps entries in order while the answer stays inside the wire budget. */
function withinBudget<T>(entries: readonly T[]): { kept: T[]; trimmed: boolean } {
  const kept: T[] = []
  let used = ANSWER_OVERHEAD_BYTES
  for (const entry of entries) {
    used += Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
    if (used > ASSISTANT_ACTIVITY_RESULT_BYTES) return { kept, trimmed: true }
    kept.push(entry)
  }
  return { kept, trimmed: false }
}
