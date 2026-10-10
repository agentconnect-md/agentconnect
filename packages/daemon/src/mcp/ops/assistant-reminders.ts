// The assistant reminder tools (assistant-mode.md §5.9): text the daemon posts into this conversation at a set time, with no model turn.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Agent } from '../../agents/agent-schema.js'
import { isSubsessionCoordinate } from '../../session/subsession-coordinate.js'
import { ASSISTANT_DRAFT_TEXT_MAX } from '../../store/assistant-drafts.js'
import {
  ASSISTANT_REMINDER_HORIZON_MS,
  ASSISTANT_REMINDER_PENDING_MAX,
  type AssistantReminder,
  type AssistantReminderLedger
} from '../../store/assistant-reminders.js'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import { parseArgs, requiredString } from './args.js'
import { assistantModeOn, OFFSET_INSTANT, placeOfSession } from './assistant-items.js'
import type { SessionContext, ToolHandler } from './context.js'
import type { PlaceAccessDeps } from './place-gate.js'
import type { ShareFileDeps } from './share-file.js'

/** The ledger calls the tools make. */
export type AssistantReminderLedgerPort = Pick<AssistantReminderLedger, 'create' | 'listOpen' | 'cancel'>

export interface AssistantReminderDeps
  extends Pick<ShareFileDeps, 'shareTarget'>, Pick<PlaceAccessDeps, 'placeExternal'> {
  assistantReminders?: {
    /** The agent's reminders while its assistant mode is on, else undefined: checked per call. */
    ledgerFor(agentId: string): AssistantReminderLedgerPort | undefined
    /** The platform user whose message started the live turn; undefined when no person did. */
    requesterFor(ctx: SessionContext): Promise<string | undefined>
    now(): number
  }
}

const AT_MESSAGE = 'argument at must be an ISO-8601 instant with an offset, e.g. 2026-10-09T09:00:00+08:00'

export const REMIND_ARGS = z.object({
  at: z
    .string(AT_MESSAGE)
    .refine((value) => OFFSET_INSTANT.test(value) && !Number.isNaN(Date.parse(value)), AT_MESSAGE)
    .transform((value) => Date.parse(value)),
  message: requiredString('message')
    .max(ASSISTANT_DRAFT_TEXT_MAX, `argument message must be at most ${ASSISTANT_DRAFT_TEXT_MAX} characters`)
    .refine((value) => value.trim() !== '', 'argument message must not be empty')
})

export const LIST_REMINDERS_ARGS = z.object({})

export const CANCEL_REMINDER_ARGS = z.object({
  id: requiredString('id').max(256, 'argument id must be at most 256 characters')
})

export const ASSISTANT_REMINDER_TOOLS: ToolDescriptor[] = [
  {
    name: 'remind',
    description:
      'Set a reminder in this conversation. At `at` the daemon posts `message` here exactly as written, where your ' +
      'replies here land, with no model turn: you are not woken, the text is not rephrased, and nothing follows it. ' +
      'It posts into this conversation only, never anywhere else. Use it for fixed text at a set time ("remind me at ' +
      '9 to send the report"); for something to be checked on at a time, take an item with a next check instead. ' +
      'Say the time and the exact text in your reply. It posts within about a minute of `at`; while the agent is ' +
      'paused nothing is posted, and a reminder more than 24 hours late is dropped. Not available in a conversation ' +
      'shared with another organization.',
    inputSchema: obj(
      {
        at: {
          type: 'string',
          description:
            'When to post: an ISO-8601 instant with an offset, e.g. `2026-10-09T09:00:00+08:00`; in the future and ' +
            'at most 366 days ahead.'
        },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: ASSISTANT_DRAFT_TEXT_MAX,
          description: 'The exact text to post, as the people here should read it.'
        }
      },
      ['at', 'message']
    )
  },
  {
    name: 'listReminders',
    description:
      'List the reminders set in this conversation that have not been posted yet, soonest first, each with its id, ' +
      'time and exact text. Reminders set in other conversations are not shown.',
    inputSchema: obj({})
  },
  {
    name: 'cancelReminder',
    description:
      'Cancel a reminder set in this conversation that has not been posted yet, by its id from remind or ' +
      'listReminders. A reminder set in another conversation cannot be cancelled here.',
    inputSchema: obj({ id: { type: 'string', minLength: 1, description: 'The reminder id.' } }, ['id'])
  }
]

/** The reminder tools a session is offered: in assistant mode, in a platform conversation of its own, never a background session. */
export function assistantReminderToolsFor(
  agent: Pick<Agent, 'assistantMode'>,
  session: { thread: string; integrationId?: string | undefined }
): ToolDescriptor[] {
  if (!assistantModeOn(agent) || session.integrationId === undefined || isSubsessionCoordinate(session.thread))
    return []
  return ASSISTANT_REMINDER_TOOLS
}

function ledgerOf(ctx: SessionContext, deps: AssistantReminderDeps): AssistantReminderLedgerPort {
  const ledger = deps.assistantReminders?.ledgerFor(ctx.agentId)
  if (!ledger) throw new Error('reminders are available only to an agent in assistant mode')
  return ledger
}

