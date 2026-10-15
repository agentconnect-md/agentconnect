// The follow-up tools (assistant-mode.md §5.12): an assistant-mode agent takes a follow-up, and its checks record what they saw over the bridge.
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
  type AssistantItem,
  type AssistantItemLedger,
  type AssistantItemSchedule,
  type AssistantPlace
} from '../../store/assistant-items.js'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import { isPatrolCoordinate } from '../../session/subsession-coordinate.js'
import type { SessionContext, ToolHandler } from './context.js'
import { parseArgs, requiredString } from './args.js'

/** The ledger calls a check's tools make. */
export type AssistantItemLedgerPort = Pick<AssistantItemLedger, 'get' | 'appendObservation' | 'schedule'>

/** What `followUp` asks the daemon to take. */
export interface FollowUpInput {
  title: string
  doneWhen: string
  nextCheck?: number
  summary?: string
  asker: string
}

export interface AssistantItemDeps {
  assistantItems?: {
    /** The agent's follow-ups while its assistant mode is on, else undefined: checked per call, so switching it off takes effect at once. */
    ledgerFor(agentId: string): AssistantItemLedgerPort | undefined
    /** The person whose message started the session's live turn, as an asker identity; undefined when no person did. */
    askerFor(ctx: SessionContext): Promise<string | undefined>
    /** Take a follow-up of the session's place (assistant-mode.md §5.12). */
    take?(ctx: SessionContext, input: FollowUpInput): Promise<AssistantItem>
    /** A check's side, in the follow-up's own session. */
    patrol?: {
      /** The follow-up this session's check is running for; undefined once it ended. */
      itemFor(ctx: SessionContext): Promise<string | undefined>
      /** Keep the check's report; it reaches the follow-up's conversation once the check ends. False once it ended. */
      report(ctx: SessionContext, itemId: string, text: string): Promise<boolean>
      /** Ask for approval to act on the follow-up (assistant-mode.md §5.10); once per check, nothing runs here. */
      propose?(ctx: SessionContext, input: ProposeInput): Promise<Record<string, unknown>>
      now(): number
    }
  }
}

export function assistantModeOn(agent: Pick<Agent, 'assistantMode'> | undefined): boolean {
  return agent?.assistantMode?.enabled === true
}

/** The asker identity of a turn's sender (§5.12): `'user:<id>'` in webchat, `'<platform>:<tenant scope>:<uid>'` elsewhere. */
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

export const OFFSET_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i
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

export const FOLLOW_UP_ARGS = z.object({
  title: boundedString('title', ASSISTANT_ITEM_LIMITS.title),
  doneWhen: boundedString('doneWhen', ASSISTANT_ITEM_LIMITS.doneWhen),
  nextCheck: nextCheckArg,
  summary: optionalBoundedString('summary', ASSISTANT_ITEM_LIMITS.summary)
})

/** A check may not set its next check sooner than this, so a follow-up cannot wake itself in a loop. */
export const PATROL_MIN_NEXT_CHECK_MS = 5 * 60_000

/** A check's `recordCheck` (assistant-mode.md §5.12): what it saw, always, its schedule, and an optional report. */
export const RECORD_CHECK_ARGS = z.object({
  observation: boundedString('observation', ASSISTANT_ITEM_LIMITS.observation),
  report: optionalBoundedString('report', ASSISTANT_ITEM_LIMITS.observation, 1),
  nextCheck: nextCheckArg,
  done: z
    .boolean('argument done must be a boolean')
    .nullish()
    .transform((value) => value ?? undefined)
})

/** A check's `propose` (assistant-mode.md §5.10): the card's sentence, the reason, and the task an approval runs. */
export const PROPOSE_ARGS = z.object({
  sentence: boundedString('sentence', ASSISTANT_PROPOSAL_SENTENCE_MAX),
  why: boundedString('why', ASSISTANT_PROPOSAL_WHY_MAX),
  task: boundedString('task', ASSISTANT_PROPOSAL_TASK_MAX)
})
export type ProposeInput = z.infer<typeof PROPOSE_ARGS>

const NEXT_CHECK =
  'an ISO-8601 instant with an offset, e.g. `2026-10-09T09:00:00+08:00`. At that time a read-only check runs on ' +
  'its own and reports in this conversation only if something changed.'

