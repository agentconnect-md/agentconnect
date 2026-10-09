// The assistant item tools (assistant-mode.md §1.2, §5.4): an assistant-mode agent's ledger, read and written over the bridge.
import { z } from 'zod'
import {
  ASSISTANT_PROPOSAL_SENTENCE_MAX,
  ASSISTANT_PROPOSAL_TASK_MAX,
  ASSISTANT_PROPOSAL_WHY_MAX
} from '@agentconnect.md/protocol'
import type { Agent } from '../../agents/agent-schema.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import {
  ASSISTANT_ITEM_LIMITS,
  ASSISTANT_ITEM_LIST_MAX,
  ASSISTANT_ITEM_STATUSES,
  type AssistantItem,
  type AssistantItemLedger,
  type AssistantItemOverview,
  type AssistantItemPatch,
  type AssistantPlace
} from '../../store/assistant-items.js'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import { isPatrolCoordinate } from '../../session/subsession-coordinate.js'
import type { SessionContext, ToolHandler } from './context.js'
import { optionalPositiveInt, parseArgs, requiredString } from './args.js'

/** The ledger calls the tools make. */
export type AssistantItemLedgerPort = Pick<
  AssistantItemLedger,
  'create' | 'get' | 'list' | 'attachFollower' | 'appendObservation' | 'transition'
>

export interface AssistantItemDeps {
  assistantItems?: {
    /** The agent's ledger while its assistant mode is on, else undefined: checked per call, so switching it off takes effect at once. */
    ledgerFor(agentId: string): AssistantItemLedgerPort | undefined
    /** The person whose message started the session's live turn, as a follower identity; undefined when no person did. */
    askerFor(ctx: SessionContext): Promise<string | undefined>
    /** A patrol session's side (assistant-mode.md §5.9). */
    patrol?: {
      /** The item the patrol in this session checks; undefined once it ended. */
      itemFor(ctx: SessionContext): Promise<string | undefined>
      /** Keep the patrol's report; it reaches the conversation the item was taken in once the patrol ends. False once it ended. */
      report(ctx: SessionContext, itemId: string, text: string): Promise<boolean>
      /** Ask for approval to act on the patrol's item (assistant-mode.md §5.10); once per patrol, nothing runs here. */
      propose?(ctx: SessionContext, input: ProposeInput): Promise<Record<string, unknown>>
      now(): number
    }
  }
}

const ASSISTANT_ITEM_OPEN_STATUSES = ['active', 'waiting'] as const

export function assistantModeOn(agent: Pick<Agent, 'assistantMode'> | undefined): boolean {
  return agent?.assistantMode?.enabled === true
}

/** The follower identity of a turn's sender (§5.4): `'user:<id>'` in webchat, `'<platform>:<tenant scope>:<uid>'` elsewhere. */
export function askerIdentity(msg: NormalizedMessage, tenantScope: string | undefined): string | undefined {
  if (msg.source !== 'user' || msg.sender.isBot) return undefined
  const uid = msg.sender.id
  if (!uid || /[\s:]/.test(uid)) return undefined
  if (msg.platform === 'webchat') return `user:${uid}`
  return tenantScope && !/\s/.test(tenantScope) ? `${msg.platform}:${tenantScope}:${uid}` : undefined
}

/** The place a session belongs to (§5.2): its conversation, never a thread inside it. */
export function placeOfSession(ctx: Pick<SessionContext, 'platform' | 'channel' | 'transportScope'>): AssistantPlace {
  return { platform: ctx.platform, channel: ctx.channel, transportScope: ctx.transportScope ?? null }
}

const OFFSET_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i
const INSTANT_MESSAGE = 'argument nextCheck must be an ISO-8601 instant with an offset, e.g. 2026-10-09T09:00:00+08:00'

const boundedString = (key: string, max: number) =>
  requiredString(key).max(max, `argument ${key} must be at most ${max} characters`)
const optionalBoundedString = (key: string, max: number, min = 0) =>
  z
    .string(`argument ${key} must be a string`)
    .min(min, `argument ${key} must not be empty`)
    .max(max, `argument ${key} must be at most ${max} characters`)
    .nullish()
    .transform((value) => value ?? undefined)
const nextCheckArg = z
  .string(INSTANT_MESSAGE)
  .refine((value) => OFFSET_INSTANT.test(value) && !Number.isNaN(Date.parse(value)), INSTANT_MESSAGE)
  .nullish()
  .transform((value) => (value == null ? undefined : Date.parse(value)))
