// `listSchedules`, `saveSchedule`, `deleteSchedule` (agent-cron-tools-v1): the agent manages the crons bound to it, with no person's approval.
import type { AgentCronReq, AgentCronResult } from '@agentconnect.md/protocol'
import { z } from 'zod'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import {
  isCheckCoordinate,
  isGettingToKnowCoordinate,
  isResearchCoordinate
} from '../../session/subsession-coordinate.js'
import { parseArgs, requiredString } from './args.js'
import type { SessionContext, ToolHandler } from './context.js'

export interface AgentCronToolDeps {
  agentCrons?: {
    /** Whether this session may manage its agent's crons: the CP serves them and the session is not a check, research or getting-to-know task. */
    offered(ctx: SessionContext): boolean
    call(ctx: SessionContext, req: AgentCronReq): Promise<AgentCronResult>
  }
}

const OFFSET_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
const CRON_ID = z
  .string('argument cronId must be a string')
  .uuid('argument cronId must be an id listSchedules returned')

export const LIST_SCHEDULES_ARGS = z.object({})

export const SAVE_SCHEDULE_ARGS = z
  .object({
    cronId: CRON_ID.optional(),
    name: z.string().trim().min(1).max(120, 'argument name must be at most 120 characters').optional(),
    schedule: z.string().trim().min(1).max(200).optional(),
    runAt: z
      .string()
      .regex(
        OFFSET_INSTANT,
        'argument runAt must be an ISO-8601 instant with an offset, e.g. 2026-11-12T09:00:00+08:00'
      )
      .optional(),
    timezone: requiredString('timezone').max(100),
    prompt: requiredString('prompt').max(20_000, 'argument prompt must be at most 20000 characters'),
    enabled: z.boolean('argument enabled must be a boolean').optional(),
    postHere: z.boolean('argument postHere must be a boolean').optional()
  })
  .refine((args) => (args.schedule === undefined) !== (args.runAt === undefined), {
    message: 'give exactly one of schedule (recurring) or runAt (once)'
  })

export const DELETE_SCHEDULE_ARGS = z.object({ cronId: CRON_ID })

export const LIST_SCHEDULES_TOOL: ToolDescriptor = {
  name: 'listSchedules',
  description:
    'List your scheduled tasks: every AgentConnect cron that runs you, whoever created it, with its id, schedule, ' +
    'timezone, prompt, where its runs post, whether it is on, and whether it runs once.',
  inputSchema: obj({})
}

export const SAVE_SCHEDULE_TOOL: ToolDescriptor = {
  name: 'saveSchedule',
  description:
    'Create or change a scheduled task that runs you later: at each fire you get a new turn with `prompt` and can ' +
    'do the work then. It takes effect at once, with no approval. Give `schedule` for a recurring task or `runAt` ' +
    'for one that runs once and is then deleted. Pass `cronId` (from listSchedules) to change an existing one; this ' +
    'replaces its schedule, timezone, prompt and on/off state. Say in your reply what you scheduled, when, and in ' +
    'which timezone. For fixed text at a set time with no work, prefer a reminder.',
  inputSchema: obj(
    {
      cronId: { type: 'string', description: 'The task to change, from listSchedules. Omit to create one.' },
      name: { type: 'string', maxLength: 120, description: 'A short name people see, e.g. "weekly-deploy-report".' },
      schedule: {
        type: 'string',
        description: 'Recurring: a cron expression in croner syntax read in `timezone`, e.g. `0 9 * * MON-FRI`.'
      },
      runAt: {
        type: 'string',
        description:
          'Once: an ISO-8601 instant with an offset, at least a minute ahead, e.g. `2026-11-12T09:00:00+08:00`.'
      },
      timezone: {
        type: 'string',
        description:
          'IANA timezone of the person asking, e.g. `Asia/Shanghai`; ask if you do not know it. On an edit, pass the ' +
          'current one unless they are changing it.'
      },
      prompt: {
        type: 'string',
        minLength: 1,
        description: 'What you are told to do at each run, written to yourself.'
      },
      enabled: { type: 'boolean', description: 'false pauses the task without deleting it. Default on.' },
      postHere: {
        type: 'boolean',
        description:
          'true (the default for a new task in a chat conversation) posts each run into this conversation; false ' +
          'runs it without posting anywhere. Omit on an edit to keep where it posts.'
      }
    },
    ['timezone', 'prompt']
  )
}

export const DELETE_SCHEDULE_TOOL: ToolDescriptor = {
  name: 'deleteSchedule',
  description:
    'Delete one of your scheduled tasks for good, with its run history. Confirm with the person first when someone ' +
    'else set it up.',
  inputSchema: obj({ cronId: { type: 'string', description: 'The task to delete, from listSchedules.' } }, ['cronId'])
}

export const AGENT_CRON_TOOLS: ToolDescriptor[] = [LIST_SCHEDULES_TOOL, SAVE_SCHEDULE_TOOL, DELETE_SCHEDULE_TOOL]

/** The tools a session is offered: toward a CP that serves them, never in a check, research or getting-to-know task. */
export function agentCronToolsFor(served: boolean, at: { thread: string }): ToolDescriptor[] {
  const narrowed =
    isCheckCoordinate(at.thread) || isResearchCoordinate(at.thread) || isGettingToKnowCoordinate(at.thread)
  return served && !narrowed ? AGENT_CRON_TOOLS : []
}

async function run(ctx: SessionContext, deps: AgentCronToolDeps, name: string, req: AgentCronReq) {
  const port = deps.agentCrons
  if (!port?.offered(ctx)) throw new Error(`${name} is not available in this session`)
  const result = await port.call(ctx, req)
  if (result.status === 'refused') throw new Error(result.message ?? `${name} was refused`)
  return result
}

export const listSchedules: ToolHandler<AgentCronToolDeps> = async (ctx, args, deps) => {
  parseArgs(LIST_SCHEDULES_ARGS, args)
  return { schedules: (await run(ctx, deps, 'listSchedules', { op: 'list', agentId: ctx.agentId })).crons ?? [] }
}

export const saveSchedule: ToolHandler<AgentCronToolDeps> = async (ctx, args, deps) => {
  const a = parseArgs(SAVE_SCHEDULE_ARGS, args)
  // A new task in a chat conversation posts here unless told not to; an edit keeps its target unless told.
  const postHere = a.postHere ?? (a.cronId === undefined && ctx.integrationId !== undefined)
  if (a.postHere === true && ctx.integrationId === undefined)
    throw new Error('this conversation has no chat integration to post into; set postHere to false')
  const target =
    postHere && ctx.integrationId !== undefined
      ? { integrationId: ctx.integrationId, channel: ctx.channel }
      : a.postHere === false || a.cronId === undefined
        ? null
        : undefined
  const result = await run(ctx, deps, 'saveSchedule', {
    op: 'save',
    agentId: ctx.agentId,
    cron: {
      ...(a.cronId ? { cronId: a.cronId } : {}),
      ...(a.name ? { name: a.name } : {}),
      ...(a.schedule ? { schedule: a.schedule } : {}),
      ...(a.runAt ? { runAt: a.runAt } : {}),
      timezone: a.timezone,
      trigger: a.prompt,
      ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
      ...(target !== undefined ? { target } : {})
    }
  })
  return { saved: result.cron }
}

export const deleteSchedule: ToolHandler<AgentCronToolDeps> = async (ctx, args, deps) => {
  const { cronId } = parseArgs(DELETE_SCHEDULE_ARGS, args)
  await run(ctx, deps, 'deleteSchedule', { op: 'delete', agentId: ctx.agentId, cronId })
  return { deleted: cronId }
}