export const FOLLOW_UP_TOOL: ToolDescriptor = {
  name: 'followUp',
  description:
    'Take on following something up for the person asking: at each next check a read-only check runs in the ' +
    'background and reports here only if something changed. It only looks and records what it saw, so promise a ' +
    'check then, never an action. First restate in your reply what you will watch, what counts as done and when ' +
    'to look next, and call this only after the person confirms. Call listTasks before restating: when an open ' +
    'follow-up of this conversation already covers the request, offer to send the change to it with sendMessage ' +
    'action `messageTask` instead of taking a second one. The follow-up belongs to this conversation: here it is ' +
    'listed with listTasks, given new instructions with messageTask and ended with stopTask, by the `taskId` this ' +
    'returns. Taken in a public channel, its title is also listed in your other internal conversations, so name it ' +
    'plainly.',
  inputSchema: obj(
    {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: ASSISTANT_ITEM_LIMITS.title,
        description: 'A short name for what is followed up.'
      },
      doneWhen: {
        type: 'string',
        minLength: 1,
        maxLength: ASSISTANT_ITEM_LIMITS.doneWhen,
        description: 'What counts as done, as the person confirmed it.'
      },
      nextCheck: {
        type: 'string',
        description: `Optional. When to check first: ${NEXT_CHECK} Without it, it waits until messaged.`
      },
      summary: {
        type: 'string',
        maxLength: ASSISTANT_ITEM_LIMITS.summary,
        description: 'Optional. Who asked for what and where it stands.'
      }
    },
    ['title', 'doneWhen']
  )
}

/** What a check records with (assistant-mode.md §5.12); offered only inside a check. */
export const RECORD_CHECK_TOOL: ToolDescriptor = {
  name: 'recordCheck',
  description:
    'Record what this check of your follow-up found. `observation` is what you checked and saw; a check that ' +
    'records nothing counts as failed, and your next check reads it if this context is lost. Then set its ' +
    'schedule: `nextCheck` to when to look again, `done: true` when its done-when holds, which ends it, or neither ' +
    'to wait until its conversation messages it. Add `report` only when something changed since the latest ' +
    'observation that the people in its conversation should know, or a message from them asked for an answer: one ' +
    'short message, which that conversation passes on. Leave it out to stay silent. When something should be ' +
    'done, use `propose` instead of a report.',
  inputSchema: obj(
    {
      observation: {
        type: 'string',
        minLength: 1,
        maxLength: ASSISTANT_ITEM_LIMITS.observation,
        description: 'What you checked and saw, quoting no one.'
      },
      report: {
        type: 'string',
        minLength: 1,
        maxLength: ASSISTANT_ITEM_LIMITS.observation,
        description:
          'Optional. What changed, for the people in its conversation; omit it when nothing did. It says what you ' +
          'found and promises no later message, no time anyone will hear back and no next check.'
      },
      nextCheck: {
        type: 'string',
        description: `Optional. At least five minutes from now: ${NEXT_CHECK} Not with \`done\`.`
      },
      done: { type: 'boolean', description: 'Optional. True when its done-when holds; this ends the follow-up.' }
    },
    ['observation']
  )
}