const BACKGROUND = 'this is a background session with no conversation of its own'

const iso = (ms: number): string => new Date(ms).toISOString()

/** What the model reads of a reminder. */
const view = (reminder: AssistantReminder) => ({
  id: reminder.id,
  at: iso(reminder.dueAt),
  message: reminder.message,
  status: reminder.status
})

/** Where this session's replies land: the conversation a reminder posts into, or why there is none. */
function conversationOf(ctx: SessionContext, deps: AssistantReminderDeps) {
  if (isSubsessionCoordinate(ctx.thread)) throw new Error(`remind: ${BACKGROUND}. Nothing was set.`)
  const target = deps.shareTarget?.(ctx)
  if (!target) throw new Error('remind is not available in this environment. Nothing was set.')
  if (!target.ok) {
    throw new Error(
      target.reason === 'headless'
        ? 'remind: this turn posts nothing visible, so it has no conversation to remind. Nothing was set.'
        : 'remind: this session has no conversation of its own to post into. Nothing was set.'
    )
  }
  const integrationId = target.integrationId ?? ctx.integrationId
  // Only the session's own conversation, reached through its own bot; webchat has no post path without a turn.
  if (target.platform !== ctx.platform || target.channel !== ctx.channel || integrationId === undefined) {
    throw new Error(
      'remind: reminders post through a chat platform, and this conversation has none the daemon can post to on ' +
        'its own (webchat is not supported yet). Nothing was set.'
    )
  }
  if (deps.placeExternal?.(ctx)) {
    throw new Error(
      'remind: this conversation is shared with another organization, where every post needs an internal ' +
        "member's approval, so reminders cannot be set here. Nothing was set."
    )
  }
  return { integrationId, thread: target.thread ?? null }
}

export const remind: ToolHandler<AssistantReminderDeps> = async (ctx, args, deps) => {
  const input = parseArgs(REMIND_ARGS, args)
  const ledger = ledgerOf(ctx, deps)
  const target = conversationOf(ctx, deps)
  const now = deps.assistantReminders!.now()
  if (input.at <= now) throw new Error('remind: argument at must be in the future. Nothing was set.')
  if (input.at > now + ASSISTANT_REMINDER_HORIZON_MS)
    throw new Error('remind: argument at must be at most 366 days from now. Nothing was set.')
  const created = await ledger.create({
    id: randomUUID(),
    agentId: ctx.agentId,
    place: placeOfSession(ctx),
    integrationId: target.integrationId,
    thread: ctx.thread,
    targetThread: target.thread,
    targetDm: ctx.isDm,
    message: input.message,
    dueAt: input.at,
    requesterId: (await deps.assistantReminders!.requesterFor(ctx)) ?? null,
    now
  })
  if (!created) {
    throw new Error(
      `remind: this agent already holds ${ASSISTANT_REMINDER_PENDING_MAX} pending reminders, the most it may. ` +
        'Nothing was set; cancel one or wait for one to be posted.'
    )
  }
  return {
    id: created.id,
    at: iso(created.dueAt),
    note: 'Set. The daemon posts the text here as written at that time; you are not woken for it.'
  }
}

export const listReminders: ToolHandler<AssistantReminderDeps> = async (ctx, args, deps) => {
  parseArgs(LIST_REMINDERS_ARGS, args)
  const ledger = ledgerOf(ctx, deps)
  if (isSubsessionCoordinate(ctx.thread)) throw new Error(`listReminders: ${BACKGROUND}.`)
  return { reminders: (await ledger.listOpen(ctx.agentId, placeOfSession(ctx))).map(view) }
}

export const cancelReminder: ToolHandler<AssistantReminderDeps> = async (ctx, args, deps) => {
  const { id } = parseArgs(CANCEL_REMINDER_ARGS, args)
  const ledger = ledgerOf(ctx, deps)
  if (isSubsessionCoordinate(ctx.thread)) throw new Error(`cancelReminder: ${BACKGROUND}. Nothing was cancelled.`)
  const reminder = await ledger.cancel(ctx.agentId, id, placeOfSession(ctx), deps.assistantReminders!.now())
  if (!reminder) throw new Error(`cancelReminder: no reminder ${id} was set in this conversation.`)
  if (reminder.status === 'cancelled') return { cancelled: true, reminder: view(reminder) }
  if (reminder.status === 'delivering')
    throw new Error(`cancelReminder: reminder ${id} is being posted right now and can no longer be cancelled.`)
  throw new Error(`cancelReminder: reminder ${id} is no longer pending (${reminder.status}). Nothing was cancelled.`)
}

/** Registry entries for `ops.ts`. */
export const ASSISTANT_REMINDER_HANDLERS: [string, ToolHandler<AssistantReminderDeps>][] = [
  ['remind', remind],
  ['listReminders', listReminders],
  ['cancelReminder', cancelReminder]
]

export const ASSISTANT_REMINDER_ARG_SCHEMAS: [string, z.ZodType][] = [
  ['remind', REMIND_ARGS],
  ['listReminders', LIST_REMINDERS_ARGS],
  ['cancelReminder', CANCEL_REMINDER_ARGS]
]
