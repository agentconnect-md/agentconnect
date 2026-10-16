// The first look (assistant-mode.md §5.13): which places take one, what it may read, how it is asked, and what its report tells the place's long session.
import type { Agent, Integration } from '../agents/agent-schema.js'
import { MEMORY_TOOL_ACCESS_MODES } from '../mcp/ops/memory.js'
import { assistantModeOn, type ProposeInput } from '../mcp/ops/assistant-items.js'
import { integrationCore } from '../platforms/integration-config.js'
import { declaresPort, isAttachmentReadTool } from '../platforms/read-ports.js'
import { routeRules } from '../router/routing-table.js'
import {
  conversationAdmitted,
  conversationKindOf,
  conversationTrustLevel,
  integrationRouting,
  type RoutingRule
} from '../router/routing-rule.js'
import { obj, type ToolDescriptor } from '../tool-schema/descriptor.js'
import { ASSISTANT_ITEM_LIMITS } from '../store/assistant-items.js'

/** How far back a first look reads, and how many messages it reads in all. */
export const FIRST_LOOK_DAYS = 30
export const FIRST_LOOK_MAX_MESSAGES = 500
export const FIRST_LOOK_WINDOW_MS = FIRST_LOOK_DAYS * 24 * 60 * 60_000
/** A join whose place is not listed by then takes no first look. */
export const FIRST_LOOK_JOIN_WAIT_MS = 10 * 60_000
/** Proposals the round a first look's report arrives in may make (§5.13). */
export const FIRST_LOOK_MAX_PROPOSALS = 3

// The place's own reads (§5.13): history, thread replies, the conversation's details, members and profiles, reactions, bookmarks.
const FIRST_LOOK_READ_TOOLS = new Set([
  'getCurrentChannel',
  'getChannelHistory',
  'getThreadHistory',
  'listChannelMembers',
  'getUserProfile',
  'getReactions',
  'listBookmarks'
])

/** A first look's `recordCheck`: same name and handler as a check's, its only output being the whole report. */
export const FIRST_LOOK_RECORD_CHECK_TOOL: ToolDescriptor = {
  name: 'recordCheck',
  description:
    'Hand back this first look, once, when you have read enough. `observation` is one line on what you read; ' +
    '`report` is your whole answer, in its sections; set `done: true`. It is your only output: nothing you write ' +
    'anywhere else reaches the place.',
  inputSchema: obj(
    {
      observation: {
        type: 'string',
        minLength: 1,
        maxLength: ASSISTANT_ITEM_LIMITS.observation,
        description: 'One line on what you read.'
      },
      report: {
        type: 'string',
        minLength: 1,
        maxLength: ASSISTANT_ITEM_LIMITS.firstLookReport,
        description: 'Your whole answer, in its sections.'
      },
      done: { type: 'boolean', description: 'True: this first look is finished.' }
    },
    ['observation', 'report']
  )
}

/** A first look's tool set: its place's own reads, memory reads and `recordCheck`; no recall, search, knowledge or code-host reads. */
export function firstLookTools(tools: readonly ToolDescriptor[]): ToolDescriptor[] {
  const reads = tools.filter(
    (tool) =>
      FIRST_LOOK_READ_TOOLS.has(tool.name) ||
      MEMORY_TOOL_ACCESS_MODES[tool.name] === 'read' ||
      isAttachmentReadTool(tool.name)
  )
  return [...reads, FIRST_LOOK_RECORD_CHECK_TOOL]
}

/** A first look reads only its own place: an argument naming another platform, bot or conversation is refused. */
export function firstLookReadRefusal(
  ctx: { platform: string; channel: string; integrationId?: string | undefined },
  name: string,
  args: Record<string, unknown>
): string | undefined {
  const other =
    (typeof args.platform === 'string' && args.platform !== ctx.platform) ||
    (typeof args.integrationId === 'string' && args.integrationId !== ctx.integrationId) ||
    (typeof args.channel === 'string' && args.channel !== ctx.channel)
  return other
    ? `${name}: a first look reads only its own place; leave out platform, integrationId and channel. Nothing was read.`
    : undefined
}

/** A history row's time in epoch ms, from a platform timestamp in seconds or milliseconds; undefined when it is not one. */
export function historyTsMs(ts: string): number | undefined {
  const value = Number(ts)
  if (!Number.isFinite(value) || value <= 0) return undefined
  return value < 1e11 ? Math.round(value * 1000) : value
}

/** The rows no older than `since`; `ended` once a row in this page fell before it, so older pages are not offered. */
export function withinWindow<T extends { ts: string }>(
  rows: readonly T[],
  since: number
): { kept: T[]; ended: boolean } {
  let ended = false
  const kept = rows.filter((row) => {
    const at = historyTsMs(row.ts)
    if (at === undefined) return false
    if (at < since) ended = true
    return at >= since
  })
  return { kept, ended }
}