/** A check's third outcome (assistant-mode.md §5.10): ask for approval to act; offered only inside a check. */
export const PROPOSE_TOOL: ToolDescriptor = {
  name: 'propose',
  description:
    'Ask for approval to act on the follow-up this check is for, when something should be done rather than only ' +
    'reported. `sentence` is the one plain sentence the approver reads first ("I want to do X because Y"); `why` ' +
    'is the reason; `task` is exactly what a background session with your normal permissions should do once ' +
    'approved, e.g. "rebase PR #12 onto main and push". Nothing runs until a person approves it, within 24 hours; ' +
    'the approved proposal then reports back in the conversation the follow-up belongs to. Propose at most once ' +
    'per check and do not also report it; still record what you saw with recordCheck.',
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

/** The follow-up tools a conversation is offered: `followUp` in assistant mode, none otherwise. */
export function followUpToolsFor(agent: Pick<Agent, 'assistantMode'>): ToolDescriptor[] {
  return assistantModeOn(agent) ? [FOLLOW_UP_TOOL] : []
}

function ledgerOf(ctx: SessionContext, deps: AssistantItemDeps): AssistantItemLedgerPort {
  const ledger = deps.assistantItems?.ledgerFor(ctx.agentId)
  if (!ledger) throw new Error('follow-ups are available only to an agent in assistant mode')
  return ledger
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

export const followUp: ToolHandler<AssistantItemDeps> = async (ctx, args, deps) => {
  const input = parseArgs(FOLLOW_UP_ARGS, args)
  ledgerOf(ctx, deps)
  const take = deps.assistantItems?.take
  if (!take) throw new Error('followUp: taking a follow-up is not available on this daemon')
  const asker = await deps.assistantItems?.askerFor(ctx)
  if (!asker) throw new Error("followUp needs a person's request: this turn was not started by a person's message")
  const item = await take(ctx, {
    title: input.title,
    doneWhen: input.doneWhen,
    ...(input.nextCheck !== undefined ? { nextCheck: input.nextCheck } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    asker
  })
  return {
    taskId: item.taskKey,
    followUp: {
      title: item.title,
      doneWhen: item.doneWhen,
      nextCheck: iso(item.nextCheck),
      summary: item.summary
    },
    note:
      item.nextCheck === null
        ? 'Taken. It runs no check until you message it with messageTask and this taskId.'
        : 'Taken. Its first check runs at nextCheck; listTasks shows it, messageTask changes it, stopTask ends it.'
  }
}

/** A check's write (assistant-mode.md §5.12): what it saw on its own follow-up, the schedule, and a report kept for its end. */
export const recordCheck: ToolHandler<AssistantItemDeps> = async (ctx, args, deps) => {
  if (!isPatrolCoordinate(ctx.thread)) throw new Error('recordCheck is available only in a follow-up’s check')
  const input = parseArgs(RECORD_CHECK_ARGS, args)
  const ledger = ledgerOf(ctx, deps)
  const patrol = deps.assistantItems?.patrol
  const itemId = patrol ? await patrol.itemFor(ctx) : undefined
  if (!patrol || itemId === undefined) throw new Error('this check has ended; nothing was written')
  if (input.done === true && input.nextCheck !== undefined)
    throw new Error('recordCheck takes `done` or `nextCheck`, not both; nothing was written')
  if (input.nextCheck !== undefined && input.nextCheck < patrol.now() + PATROL_MIN_NEXT_CHECK_MS)
    throw new Error('nextCheck must be at least five minutes from now; nothing was written')
  const next: AssistantItemSchedule =
    input.done === true
      ? { status: 'done', nextCheck: null }
      : input.nextCheck !== undefined
        ? { status: 'active', nextCheck: input.nextCheck }
        : { status: 'waiting', nextCheck: null }
  const appended = await ledger.appendObservation(ctx.agentId, itemId, { text: input.observation, author: 'check' })
  if (!appended) throw new Error('this follow-up is gone; nothing was written')
  // One its conversation ended while this check ran stays ended; what the check saw is still recorded.
  const open = await ledger.schedule(ctx.agentId, itemId, next)
  if (input.report !== undefined && !(await patrol.report(ctx, itemId, input.report)))
    throw new Error('this check has ended; the observation was written but the report was not kept')
  return {
    ok: true,
    followUp: open
      ? { state: next.status === 'done' ? 'done' : 'waiting', nextCheck: iso(next.nextCheck) }
      : { state: 'ended', nextCheck: null },
    ...(input.report !== undefined ? { report: 'passed on when this check ends' } : {})
  }
}

/** A check asks for approval to act (assistant-mode.md §5.10); no other session may, and it runs nothing itself. */
export const propose: ToolHandler<AssistantItemDeps> = async (ctx, args, deps) => {
  if (!isPatrolCoordinate(ctx.thread)) throw new Error('propose is available only in a follow-up’s check')
  const input = parseArgs(PROPOSE_ARGS, args)
  ledgerOf(ctx, deps)
  const patrol = deps.assistantItems?.patrol
  if (!patrol?.propose) throw new Error('this check has ended; nothing was proposed')
  return await patrol.propose(ctx, input)
}

/** Registry entries for `ops.ts`, kept here so the shared registry grows by one spread. */
export const ASSISTANT_ITEM_HANDLERS: [string, ToolHandler<AssistantItemDeps>][] = [
  ['followUp', followUp],
  ['recordCheck', recordCheck],
  ['propose', propose]
]

export const ASSISTANT_ITEM_ARG_SCHEMAS: [string, z.ZodType][] = [
  ['followUp', FOLLOW_UP_ARGS],
  ['recordCheck', RECORD_CHECK_ARGS],
  ['propose', PROPOSE_ARGS]
]
