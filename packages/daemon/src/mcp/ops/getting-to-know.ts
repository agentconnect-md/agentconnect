// The `getToKnow` tool (assistant-mode.md §5.13): a place's long session asks for a getting-to-know task of its own place.
import { z } from 'zod'
import type { Agent } from '../../agents/agent-schema.js'
import { gettingToKnowPlaceRefusal } from '../../assistant/getting-to-know.js'
import { isAppendCoordinate } from '../../session/append-coordinate.js'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import { parseArgs } from './args.js'
import { PROPOSE_TOOL, PROPOSE_WATCH_TOOL, type AssistantItemDeps } from './assistant-items.js'
import type { ToolHandler } from './context.js'

export const GETTING_TO_KNOW_ARGS = z.object({})

export const GETTING_TO_KNOW_TOOL: ToolDescriptor = {
  name: 'getToKnow',
  description:
    'Get to know this conversation, only when someone here asks you to: a task reads its last 30 days ' +
    'or 500 messages, whichever is less, writes how the place works to memory, and reports back here with what ' +
    'to do next: introduce yourself and offer at most three ways to help. It posts nothing itself and counts ' +
    'against the day’s check budget. One runs at a time. Tell the people here it started; never show them its ' +
    '`taskId`.',
  inputSchema: obj({})
}

/** `getToKnow` for a place's long session where a getting-to-know task could run: assistant mode, not a 1:1 DM, history declared, internal; with `cards`, `propose` for its report's round. */
export function gettingToKnowToolsFor(
  agent: Pick<Agent, 'assistantMode' | 'integrations'>,
  at: { channel: string; thread: string; integrationId?: string | undefined; isDm: boolean },
  opts: { cards?: boolean; watch?: boolean } = {}
): ToolDescriptor[] {
  if (!isAppendCoordinate(at.thread)) return []
  const int = agent.integrations.find((candidate) => candidate.id === at.integrationId)
  if (!int) return []
  if (gettingToKnowPlaceRefusal(agent, int, { channel: at.channel, isDm: at.isDm }) !== undefined) return []
  return opts.cards ? [GETTING_TO_KNOW_TOOL, opts.watch ? PROPOSE_WATCH_TOOL : PROPOSE_TOOL] : [GETTING_TO_KNOW_TOOL]
}

export const gettingToKnow: ToolHandler<AssistantItemDeps> = async (ctx, args, deps) => {
  parseArgs(GETTING_TO_KNOW_ARGS, args)
  const request = deps.assistantItems?.gettingToKnow
  if (!request) throw new Error('getToKnow is not available on this daemon')
  const result = await request(ctx)
  if (result.kind === 'refused') return { started: false, reason: result.reason, note: result.message }
  return {
    started: true,
    taskId: result.taskId,
    note:
      'Started. It reads this place in the background and its report comes here when it ends; until then say ' +
      'nothing more about it. listTasks shows it and stopTask ends it with this taskId, which is for those calls ' +
      'alone: never show it to people.'
  }
}