const statusArg = z.enum(
  ASSISTANT_ITEM_STATUSES,
  `argument status must be one of: ${ASSISTANT_ITEM_STATUSES.join(', ')}`
)

export const TAKE_ITEM_ARGS = z.object({
  title: boundedString('title', ASSISTANT_ITEM_LIMITS.title),
  doneWhen: boundedString('doneWhen', ASSISTANT_ITEM_LIMITS.doneWhen),
  nextCheck: nextCheckArg,
  summary: optionalBoundedString('summary', ASSISTANT_ITEM_LIMITS.summary)
})

export const LIST_ITEMS_ARGS = z.object({
  status: z
    .array(statusArg, 'argument status must be an array of statuses')
    .min(1, 'argument status must name at least one status')
    .nullish()
    .transform((value) => value ?? undefined),
  itemId: optionalBoundedString('itemId', ASSISTANT_ITEM_LIMITS.refId, 1),
  limit: optionalPositiveInt('limit').refine(
    (value) => value === undefined || value <= ASSISTANT_ITEM_LIST_MAX,
    `argument limit must be at most ${ASSISTANT_ITEM_LIST_MAX}`
  )
})

export const UPDATE_ITEM_ARGS = z.object({
  itemId: boundedString('itemId', ASSISTANT_ITEM_LIMITS.refId),
  version: optionalPositiveInt('version'),
  status: statusArg.nullish().transform((value) => value ?? undefined),
  nextCheck: nextCheckArg,
  title: optionalBoundedString('title', ASSISTANT_ITEM_LIMITS.title, 1),
  doneWhen: optionalBoundedString('doneWhen', ASSISTANT_ITEM_LIMITS.doneWhen, 1),
  summary: optionalBoundedString('summary', ASSISTANT_ITEM_LIMITS.summary),
  observation: optionalBoundedString('observation', ASSISTANT_ITEM_LIMITS.observation, 1)
})

export const FOLLOW_ITEM_ARGS = z.object({ itemId: boundedString('itemId', ASSISTANT_ITEM_LIMITS.refId) })

/** A patrol may not set its next check sooner than this, so a patrol cannot wake itself in a loop. */
export const PATROL_MIN_NEXT_CHECK_MS = 5 * 60_000
const PATROL_STATUSES = ['active', 'waiting', 'done'] as const

/** A patrol's `updateItem` (assistant-mode.md §5.9): its own item only, always with an observation, and an optional report. */
export const PATROL_UPDATE_ITEM_ARGS = z.object({
  itemId: boundedString('itemId', ASSISTANT_ITEM_LIMITS.refId),
  version: optionalPositiveInt('version'),
  status: z
    .enum(PATROL_STATUSES, `argument status must be one of: ${PATROL_STATUSES.join(', ')}`)
    .nullish()
    .transform((value) => value ?? undefined),
  nextCheck: nextCheckArg,
  summary: optionalBoundedString('summary', ASSISTANT_ITEM_LIMITS.summary),
  observation: boundedString('observation', ASSISTANT_ITEM_LIMITS.observation),
  report: optionalBoundedString('report', ASSISTANT_ITEM_LIMITS.observation, 1)
})

/** A patrol's `propose` (assistant-mode.md §5.10): the card's sentence, the reason, and the task an approval runs. */
export const PROPOSE_ARGS = z.object({
  sentence: boundedString('sentence', ASSISTANT_PROPOSAL_SENTENCE_MAX),
  why: boundedString('why', ASSISTANT_PROPOSAL_WHY_MAX),
  task: boundedString('task', ASSISTANT_PROPOSAL_TASK_MAX)
})
export type ProposeInput = z.infer<typeof PROPOSE_ARGS>

const TEAM_VISIBLE =
  'The ledger is visible to everyone in the organization: write it as a neutral record of who asked for what and ' +
  'where it stands, and never quote or paraphrase a direct message.'

const nextCheckProp = {
  type: 'string',
  description:
    'When it should be checked on next: an ISO-8601 instant with an offset, e.g. `2026-10-09T09:00:00+08:00`. ' +
    'At that time a read-only check of the item runs on its own; it reports in the conversation the item was taken ' +
    'in only if something changed.'
}
const itemIdProp = { type: 'string', minLength: 1, description: 'The item id from listItems or the standing list.' }