/** What a first look's prompt names: the place, what kind of conversation it is, and the place's own tools. */
export interface FirstLookPrompt {
  place: string
  kind: string
  tools: string
  requested: boolean
}

/** The first look's task prompt (§5.13), with "you are in" for one someone asked for. */
export function firstLookPrompt(input: FirstLookPrompt): string {
  const how = input.requested ? 'you are in' : 'you were just added to'
  return `You are taking a first look at ${input.place}, a ${input.kind} ${how}. Read it and report
back. You cannot post, react or change anything, and nothing you write here reaches the place.

Read, newest first, until you have the last ${FIRST_LOOK_DAYS} days or ${FIRST_LOOK_MAX_MESSAGES} messages, whichever
is less: the description, topic, pinned messages and bookmarks; every top-level message; the
replies of any thread with 3+ replies or an unanswered question. Stop early once new messages
stop changing your picture. Read only this place.

Answer in these sections, in the place's main language. Link every claim to the message it
rests on (its link, or its time where it has none), and mark anything inferred rather than
read as (inferred).

## How this place works
What it is for, in two sentences. Who owns or decides what, as people here say it: roles,
never opinions of people. How requests are made, where decisions are recorded, links people
keep using, other bots and what they post.

## Recurring
Things that happened at least twice on a rhythm, and when.

## In flight
Unanswered questions, commitments with a date, threads waiting on someone: owner, date, link.

## Where I could help
At most three; none is a fine answer. Each must rest on two or more messages or on a request
nobody took. Say what you would do first, whether it is one task or a check on a schedule, and
what you lack (a tool, an integration, access). A check runs only on its schedule or when
messaged, never on a new message, so put one that must notice new messages as a check on a
schedule of what came in since the last one. Offer only what the place's conversation can
actually do with its tools: ${input.tools}.

## Not covered
What you could not read or check.

Stay under 1,500 words. Quote no more than a short phrase, record nothing about a person
beyond their role here, and leave out credentials, private links and personal details.
Hand it back with recordCheck: a one-line observation, this answer as its report, and done
set. It is your only output.`
}

// A follow-up wakes only at its next check or when messaged (§5.12), so one offered after a first look needs a schedule.
const FOLLOW_UP_SCHEDULE = `A follow-up runs only at its next check or when messaged, so give each one a first check,
   and word one that must notice new messages as a check on a schedule ("each weekday at 10:00
   I'll look for releases announced since the last check and confirm their notes were posted").`

/** What the long session is told to do with the report (§5.13); step 3 offers `propose` cards where the platform has them, else the text form. */
export function firstLookHandling(reach: string, opts: { external: boolean; cards?: boolean }): string {
  const step1 = `1. Write "How this place works" and "Recurring" to a topic file named after the place, dated,
   plus one index line. Leave out "In flight", any request still open wherever it is listed,
   and anything you would not say in every conversation that reads this layer.`
  if (opts.external)
    return `When a first look reports back:
${step1}
This place is now shared with another organization, so post nothing about this first look in it.`
  return `When a first look reports back:
${step1}
2. Post one short introduction in the place: who you are, one line on what you saw, how to
   reach you (${reach}).
${
  opts.cards
    ? `3. Under it, offer each "Where I could help" item with propose. Offer an "In flight" item as a
   follow-up only if someone is visibly waiting on it.`
    : `3. In the same message, list each "Where I could help" item in one line, and an "In flight" item
   only if someone is visibly waiting on it; act on one when someone here asks for it.`
}
   ${FOLLOW_UP_SCHEDULE}
4. Ask at most one question, and only if the answer changes what you do. Then post nothing
   more on your own.
In everything people read, name a channel by its name or link, never by its raw id.`
}

/** Why a first look's report round refuses a proposal: a follow-up form without a first check would never run (§5.13). */
export function firstLookProposalRefusal(input: Pick<ProposeInput, 'followUp'>): string | undefined {
  return input.followUp && input.followUp.nextCheck === undefined
    ? 'a follow-up offered after a first look needs followUp.nextCheck, since nothing else would wake it: set its ' +
        'first check, and word one that must notice new messages as a check on a schedule; nothing was proposed'
    : undefined
}

/** The report round's text: the handling first, then the first look's report. */
export function firstLookReportText(place: string, handling: string, report: string): string {
  return `[first look] Your first look at ${place} reported back.\n\n${handling}\n\nIts report:\n\n${report}`
}

