// The console's Activity view of an assistant-mode agent (assistant-mode.md §1.7, §5.11), answered from this daemon's store.
import {
  ASSISTANT_ACTIVITY_GRANTS_MAX,
  ASSISTANT_ACTIVITY_OBSERVATIONS_MAX,
  ASSISTANT_ACTIVITY_PLACES_MAX,
  ASSISTANT_ACTIVITY_RESULT_BYTES,
  type AssistantActivityDraft,
  type AssistantActivityErrorReason,
  type AssistantActivityGrant,
  type AssistantActivityItem,
  type AssistantActivityPlace,
  type AssistantActivityReadReq,
  type AssistantActivityReadResult,
  type AssistantActivityWriteReq,
  type AssistantActivityWriteResult,
  type AssistantDraftChoice
} from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'
import type { DraftDecision } from '../assistant/drafts.js'
import { assistantModeOn } from '../mcp/ops/assistant-items.js'
import type { AssistantDraft, AssistantDraftLedger } from '../store/assistant-drafts.js'
import type {
  AssistantItemLedger,
  AssistantItemOverview,
  AssistantItemStatus,
  AssistantPlace
} from '../store/assistant-items.js'
import type { AssistantSubsessionIndex } from '../store/assistant-subsessions.js'
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
  assistantItems: Pick<AssistantItemLedger, 'list' | 'get' | 'delete'>
  assistantDrafts: Pick<AssistantDraftLedger, 'listPending' | 'listGrants' | 'revokeGrant'>
  assistantSubsessions: Pick<AssistantSubsessionIndex, 'list'>
  getSession(key: string): Promise<SessionRecord | undefined>
  getDisplayNames(ids: string[]): Promise<Map<string, string>>
  setDisplayName(id: string, name: string, updatedAt: number): Promise<void>
}

export interface AssistantActivityDeps {
  store(): AssistantActivityStore
  agent(agentId: string): Pick<Agent, 'assistantMode'> | undefined
  now(): number
  /** The draft decision a card click runs, entered from the console. */
  decideDraft(input: {
    agentId: string
    draftId: string
    choice: AssistantDraftChoice
    decider: { userId: string; name: string | null }
  }): Promise<DraftDecision>
}

/** The seam the CP client dispatches `assistant/activity/*` to. */
export interface AssistantActivity {
  read(req: AssistantActivityReadReq): Promise<AssistantActivityReadResult>
  write(req: AssistantActivityWriteReq): Promise<AssistantActivityWriteResult>
}

const OPEN: AssistantItemStatus[] = ['active', 'waiting']
const CLOSED: AssistantItemStatus[] = ['done', 'dropped']
// Room for the answer's own fields around its list.
const ANSWER_OVERHEAD_BYTES = 1_024

