// An owning session's stop of its own task (send-message-guide.md §8.7), through the console's own Stop core.
import { z } from 'zod'
import { stopIndexedSubsession } from '../../cp/assistant-activity.js'
import {
  isDelegationCoordinate,
  isSubsessionCoordinate,
  SUBSESSION_COORDINATE_PREFIX
} from '../../session/subsession-coordinate.js'
import type { AssistantSubsession } from '../../store/assistant-subsessions.js'
import { sessionKey } from '../../store/local-store.js'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import { parseArgs, requiredString } from './args.js'
import type { SessionContext, ToolHandler } from './context.js'

export interface AssistantSubsessionDeps {
  assistantSubsessions?: {
    /** Who the stop is logged as: the person behind the live turn, else the agent itself. */
    actor(ctx: SessionContext): { userId: string; name?: string; isBot?: boolean }
    /** The calling session's outward id, without minting one: a session that has none started no task. */
    sessionIdOf(key: string): Promise<string | undefined>
    /** The index row of one of the agent's sub-sessions, by its session key or its outward id. */
    find(agentId: string, id: string): Promise<AssistantSubsession | undefined>
    /** The cancel core the console's Stop calls; true when it interrupted a turn. */
    stopSession(key: string, actor: { userId: string; name?: string; isBot?: boolean }): Promise<boolean>
  }
}

export const STOP_TASK_ARGS = z.object({
  taskId: requiredString('taskId').max(1024, 'argument taskId must be at most 1024 characters')
})

export const STOP_TASK_TOOL: ToolDescriptor = {
  name: 'stopTask',
  description:
    'Stop a background task this session started with sendMessage startTask, when it is no longer needed: the plan ' +
    'changed, a task it depended on failed, or its result is not wanted any more. What it already did is not ' +
    'undone, and a process its runtime started in the background (a build, a dev server) may keep running; the ' +
    'result says so. When it is not clear which task a person means, ask them before stopping one.',
  inputSchema: obj(
    {
      taskId: {
        type: 'string',
        minLength: 1,
        description: 'The `taskId` startTask returned, or one listed as running in your reminders.'
      }
    },
    ['taskId']
  )
}

/** The tool every session that can start a task is offered: never inside a task, patrol or approved proposal itself. */
export function stopTaskToolsFor(session: { thread: string }): ToolDescriptor[] {
  return isSubsessionCoordinate(session.thread) ? [] : [STOP_TASK_TOOL]
}

const NOTHING = 'Nothing was stopped.'

const refused = (reason: string) => ({ result: 'refused' as const, reason: `${reason} ${NOTHING}` })

// One answer for an unknown id and every task this session does not own, so a refusal names nothing (send-message-guide.md §8.7).
const NOT_OWNED = 'This session started no task with that id.'

/** Whether the child key's coordinate is a task's, never a patrol's or an approved proposal's. */
const taskCoordinateOf = (key: string): boolean => {
  const at = key.indexOf(`:${SUBSESSION_COORDINATE_PREFIX}`)
  return at >= 0 && isDelegationCoordinate(key.slice(at + 1))
}

export const stopTask: ToolHandler<AssistantSubsessionDeps> = async (ctx, args, deps) => {
  const { taskId } = parseArgs(STOP_TASK_ARGS, args)
  const port = deps.assistantSubsessions
  if (!port) return refused('Stopping a task is not available on this daemon.')
  // A task, a patrol and an approved proposal own no task, so they get the unknown-id answer too.
  if (isSubsessionCoordinate(ctx.thread)) return refused(NOT_OWNED)
  const here = sessionKey(ctx.platform, ctx.channel, ctx.thread, ctx.agentId, ctx.transportScope)
  const row = await port.find(ctx.agentId, taskId)
  if (!row || row.kind === 'patrol' || !taskCoordinateOf(row.childSessionKey) || row.parentSessionKey !== here)
    return refused(NOT_OWNED)
  // The recorded owner by outward id too: a session recreated on the same key did not start it.
  const owner = await port.sessionIdOf(here)
  if (owner === undefined || row.parentSessionId !== owner) return refused(NOT_OWNED)
  const id = row.childSessionKey
  if (row.state !== 'open') return { result: 'not_running', taskId: id, note: `It has already ended. ${NOTHING}` }
  if ((await stopIndexedSubsession(row, port.stopSession, port.actor(ctx))) === 'stopped') {
    return {
      result: 'stopped',
      taskId: id,
      note:
        'Its current turn was interrupted, messages still waiting for it were dropped, and it reports back here that ' +
        'it ended. Nothing it already did is undone, and a process its runtime started in the background (a build, a ' +
        'dev server) may keep running. To give it new work later, message it with messageTask and this taskId.'
    }
  }
  return {
    result: 'not_running',
    taskId: id,
    note:
      'No turn of it is running. A background process it started may still be running; that cannot be stopped ' +
      'from here, and the task reports back here when it ends.'
  }
}

/** Registry entries for `ops.ts`. */
export const ASSISTANT_SUBSESSION_HANDLERS: [string, ToolHandler<AssistantSubsessionDeps>][] = [['stopTask', stopTask]]

export const ASSISTANT_SUBSESSION_ARG_SCHEMAS: [string, z.ZodType][] = [['stopTask', STOP_TASK_ARGS]]
