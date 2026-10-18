// The getting-to-know task (assistant-mode.md §5.13): which places take one, what it may read, how it is asked, and what its report tells the place's long session.
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
import { CHANNELS_FILE, MEMBERS_FILE, ORGANIZATION_FILE } from '../memory/organization-files.js'

/** How far back a getting-to-know task reads, and how many messages it reads in all. */
export const GETTING_TO_KNOW_DAYS = 30
export const GETTING_TO_KNOW_MAX_MESSAGES = 500
export const GETTING_TO_KNOW_WINDOW_MS = GETTING_TO_KNOW_DAYS * 24 * 60 * 60_000
/** A join whose place is not listed by then takes no getting-to-know task. */
export const GETTING_TO_KNOW_JOIN_WAIT_MS = 10 * 60_000
/** Proposals the round a getting-to-know task's report arrives in may make (§5.13). */
export const GETTING_TO_KNOW_MAX_PROPOSALS = 3

// The place's own reads (§5.13): history, thread replies, the conversation's details, members and profiles, reactions, bookmarks.
const GETTING_TO_KNOW_READ_TOOLS = new Set([
  'getCurrentChannel',
  'getChannelHistory',
  'getThreadHistory',
  'listChannelMembers',
  'getUserProfile',
  'getReactions',
  'listBookmarks'
])

// Its memory writes (§5.15): the place's topic file, and the organization files where its layer is the shared one; never a delete.
const GETTING_TO_KNOW_WRITE_TOOLS = new Set(['writeMemory', 'createMemoryEntry', 'updateMemoryEntry'])

// A check runs in the runtime's read-only mode (§5.12), whose reminder reads as forbidding every write, so name the outputs it leaves alone.
const OUTPUTS = [...GETTING_TO_KNOW_WRITE_TOOLS, 'recordCheck']
const READ_ONLY_MODE_OUTPUTS = `This session runs under a read-only or plan permission mode, which restricts your native
shell and file tools only. ${OUTPUTS.slice(0, -1).join(', ')} and ${OUTPUTS.at(-1)}
are AgentConnect tools and this task's outputs, not edits the mode forbids: call them
directly, since no one is here to approve a plan.`

/** A getting-to-know task's `recordCheck`: same name and handler as a check's, its report going to the place's long session. */
export const GETTING_TO_KNOW_RECORD_CHECK_TOOL: ToolDescriptor = {
  name: 'recordCheck',
  description:
    'Hand back this getting-to-know task, once, after you have written what you learned to memory. `observation` is one ' +
    'line on what you read; `report` is your answer, in its sections; set `done: true`. Besides memory it is your ' +
    'only output: nothing else you write reaches the place.',
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
        maxLength: ASSISTANT_ITEM_LIMITS.gettingToKnowReport,
        description: 'Your whole answer, in its sections.'
      },
      done: { type: 'boolean', description: 'True: this getting-to-know task is finished.' }
    },
    ['observation', 'report']
  )
}

/** A getting-to-know task's tool set: its place's own reads, memory reads and writes, and `recordCheck`; no post, react, recall, search, knowledge or code-host reads. */
export function gettingToKnowTools(tools: readonly ToolDescriptor[]): ToolDescriptor[] {
  const kept = tools.filter(
    (tool) =>
      GETTING_TO_KNOW_READ_TOOLS.has(tool.name) ||
      MEMORY_TOOL_ACCESS_MODES[tool.name] === 'read' ||
      GETTING_TO_KNOW_WRITE_TOOLS.has(tool.name) ||
      isAttachmentReadTool(tool.name)
  )
  return [...kept, GETTING_TO_KNOW_RECORD_CHECK_TOOL]
}