export const ASSISTANT_ITEM_TOOLS: ToolDescriptor[] = [
  {
    name: 'takeItem',
    description:
      'Put work someone asked of you into your item ledger, so you follow it until it is done and report to them ' +
      'here. First restate in your reply what you will do, what counts as done and when it should be checked next, ' +
      'and call this only after the person confirms. A next check schedules a read-only check of the item at that ' +
      'time, which reports here only if something changed; it only looks and records what it saw, so promise a ' +
      'check then, never an action. Check listItems before restating: when an open item already covers the ' +
      'request, ask "attach this to <who>’s item?" instead and, on a yes, call followItem rather than ' +
      `taking a second item. ${TEAM_VISIBLE} When the request came in a direct message, say so as you take it. The ` +
      'person asking and this conversation become the first follower.',
    inputSchema: obj(
      {
        title: {
          type: 'string',
          minLength: 1,
          maxLength: ASSISTANT_ITEM_LIMITS.title,
          description: 'A short name for the work.'
        },
        doneWhen: {
          type: 'string',
          minLength: 1,
          maxLength: ASSISTANT_ITEM_LIMITS.doneWhen,
          description: 'What counts as done, as the person confirmed it.'
        },
        nextCheck: { ...nextCheckProp, description: `Optional. ${nextCheckProp.description}` },
        summary: {
          type: 'string',
          maxLength: ASSISTANT_ITEM_LIMITS.summary,
          description: 'Optional. Who asked for what and where it stands.'
        }
      },
      ['title', 'doneWhen']
    )
  },
  {
    name: 'listItems',
    description:
      'Read your item ledger: by default the active and waiting items, most recently updated first, each with its ' +
      'id, title, status, done-when, next check, summary, version and followers with the place each follows from ' +
      '(`here` marks this conversation). Pass `itemId` to read one item with its recent observations. Use it before ' +
      'taking an item, to find one that already covers the request, and when asked what you are working on.',
    inputSchema: obj({
      status: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', enum: [...ASSISTANT_ITEM_STATUSES] },
        description: 'Optional. The statuses to list; defaults to active and waiting.'
      },
      itemId: { ...itemIdProp, description: 'Optional. Read this one item, with its recent observations.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: ASSISTANT_ITEM_LIST_MAX,
        description: 'Optional. At most this many items (default 50).'
      }
    })
  },
  {
    name: 'updateItem',
    description:
      'Change an item in your ledger. A new status, nextCheck, title, doneWhen or summary is written only with the ' +
      'item’s current `version` (from listItems or your last call); if the item changed since, nothing is written ' +
      'and the current item comes back, so reconcile and retry with its version. A new nextCheck schedules the next ' +
      'read-only check of the item, which reports in the conversation the item was taken in only if something ' +
      'changed. `observation` appends what you checked and saw, with or without a version. Mark the item `done` ' +
      'when its done-when holds and `dropped` when ' +
      'the asker withdraws it, and tell its followers; closing an item clears its next check. When followers want ' +
      `conflicting things, say so in this conversation and record the conflict in the summary. ${TEAM_VISIBLE}`,
    inputSchema: obj(
      {
        itemId: itemIdProp,
        version: {
          type: 'integer',
          minimum: 1,
          description: 'The item’s current version; required with any field other than `observation`.'
        },
        status: { type: 'string', enum: [...ASSISTANT_ITEM_STATUSES], description: 'Optional. The new status.' },
        nextCheck: { ...nextCheckProp, description: `Optional. ${nextCheckProp.description}` },
        title: { type: 'string', minLength: 1, maxLength: ASSISTANT_ITEM_LIMITS.title, description: 'Optional.' },
        doneWhen: {
          type: 'string',
          minLength: 1,
          maxLength: ASSISTANT_ITEM_LIMITS.doneWhen,
          description: 'Optional.'
        },
        summary: {
          type: 'string',
          maxLength: ASSISTANT_ITEM_LIMITS.summary,
          description: 'Optional. Replaces the summary.'
        },
        observation: {
          type: 'string',
          minLength: 1,
          maxLength: ASSISTANT_ITEM_LIMITS.observation,
          description: 'Optional. What you checked and saw, appended to the item’s history.'
        }
      },
      ['itemId']
    )
  },
  {
    name: 'followItem',
    description:
      'Attach the person asking and this conversation to an existing item, so they get its reports here too. Call ' +
      'it only after they confirm "attach this to <who>’s item?"; calling it again changes nothing.',
    inputSchema: obj({ itemId: itemIdProp }, ['itemId'])
  }
]