/** The one report of a requested first look that failed too often (§5.13); an automatic one ends without a word. */
export function firstLookFailedText(place: string, attempts: number): string {
  return (
    `[first look] The first look at ${place} that was asked for here failed ${attempts} times in a row and has ` +
    'ended without reading anything you can use. Tell the people here; they may ask for another.'
  )
}

/** How people reach the agent in the place, as its trigger says: every message, else a mention. */
export function firstLookReach(
  rules: readonly RoutingRule[],
  place: { agentId: string; integrationId: string; platform: string; channel: string }
): string {
  const own = rules.filter((r) => r.agentId === place.agentId && r.integrationId === place.integrationId)
  const plain = routeRules(
    {
      platform: place.platform,
      channel: place.channel,
      isDm: false,
      sender: { isBot: false },
      text: '',
      mentionedBots: []
    },
    own,
    () => null
  )
  return plain?.agentId === place.agentId && plain.via !== 'decision' ? 'I read every message' : '@-mention me'
}

/** Why a place cannot take a first look now; undefined when it can. */
export type FirstLookRefusal = 'assistant-mode-off' | 'direct' | 'no-history' | 'external' | 'off'

/** Whether the agent's conversation on this bot may take a first look: assistant mode, not a 1:1 DM, history declared, internal, and not Off. */
export function firstLookPlaceRefusal(
  agent: Pick<Agent, 'assistantMode'> | undefined,
  int: Integration,
  place: { channel: string; isDm?: boolean }
): FirstLookRefusal | undefined {
  if (!assistantModeOn(agent)) return 'assistant-mode-off'
  if (conversationKindOf({ platform: int.platform, channel: place.channel, isDm: place.isDm }) === 'im') return 'direct'
  if (!declaresPort(int.platform, 'channelHistory')) return 'no-history'
  if (conversationTrustLevel(int, place.channel) === 'external') return 'external'
  if (!conversationAdmitted(integrationRouting(int), place.channel)) return 'off'
  return undefined
}

/** Why a first look of a place ended without reading, for its page. */
export const FIRST_LOOK_REFUSAL_REASONS: Record<FirstLookRefusal, string> = {
  'assistant-mode-off': 'assistant mode is off',
  direct: 'its place is a direct message',
  'no-history': 'its platform lets a bot read no history',
  external: 'its place is shared with another organization',
  off: 'its place is Off for the agent'
}

/** What a first look refusal tells the agent. */
export const FIRST_LOOK_REFUSALS: Record<FirstLookRefusal, string> = {
  'assistant-mode-off': 'This agent is not in assistant mode, so it takes no first look.',
  direct: 'A direct message has nothing to read, so it takes no first look.',
  'no-history': 'This platform does not let a bot read history, so no first look can run here.',
  external: 'This place is shared with another organization, so it takes no first look.',
  off: 'This conversation is Off for the agent, so it takes no first look.'
}

/** What a join's place decides once the Control Plane lists it: take a first look, wait for its row, or none. */
export function joinVerdict(
  agent: Pick<Agent, 'assistantMode'> | undefined,
  int: Integration,
  channel: string
): 'take' | 'wait' | 'drop' {
  if (!assistantModeOn(agent) || !declaresPort(int.platform, 'channelHistory')) return 'drop'
  const listed = integrationCore(int).sessionModes.find((entry) => entry.channel === channel)
  if (!listed) return 'wait'
  // Its long session must be the place's one appending session, which the report opens if nobody spoke yet (§5.2).
  if (listed.mode !== 'append') return 'drop'
  return firstLookPlaceRefusal(agent, int, { channel }) === undefined ? 'take' : 'drop'
}

/** The bot's own join of a conversation, waiting for the conversation's row (§5.13 "Triggers"). */
export interface FirstLookJoin {
  agentId: string
  integrationId: string
  channel: string
  /** The platform user who added the bot, where the platform names one. */
  inviter?: string
  at: number
}

const keyOf = (join: FirstLookJoin): string => JSON.stringify([join.agentId, join.integrationId, join.channel])

/** Joins whose rows are not listed yet, one per agent, bot and conversation; each waits at most {@link FIRST_LOOK_JOIN_WAIT_MS}. */
export class PendingFirstLooks {
  private readonly joins = new Map<string, FirstLookJoin>()

  note(join: FirstLookJoin): void {
    this.joins.set(keyOf(join), join)
  }

  /** The joins still waiting, after dropping any that waited too long. */
  waiting(now: number): FirstLookJoin[] {
    for (const [key, join] of this.joins) if (now - join.at > FIRST_LOOK_JOIN_WAIT_MS) this.joins.delete(key)
    return [...this.joins.values()]
  }

  /** Settle a join once; false when another pass already settled it. */
  done(join: FirstLookJoin): boolean {
    return this.joins.delete(keyOf(join))
  }
}