/** A getting-to-know task reads only its own place: an argument naming another platform, bot or conversation is refused. */
export function gettingToKnowReadRefusal(
  ctx: { platform: string; channel: string; integrationId?: string | undefined },
  name: string,
  args: Record<string, unknown>
): string | undefined {
  const other =
    (typeof args.platform === 'string' && args.platform !== ctx.platform) ||
    (typeof args.integrationId === 'string' && args.integrationId !== ctx.integrationId) ||
    (typeof args.channel === 'string' && args.channel !== ctx.channel)
  return other
    ? `${name}: a getting-to-know task reads only its own place; leave out platform, integrationId and channel. Nothing was read.`
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

/** What a getting-to-know task's prompt names: the place, what kind of conversation it is, the place's own tools, and whether it writes the shared layer. */
export interface GettingToKnowPrompt {
  place: string
  kind: string
  tools: string
  requested: boolean
  /** The place's platform id, which its line in channels.md names. */
  platform: string
  /** The place writes the shared layer (an internal public channel), so its getting-to-know task also keeps the organization files (§5.15). */
  shared?: boolean
}

// Only a place that writes the shared layer keeps the organization files (§5.15); each save checks the revision it read.
const sharedFiles = (
  platform: string
) => `2. Three shared files every conversation reads. Give each a description header when you
   create it, so MEMORY.md lists it:
   - ${CHANNELS_FILE}: one line for this place, "- [${platform}] <name>: what it is for (#<name>, date)",
     its name as the platform shows it with no "#", e.g. "- [${platform}] release-train: release
     decisions (#release-train, 2026-10-17)".
   - ${ORGANIZATION_FILE}: only what this place shows about the organization as a whole that the
     file does not already say: what it builds or does, its products and customers, teams, stated
     goals and priorities, key systems, and terms people use. Merge it into its sections, not as
     a new block; write nothing when nothing is new.
   - ${MEMBERS_FILE}: the roles people here state for themselves or others, one entry per person.
     Work facts only: role, the areas and systems they own, expertise shown here, current
     projects. Never opinions or evaluations of a person, judgments of their work, sensitive
     personal attributes (health, family, religion, politics, ethnicity, sexuality, finances,
     immigration status, where they live), absences or their reasons.
   Every fact is one line ending in its source and date, "(#name, YYYY-MM-DD)" for what you read
   here, with "(inferred)" after it for anything inferred. ${ORGANIZATION_FILE} opens with a summary
   of at most ten lines, then only the sections "## Products and customers", "## How it works"
   and "## Repositories and systems"; ${CHANNELS_FILE} holds one line per place; a ${MEMBERS_FILE} entry
   is "## Display name (@handle on Platform) \`key\`" and at most ten lines, each starting with
   "Role:", "Works on:", "Knows about:" or "Ask about:". Add an entry only for someone whose
   messages you read here, keyed exactly as the history's senderKey shows it, and source each of
   its lines by this place; where no message shows a senderKey, write no entry. Leave an entry
   you are refused alone. A save that does not fit is refused with the line that failed: fix that
   line and save again.
   Other places update these files too, so never rewrite them with writeMemory: find each with
   listMemoryEntries, read its text and revision with getMemoryEntry, then save it with
   updateMemoryEntry and that revision, or createMemoryEntry while it does not exist. On
   CONFLICT, read it again, merge, and save again.
`

/** The getting-to-know task's task prompt (§5.13, §5.15), with "you are in" for one someone asked for; a place that writes the shared layer also keeps the organization files. */
export function gettingToKnowPrompt(input: GettingToKnowPrompt): string {
  const how = input.requested ? 'you are in' : 'you were just added to'
  const index = input.shared
    ? 'with "index: false" in its header so MEMORY.md leaves it out'
    : 'with a description header so MEMORY.md lists it'
  return `You are getting to know ${input.place}, a ${input.kind} ${how}. Read it, write
what you learned to memory, and report back. You cannot post or react: only your memory writes
and your report leave this task.

${READ_ONLY_MODE_OUTPUTS}

Read, newest first, until you have the last ${GETTING_TO_KNOW_DAYS} days or ${GETTING_TO_KNOW_MAX_MESSAGES} messages, whichever
is less: the description, topic, pinned messages and bookmarks; every top-level message; the
replies of any thread with 3+ replies or an unanswered question. Stop early once new messages
stop changing your picture. Read only this place.

Then write to memory, without a layer argument:
1. A topic file named after the place, dated, ${index}.
   If an earlier getting-to-know task wrote one, update it. It says how the place works: what it is
   for, in two sentences; who owns or decides what, as people here say it: roles, never
   opinions of people; how requests are made, where decisions are recorded, links people keep
   using, other bots and what they post. And what recurs: things that happened at least twice
   on a rhythm, and when.
${input.shared ? sharedFiles(input.platform) : ''}Write nothing in flight, no request still open wherever it appears, and nothing you would
not say in every conversation that reads this memory.

Then report, in the place's main language: one line on what this place is for, then these
sections. Link every claim to the message it rests on (its link, or its time where it has
none), and mark anything inferred rather than read as (inferred).

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
What you could not read, check or write.

Stay under 1,500 words. Quote no more than a short phrase, record nothing about a person
beyond their role here, and leave out credentials, private links and personal details.
Hand it back with recordCheck: a one-line observation, this report, and done set.`
}

// A follow-up wakes only at its next check or when messaged (§5.12), so one offered after a getting-to-know task needs a schedule.
const FOLLOW_UP_SCHEDULE = `A follow-up runs only at its next check or when messaged, so give each one a first check,
   and word one that must notice new messages as a check on a schedule ("each weekday at 10:00
   I'll look for releases announced since the last check and confirm their notes were posted").`

/** What the long session is told to do with the report (§5.13); the getting-to-know task wrote memory itself (§5.15), and step 2 offers `propose` cards where the platform has them, else the text form. */
export function gettingToKnowHandling(reach: string, opts: { external: boolean; cards?: boolean }): string {
  if (opts.external)
    return `When your getting-to-know task reports back:
This place is now shared with another organization, so post nothing about what you read in it.`
  return `When your getting-to-know task reports back (it has already written what it learned to memory):
1. Post one short introduction in the place: who you are, one line on what you saw, how to
   reach you (${reach}).
${
  opts.cards
    ? `2. Under it, offer each "Where I could help" item with propose. Offer an "In flight" item as a
   follow-up only if someone is visibly waiting on it.`
    : `2. In the same message, list each "Where I could help" item in one line, and an "In flight" item
   only if someone is visibly waiting on it; act on one when someone here asks for it.`
}
   ${FOLLOW_UP_SCHEDULE}
3. Ask at most one question, and only if the answer changes what you do. Then post nothing
   more on your own.
In everything people read, name a channel by its name or link, never by its raw id.
Tell people plainly that you read this place's recent messages to get to know it.`
}

/** Why a getting-to-know task's report round refuses a proposal: a follow-up form without a first check would never run (§5.13). */
export function gettingToKnowProposalRefusal(input: Pick<ProposeInput, 'followUp'>): string | undefined {
  return input.followUp && input.followUp.nextCheck === undefined
    ? 'a follow-up offered after getting to know a place needs followUp.nextCheck, since nothing else would wake it: set its ' +
        'first check, and word one that must notice new messages as a check on a schedule; nothing was proposed'
    : undefined
}

/** The report round's text: the handling first, then the getting-to-know task's report. */
export function gettingToKnowReportText(place: string, handling: string, report: string): string {
  return `[getting to know] Your task getting to know ${place} reported back.\n\n${handling}\n\nIts report:\n\n${report}`
}

/** The one report of a requested getting-to-know task that failed too often (§5.13); an automatic one ends without a word. */
export function gettingToKnowFailedText(place: string, attempts: number): string {
  return (
    `[getting to know] Your task getting to know ${place}, asked for here, failed ${attempts} times in a row and ` +
    'has ended without reading anything you can use. Tell the people here in plain words, such as "I could not ' +
    'read this channel’s recent messages"; they may ask for another.'
  )
}

/** How people reach the agent in the place, as its trigger says: every message, else a mention. */
export function gettingToKnowReach(
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

/** Why a place cannot take a getting-to-know task now; undefined when it can. */
export type GettingToKnowRefusal = 'assistant-mode-off' | 'direct' | 'no-history' | 'external' | 'off'

/** Whether the agent's conversation on this bot may take a getting-to-know task: assistant mode, not a 1:1 DM, history declared, internal, and not Off. */
export function gettingToKnowPlaceRefusal(
  agent: Pick<Agent, 'assistantMode'> | undefined,
  int: Integration,
  place: { channel: string; isDm?: boolean }
): GettingToKnowRefusal | undefined {
  if (!assistantModeOn(agent)) return 'assistant-mode-off'
  if (conversationKindOf({ platform: int.platform, channel: place.channel, isDm: place.isDm }) === 'im') return 'direct'
  if (!declaresPort(int.platform, 'channelHistory')) return 'no-history'
  if (conversationTrustLevel(int, place.channel) === 'external') return 'external'
  if (!conversationAdmitted(integrationRouting(int), place.channel)) return 'off'
  return undefined
}

/** Why a getting-to-know task of a place ended without reading, for its page. */
export const GETTING_TO_KNOW_REFUSAL_REASONS: Record<GettingToKnowRefusal, string> = {
  'assistant-mode-off': 'assistant mode is off',
  direct: 'its place is a direct message',
  'no-history': 'its platform lets a bot read no history',
  external: 'its place is shared with another organization',
  off: 'its place is Off for the agent'
}

/** What a getting-to-know task refusal tells the agent. */
export const GETTING_TO_KNOW_REFUSALS: Record<GettingToKnowRefusal, string> = {
  'assistant-mode-off': 'This agent is not in assistant mode, so it does not get to know places.',
  direct: 'A direct message has nothing to read, so there is nothing to get to know.',
  'no-history': 'This platform does not let a bot read history, so you cannot get to know this place.',
  external: 'This place is shared with another organization, so you do not get to know it.',
  off: 'This conversation is Off for the agent, so you do not get to know it.'
}

/** What a join's place decides once the Control Plane lists it: take a getting-to-know task, wait for its row, or none. */
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
  return gettingToKnowPlaceRefusal(agent, int, { channel }) === undefined ? 'take' : 'drop'
}

/** The bot's own join of a conversation, waiting for the conversation's row (§5.13 "Triggers"). */
export interface GettingToKnowJoin {
  agentId: string
  integrationId: string
  channel: string
  /** The platform user who added the bot, where the platform names one. */
  inviter?: string
  at: number
}

const keyOf = (join: GettingToKnowJoin): string => JSON.stringify([join.agentId, join.integrationId, join.channel])

/** Joins whose rows are not listed yet, one per agent, bot and conversation; each waits at most {@link GETTING_TO_KNOW_JOIN_WAIT_MS}. */
export class PendingGettingToKnowTasks {
  private readonly joins = new Map<string, GettingToKnowJoin>()

  note(join: GettingToKnowJoin): void {
    this.joins.set(keyOf(join), join)
  }

  /** The joins still waiting, after dropping any that waited too long. */
  waiting(now: number): GettingToKnowJoin[] {
    for (const [key, join] of this.joins) if (now - join.at > GETTING_TO_KNOW_JOIN_WAIT_MS) this.joins.delete(key)
    return [...this.joins.values()]
  }

  /** Settle a join once; false when another pass already settled it. */
  done(join: GettingToKnowJoin): boolean {
    return this.joins.delete(keyOf(join))
  }
}