/** What a patrol records with in place of `updateItem` (assistant-mode.md §5.9); the same name, its own item only. */
export const PATROL_UPDATE_ITEM_TOOL: ToolDescriptor = {
  name: 'updateItem',
  description:
    'Record what this patrol checked on the item it was started for. `observation` is what you checked and saw. ' +
    'With the item’s current `version`, also set `nextCheck` to when it should be checked again, or `status` to ' +
    '`waiting` or `done` when that is what you found; `summary` replaces the summary. If the item changed since that ' +
    'version, nothing is written and the current item comes back. Add `report` only when something changed since the ' +
    'last observation that the people following the item should know: one short message, which the conversation ' +
    'the item was taken in passes on. Leave it out to stay silent. When something should be done, use `propose` ' +
    `instead of a report. ${TEAM_VISIBLE}`,
  inputSchema: obj(
    {
      itemId: { ...itemIdProp, description: 'The item this patrol was started for.' },
      version: {
        type: 'integer',
        minimum: 1,
        description: 'The item’s current version; required with status, nextCheck or summary.'
      },
      status: { type: 'string', enum: [...PATROL_STATUSES], description: 'Optional. The new status.' },
      nextCheck: {
        ...nextCheckProp,
        description: `Optional. At least five minutes from now. ${nextCheckProp.description}`
      },
      summary: {
        type: 'string',
        maxLength: ASSISTANT_ITEM_LIMITS.summary,
        description: 'Optional. Replaces the summary.'
      },
      observation: {
        type: 'string',
        minLength: 1,
        maxLength: ASSISTANT_ITEM_LIMITS.observation,
        description: 'What you checked and saw, appended to the item’s history.'
      },
      report: {
        type: 'string',
        minLength: 1,
        maxLength: ASSISTANT_ITEM_LIMITS.observation,
        description: 'Optional. What changed, for the people following the item; omit it when nothing did.'
      }
    },
    ['itemId', 'observation']
  )
}

/** A patrol's third outcome (assistant-mode.md §5.10): ask for approval to act; offered to patrols only. */
export const PROPOSE_TOOL: ToolDescriptor = {
  name: 'propose',
  description:
    'Ask for approval to act on the item this patrol checks, when something should be done rather than only ' +
    'reported. `sentence` is the one plain sentence the approver reads first ("I want to do X because Y"); `why` ' +
    'is the reason; `task` is exactly what a background session with your normal permissions should do once ' +
    'approved, e.g. "rebase PR #12 onto main and push". Nothing runs until a person approves it, within 24 hours; ' +
    'the approved task then reports back in the conversation the item was taken in. Propose at most once per patrol ' +
    'and do not also report it; still record what you saw with updateItem.',
  inputSchema: obj(
    {
      sentence: {
        type: 'string',
        minLength: 1,
        maxLength: ASSISTANT_PROPOSAL_SENTENCE_MAX,
        description: 'One plain sentence: "I want to do X because Y".'
      },
      why: {
        type: 'string',
        minLength: 1,
        maxLength: ASSISTANT_PROPOSAL_WHY_MAX,
        description: 'Why it should be done, from what this check found.'
      },
      task: {
        type: 'string',
        minLength: 1,
        maxLength: ASSISTANT_PROPOSAL_TASK_MAX,
        description: 'What the approved background session does, specific enough to carry out without asking.'
      }
    },
    ['sentence', 'why', 'task']
  )
}

/** The item tools an agent's sessions are offered: all of them in assistant mode, none otherwise. */
export function assistantItemToolsFor(agent: Pick<Agent, 'assistantMode'>): ToolDescriptor[] {
  return assistantModeOn(agent) ? ASSISTANT_ITEM_TOOLS : []
}

function ledgerOf(ctx: SessionContext, deps: AssistantItemDeps): AssistantItemLedgerPort {
  const ledger = deps.assistantItems?.ledgerFor(ctx.agentId)
  if (!ledger) throw new Error('item tools are available only to an agent in assistant mode')
  return ledger
}

