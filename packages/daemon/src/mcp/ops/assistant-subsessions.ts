// The main conversation's stop of a sub-session it opened (assistant-mode.md §1.4, §5.8), through the console's own Stop.
import { z } from 'zod'
import { originKindOf } from '@agentconnect.md/protocol'
import { stopIndexedSubsession } from '../../cp/assistant-activity.js'
import { isSyntheticA2aChannel } from '../../cp/cp-collab-routes.js'
import { isSubsessionCoordinate } from '../../session/subsession-coordinate.js'
import type { AssistantSubsession } from '../../store/assistant-subsessions.js'
import { sessionKey } from '../../store/local-store.js'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import { parseArgs, requiredString } from './args.js'
import type { SessionContext, ToolHandler } from './context.js'

/** Who started the live turn, when today's `!stop` sender rule lets them stop work here, else why not. */
export type SubsessionStopper =
  { ok: true; actor: { userId: string; name?: string } } | { ok: false; reason: 'no-person' | 'sender' }

export interface AssistantSubsessionDeps {
  assistantSubsessions?: {
    stopper(ctx: SessionContext): Promise<SubsessionStopper>
    /** The index row of one of the agent's sub-sessions, by its session key or its outward id. */
    find(agentId: string, id: string): Promise<AssistantSubsession | undefined>
    /** The cancel core the console's Stop calls; true when it interrupted a turn. */
    stopSession(key: string, actor: { userId: string; name?: string }): Promise<boolean>
  }
}

/** A place's own conversation: a chat conversation or webchat, never a sub-session, patrol, task, hook, dream or headless cron run. */
export function assistantMainConversation(session: {
  platform: string
  channel: string
  thread: string
  integrationId?: string | undefined
}): boolean {
  if (isSubsessionCoordinate(session.thread) || isSyntheticA2aChannel(session.channel)) return false
  const kind = originKindOf(session.platform) ?? 'chat'
  return kind === 'webchat' || (kind === 'chat' && session.integrationId !== undefined)
}

export const STOP_SUBSESSION_ARGS = z.object({
  sessionId: requiredString('sessionId').max(1024, 'argument sessionId must be at most 1024 characters')
})

export const STOP_SUBSESSION_TOOL: ToolDescriptor = {
  name: 'stopSubsession',
  description:
    'Stop the current turn of a background sub-session that this conversation opened. What it already did is not ' +
    'undone, and a process its runtime started in the background (a build, a dev server) may keep running; the ' +
    'result says so. When it is not clear which sub-session the person means, ask them before stopping one.',
  inputSchema: obj(
    {
      sessionId: {
        type: 'string',
        minLength: 1,
        description:
          "The sub-session's id: the `childSessionId` `sendMessage` returned when you opened it, or one listed as " +
          'running in your standing summary.'
      }
    },
    ['sessionId']
  )
}

/** The tool every agent's session is offered in a place's main conversation only. */
export function assistantSubsessionToolsFor(
  session: Parameters<typeof assistantMainConversation>[0]
): ToolDescriptor[] {
  return assistantMainConversation(session) ? [STOP_SUBSESSION_TOOL] : []
}

const NOTHING = 'Nothing was stopped.'

const refused = (reason: string) => ({ result: 'refused' as const, reason: `${reason} ${NOTHING}` })

export const stopSubsession: ToolHandler<AssistantSubsessionDeps> = async (ctx, args, deps) => {
  const { sessionId } = parseArgs(STOP_SUBSESSION_ARGS, args)
  const port = deps.assistantSubsessions
  if (!port) return refused('Stopping a sub-session is not available on this daemon.')
  if (!assistantMainConversation(ctx))
    return refused('Only the conversation that opened a sub-session can stop it, and this is not one.')
  const stopper = await port.stopper(ctx)
  if (!stopper.ok) {
    return refused(
      stopper.reason === 'no-person'
        ? "This turn was not started by a person's message, and only a person here can ask to stop a sub-session."
        : 'The person whose message started this turn may not stop work in this conversation.'
    )
  }
  // The same answer for an unknown id and another conversation's, so a refusal names nothing.
  const row = await port.find(ctx.agentId, sessionId)
  const here = sessionKey(ctx.platform, ctx.channel, ctx.thread, ctx.agentId, ctx.transportScope)
  if (!row || row.parentSessionKey !== here) return refused('This conversation opened no sub-session with that id.')
  const id = row.childSessionKey
  if (row.state !== 'open') return { result: 'not_running', sessionId: id, note: `It has already ended. ${NOTHING}` }
  if ((await stopIndexedSubsession(row, port.stopSession, stopper.actor)) === 'stopped') {
    return {
      result: 'stopped',
      sessionId: id,
      note:
        'Its current turn was interrupted, and it reports back here that it ended. Nothing it already did is ' +
        'undone, and a process its runtime started in the background (a build, a dev server) may keep running.'
    }
  }
  return {
    result: 'not_running',
    sessionId: id,
    note:
      'No turn of it is running. A background process it started may still be running; that cannot be stopped ' +
      'from here, and the sub-session reports back here when it ends.'
  }
}

/** Registry entries for `ops.ts`. */
export const ASSISTANT_SUBSESSION_HANDLERS: [string, ToolHandler<AssistantSubsessionDeps>][] = [
  ['stopSubsession', stopSubsession]
]

export const ASSISTANT_SUBSESSION_ARG_SCHEMAS: [string, z.ZodType][] = [['stopSubsession', STOP_SUBSESSION_ARGS]]