export function createAssistantActivity(deps: AssistantActivityDeps): AssistantActivity {
  // Only an agent this daemon holds, and only while it is in assistant mode: the view exists for nothing else.
  const admit = (agentId: string): void => {
    const agent = deps.agent(agentId)
    if (!agent) throw new AssistantActivityViolationError(`unknown agent "${agentId}"`, 'unknown-agent')
    if (!assistantModeOn(agent))
      throw new AssistantActivityViolationError(`agent "${agentId}" is not in assistant mode`, 'assistant-mode-off')
  }

  return {
    async read(req) {
      admit(req.agentId)
      const store = deps.store()
      switch (req.operation) {
        case 'items': {
          const rows = await store.assistantItems.list(req.agentId, {
            status: req.section === 'open' ? OPEN : CLOSED,
            limit: req.limit + 1
          })
          const { kept, trimmed } = withinBudget(rows.slice(0, req.limit).map(itemOf))
          return { operation: 'items', items: kept, truncated: rows.length > req.limit || trimmed }
        }
        case 'item': {
          const item = await store.assistantItems.get(req.agentId, req.itemId)
          if (!item) return { operation: 'item', item: null }
          const observations = item.observations
            .slice(-ASSISTANT_ACTIVITY_OBSERVATIONS_MAX)
            .reverse()
            .map((o) => ({ text: o.text, at: iso(o.at) }))
          return { operation: 'item', item: { ...itemOf(item), summary: item.summary, observations } }
        }
        case 'subsessions': {
          const rows = await store.assistantSubsessions.list(req.agentId, req.limit + 1)
          const subsessions = await Promise.all(
            rows.slice(0, req.limit).map(async (row) => {
              const child = await store.getSession(row.childSessionKey)
              return {
                sessionId: child?.agentId === req.agentId ? (child.sessionId ?? null) : null,
                parentSessionId: row.parentSessionId,
                state: row.state,
                createdAt: iso(row.createdAt)
              }
            })
          )
          return { operation: 'subsessions', subsessions, truncated: rows.length > req.limit }
        }
        case 'drafts': {
          const rows = await store.assistantDrafts.listPending(req.agentId, req.limit + 1, deps.now())
          const page = rows.slice(0, req.limit)
          const names = await store.getDisplayNames(
            page.flatMap((d) => (d.approver?.userId ? [d.approver.userId] : []))
          )
          const { kept, trimmed } = withinBudget(page.map((draft) => draftOf(draft, names)))
          return { operation: 'drafts', drafts: kept, truncated: rows.length > req.limit || trimmed }
        }
        case 'grants': {
          const rows = await store.assistantDrafts.listGrants(req.agentId, ASSISTANT_ACTIVITY_GRANTS_MAX + 1)
          const page = rows.slice(0, ASSISTANT_ACTIVITY_GRANTS_MAX)
          const names = await store.getDisplayNames(page.flatMap((g) => (g.grantedBy ? [deciderId(g.grantedBy)] : [])))
          const grants: AssistantActivityGrant[] = page.map((grant) => ({
            id: grant.id,
            source: grant.source,
            target: grant.target,
            grantedByName: grant.grantedBy ? clip(names.get(deciderId(grant.grantedBy)) ?? null) : null,
            grantedAt: iso(grant.grantedAt)
          }))
          return { operation: 'grants', grants, truncated: rows.length > ASSISTANT_ACTIVITY_GRANTS_MAX }
        }
      }
    },

    async write(req) {
      admit(req.agentId)
      const store = deps.store()
      switch (req.operation) {
        case 'delete-item':
          return { operation: 'delete-item', found: await store.assistantItems.delete(req.agentId, req.itemId) }
        case 'revoke-grant':
          return {
            operation: 'revoke-grant',
            found: await store.assistantDrafts.revokeGrant(req.agentId, req.grantId)
          }
        case 'decide-draft': {
          const { userId, name } = req.decider
          // Names the decider wherever a grant they made is listed; best effort, like every name-cache write.
          if (name) await store.setDisplayName(userId, name, deps.now()).catch(() => undefined)
          const decision = await deps.decideDraft(req)
          return { operation: 'decide-draft', ...decision, failure: clipText(decision.failure, 1_000) }
        }
      }
    }
  }
}

const iso = (ms: number): string => new Date(ms).toISOString()

const clipText = (text: string | null, max: number): string | null =>
  text === null ? null : [...text].slice(0, max).join('')

// A display name is a platform's to choose; the wire bounds it.
const clip = (name: string | null): string | null => clipText(name, 256)

const placeOf = (place: AssistantPlace): AssistantActivityPlace => ({
  platform: place.platform,
  channel: place.channel
})

/** An item as the team sees it: places, never a follower's identity. */
function itemOf(item: AssistantItemOverview): AssistantActivityItem {
  const seen = new Set<string>()
  const places: AssistantActivityPlace[] = []
  for (const follower of item.followers) {
    const key = `${follower.place.platform}\0${follower.place.channel}`
    if (seen.has(key)) continue
    seen.add(key)
    if (places.length < ASSISTANT_ACTIVITY_PLACES_MAX) places.push(placeOf(follower.place))
  }
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    doneWhen: item.doneWhen,
    nextCheck: item.nextCheck === null ? null : iso(item.nextCheck),
    origin: placeOf(item.origin),
    places,
    createdAt: iso(item.createdAt),
    updatedAt: iso(item.updatedAt)
  }
}

function draftOf(draft: AssistantDraft, names: Map<string, string>): AssistantActivityDraft {
  const approver = draft.approver
  return {
    id: draft.id,
    kind: draft.kind,
    target: {
      platform: draft.target.platform,
      integrationId: draft.target.integrationId,
      channel: draft.target.channel,
      thread: draft.target.thread,
      name: clip(draft.destination.name),
      dm: draft.targetDm,
      external: draft.targetExternal
    },
    text: draft.text,
    offerAlways: draft.offerAlways,
    approver: approver
      ? {
          kind: approver.kind,
          integrationId: approver.integrationId,
          channel: approver.channel,
          userId: approver.userId,
          consoleUserId: approver.consoleUserId,
          name: approver.userId ? clip(names.get(approver.userId) ?? null) : null
        }
      : null,
    createdAt: iso(draft.createdAt),
    expiresAt: iso(draft.expiresAt)
  }
}

/** A decider is `<workspace>:<user>` where the platform has workspaces, or `user:<id>` from the console; names are cached by the id. */
const deciderId = (by: string): string => by.slice(by.lastIndexOf(':') + 1)

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