async function askerOf(ctx: SessionContext, deps: AssistantItemDeps, tool: string): Promise<string> {
  const asker = await deps.assistantItems?.askerFor(ctx)
  if (!asker) throw new Error(`${tool} needs a person's request: this turn was not started by a person's message`)
  return asker
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

const samePlace = (a: AssistantPlace, b: AssistantPlace): boolean =>
  a.platform === b.platform && a.channel === b.channel && (a.transportScope ?? null) === (b.transportScope ?? null)

/** What the model reads of an item: places without the opaque transport scope, times as ISO instants. */
function itemView(item: AssistantItemOverview | AssistantItem, here: AssistantPlace) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    doneWhen: item.doneWhen,
    nextCheck: iso(item.nextCheck),
    summary: item.summary,
    origin: { platform: item.origin.platform, channel: item.origin.channel },
    followers: item.followers.map((follower) => ({
      identity: follower.identity,
      place: { platform: follower.place.platform, channel: follower.place.channel },
      ...(samePlace(follower.place, here) ? { here: true } : {})
    })),
    version: item.version,
    updatedAt: iso(item.updatedAt),
    ...('observations' in item
      ? { observations: item.observations.map((o) => ({ text: o.text, author: o.author, at: iso(o.at) })) }
      : {})
  }
}

export const takeItem: ToolHandler<AssistantItemDeps> = async (ctx, args, deps) => {
  const input = parseArgs(TAKE_ITEM_ARGS, args)
  const ledger = ledgerOf(ctx, deps)
  const asker = await askerOf(ctx, deps, 'takeItem')
  const origin = placeOfSession(ctx)
  const item = await ledger.create({
    agentId: ctx.agentId,
    title: input.title,
    doneWhen: input.doneWhen,
    ...(input.nextCheck !== undefined ? { nextCheck: input.nextCheck } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    origin,
    followers: [{ identity: asker, place: origin }]
  })
  return { item: itemView(item, origin) }
}

export const listItems: ToolHandler<AssistantItemDeps> = async (ctx, args, deps) => {
  const input = parseArgs(LIST_ITEMS_ARGS, args)
  const ledger = ledgerOf(ctx, deps)
  const here = placeOfSession(ctx)
  if (input.itemId !== undefined) {
    const item = await ledger.get(ctx.agentId, input.itemId)
    if (!item) throw new Error(`no item ${input.itemId} in your ledger`)
    return { items: [itemView(item, here)] }
  }
  const limit = input.limit ?? 50
  const items = await ledger.list(ctx.agentId, {
    status: input.status ?? [...ASSISTANT_ITEM_OPEN_STATUSES],
    limit: limit + 1
  })
  return {
    items: items.slice(0, limit).map((item) => itemView(item, here)),
    ...(items.length > limit ? { more: true } : {})
  }
}

export const updateItem: ToolHandler<AssistantItemDeps> = async (ctx, args, deps) => {
  if (isPatrolCoordinate(ctx.thread)) return await patrolUpdateItem(ctx, args, deps)
  const input = parseArgs(UPDATE_ITEM_ARGS, args)
  const ledger = ledgerOf(ctx, deps)
  const here = placeOfSession(ctx)
  const patch: AssistantItemPatch = {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.nextCheck !== undefined ? { nextCheck: input.nextCheck } : {}),
    ...(input.status === 'done' || input.status === 'dropped' ? { nextCheck: null } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.doneWhen !== undefined ? { doneWhen: input.doneWhen } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {})
  }
  const transitions = Object.keys(patch).length > 0
  if (!transitions && input.observation === undefined)
    throw new Error('updateItem needs a change: status, nextCheck, title, doneWhen, summary or observation')
  if (transitions && input.version === undefined)
    throw new Error('updateItem needs the item’s current version to change anything but an observation')
  if (transitions) {
    const result = await ledger.transition(ctx.agentId, input.itemId, input.version!, patch)
    if (!result.ok && result.reason === 'not_found') throw new Error(`no item ${input.itemId} in your ledger`)
    if (!result.ok)
      return {
        ok: false,
        reason: 'conflict',
        message:
          `The item changed since version ${input.version}; nothing was written` +
          (input.observation !== undefined ? ', including the observation' : '') +
          `. Reconcile with the current item and retry with version ${result.current.version}.`,
        current: itemView(result.current, here)
      }
  }
  if (input.observation !== undefined) {
    const asker = await deps.assistantItems?.askerFor(ctx)
    const appended = await ledger.appendObservation(ctx.agentId, input.itemId, {
      text: input.observation,
      ...(asker ? { author: asker } : {})
    })
    if (!appended) throw new Error(`no item ${input.itemId} in your ledger`)
  }
  const item = await ledger.get(ctx.agentId, input.itemId)
  if (!item) throw new Error(`no item ${input.itemId} in your ledger`)
  return { ok: true, item: itemView(item, here) }
}

/** A patrol's write (assistant-mode.md §5.9): what it saw on its own item, the next check, and a report kept for its end. */
async function patrolUpdateItem(ctx: SessionContext, args: Record<string, unknown>, deps: AssistantItemDeps) {
  const input = parseArgs(PATROL_UPDATE_ITEM_ARGS, args)
  const ledger = ledgerOf(ctx, deps)
  const patrol = deps.assistantItems?.patrol
  const itemId = patrol ? await patrol.itemFor(ctx) : undefined
  if (!patrol || itemId === undefined) throw new Error('this patrol has ended; nothing was written')
  if (input.itemId !== itemId) throw new Error(`this patrol checks item ${itemId} only; nothing was written`)
  if (input.nextCheck !== undefined && input.nextCheck < patrol.now() + PATROL_MIN_NEXT_CHECK_MS)
    throw new Error('nextCheck must be at least five minutes from now; nothing was written')
  const here = placeOfSession(ctx)
  const patch: AssistantItemPatch = {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.nextCheck !== undefined ? { nextCheck: input.nextCheck } : {}),
    ...(input.status === 'done' ? { nextCheck: null } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {})
  }
  const transitions = Object.keys(patch).length > 0
  if (transitions && input.version === undefined)
    throw new Error('updateItem needs the item’s current version to change status, nextCheck or summary')
  if (transitions) {
    const result = await ledger.transition(ctx.agentId, itemId, input.version!, patch)
    if (!result.ok && result.reason === 'not_found') throw new Error(`no item ${itemId} in your ledger`)
    if (!result.ok)
      return {
        ok: false,
        reason: 'conflict',
        message:
          `The item changed since version ${input.version}; nothing was written, including the observation. ` +
          `Reconcile with the current item and retry with version ${result.current.version}.`,
        current: itemView(result.current, here)
      }
  }
  const appended = await ledger.appendObservation(ctx.agentId, itemId, { text: input.observation, author: 'patrol' })
  if (!appended) throw new Error(`no item ${itemId} in your ledger`)
  if (input.report !== undefined && !(await patrol.report(ctx, itemId, input.report)))
    throw new Error('this patrol has ended; the observation was written but the report was not kept')
  const item = await ledger.get(ctx.agentId, itemId)
  if (!item) throw new Error(`no item ${itemId} in your ledger`)
  return {
    ok: true,
    item: itemView(item, here),
    ...(input.report !== undefined ? { report: 'passed on when this patrol ends' } : {})
  }
}

/** A patrol asks for approval to act (assistant-mode.md §5.10); no other session may, and it runs nothing itself. */
export const propose: ToolHandler<AssistantItemDeps> = async (ctx, args, deps) => {
  if (!isPatrolCoordinate(ctx.thread)) throw new Error('propose is available only in a patrol')
  const input = parseArgs(PROPOSE_ARGS, args)
  ledgerOf(ctx, deps)
  const patrol = deps.assistantItems?.patrol
  if (!patrol?.propose) throw new Error('this patrol has ended; nothing was proposed')
  return await patrol.propose(ctx, input)
}

export const followItem: ToolHandler<AssistantItemDeps> = async (ctx, args, deps) => {
  const { itemId } = parseArgs(FOLLOW_ITEM_ARGS, args)
  const ledger = ledgerOf(ctx, deps)
  const asker = await askerOf(ctx, deps, 'followItem')
  const here = placeOfSession(ctx)
  const attached = await ledger.attachFollower(ctx.agentId, itemId, { identity: asker, place: here })
  if (!attached) throw new Error(`no item ${itemId} in your ledger`)
  const item = await ledger.get(ctx.agentId, itemId)
  if (!item) throw new Error(`no item ${itemId} in your ledger`)
  return { added: attached.added, item: itemView(item, here) }
}

/** Registry entries for `ops.ts`, kept here so the shared registry grows by one spread. */
export const ASSISTANT_ITEM_HANDLERS: [string, ToolHandler<AssistantItemDeps>][] = [
  ['takeItem', takeItem],
  ['listItems', listItems],
  ['updateItem', updateItem],
  ['followItem', followItem],
  ['propose', propose]
]

export const ASSISTANT_ITEM_ARG_SCHEMAS: [string, z.ZodType][] = [
  ['takeItem', TAKE_ITEM_ARGS],
  ['listItems', LIST_ITEMS_ARGS],
  ['updateItem', UPDATE_ITEM_ARGS],
  ['followItem', FOLLOW_ITEM_ARGS],
  ['propose', PROPOSE_ARGS]
]
