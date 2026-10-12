// The read rule (assistant-mode.md §5.5): every agent's read of another conversation is judged by who is asking.
import { metrics } from '@opentelemetry/api'
import { membersAuthoritative, reportsChannelPrivacy, tellsWorkspaceMembers } from '../platforms/read-ports.js'

/** What a conversation is to the rule; `webchat` is the console's own conversation. */
export type PlaceKind = 'dm' | 'group_dm' | 'channel' | 'webchat'

/** A place by its conversation: one platform conversation, whichever of the agent's bots reached it. */
export interface PlaceRef {
  platform: string
  channel: string
}

/** A source place as far as it could be described; an undescribed kind or privacy is refused. */
export interface SourcePlace extends PlaceRef {
  kind?: PlaceKind
  /** The platform's `isPrivate` for a channel or group DM; undefined when it could not be read. */
  private?: boolean
  /** Its display name, which the private-source note gives the model. */
  name?: string
  /** The agent's sessions there by outward id, newest first: what a cross-platform read is judged by. */
  sessions?: readonly string[]
}

/** One person a turn speaks for: a chat member on one of the agent's bots, or a console user. */
export type ReadAsker =
  { kind: 'member'; platform: string; integrationId: string; userId: string } | { kind: 'console'; userId: string }

/** Who is asking on a turn: its people, and whether some of it has no person behind it. */
export interface TurnAskers {
  people: readonly ReadAsker[]
  nobody: boolean
}

/** A turn no person is behind: a scheduled run with no recorded person, a hook, a report round, an agent's wake. */
export const NOBODY: TurnAskers = { people: [], nobody: true }

/** Why a read was refused: a direct conversation, a closed place, or a place that could not be described. */
export type PlaceRefusal = 'direct' | 'private' | 'undetermined'

/** The tools whose cross-place reads pass the rule; a closed set, so it can label a metric. */
export type PlaceReadTool = 'recall' | 'getChannelHistory' | 'getThreadHistory' | 'getReactions' | 'listBookmarks'

/** How a source reads on its own bot: open to anyone who may see the workspace, to its members, or not at all. */
export type SourceClass = 'public' | 'members' | 'direct' | 'webchat' | 'undetermined'

/** Who the console says is behind an asker: a console user with the sessions they could see, a chat member who linked no account, or nobody it can tell. */
export type ConsoleVerdict =
  { asker: 'linked'; visible: ReadonlySet<string> } | { asker: 'unlinked' } | { asker: 'unidentifiable' }

/** The live answers the rule needs; every one fails closed. */
export interface ReadLookups {
  /** Whether a chat member is a current member of the conversation on that bot. */
  member(integrationId: string, channel: string, userId: string): Promise<boolean>
  /** Whether a chat member is a full member of the bot's workspace, not a guest or an outsider. */
  fullMember(integrationId: string, userId: string): Promise<boolean>
  /** The console's own session visibility for whoever is behind the asker, `ownerOnly` for a DM or webchat source; rejects when the Control Plane cannot answer. */
  console(asker: ReadAsker, sessionIds: readonly string[], ownerOnly: boolean): Promise<ConsoleVerdict>
}

/** Lookups that confirm nothing, for a host that wires none. */
export const CLOSED_LOOKUPS: ReadLookups = {
  member: async () => false,
  fullMember: async () => false,
  console: async () => ({ asker: 'unidentifiable' })
}

export function samePlace(a: PlaceRef, b: PlaceRef): boolean {
  return a.platform === b.platform && a.channel === b.channel
}

/** A channel is public only where its platform confirms it; a group DM or DM is always its members'. */
export function sourceClass(source: SourcePlace): SourceClass {
  switch (source.kind) {
    case 'webchat':
      return 'webchat'
    case 'dm':
      return 'direct'
    case 'group_dm':
      return 'members'
    case 'channel':
      if (source.private === true) return 'members'
      return source.private === false && reportsChannelPrivacy(source.platform) ? 'public' : 'undetermined'
    default:
      return 'undetermined'
  }
}

/** A source whose content reaches only some people: a private channel, a group DM, a DM or a webchat conversation. */
export function isPrivateSource(source: SourcePlace): boolean {
  const kind = sourceClass(source)
  return kind === 'members' || kind === 'direct' || kind === 'webchat'
}

/** On the asker's own platform and bot, the platform decides: a public channel for a full member, anything else for its members. */
async function sameBotMayRead(
  userId: string,
  source: SourcePlace,
  bot: string,
  lookups: ReadLookups
): Promise<boolean> {
  const kind = sourceClass(source)
  if (kind === 'undetermined' || kind === 'webchat') return false
  if (kind === 'public') {
    // A platform that cannot tell a full member from a guest opens what it confirms public.
    if (!tellsWorkspaceMembers(source.platform)) return true
    if (await lookups.fullMember(bot, userId)) return true
  }
  // A 1:1 DM's only member besides the bot is its person.
  return membersAuthoritative(source.platform) && (await lookups.member(bot, source.channel, userId))
}

/** May this person read the source on bot `bot`? Elsewhere than their own platform and bot, only as the console would show it to them. */
export async function askerMayRead(
  asker: ReadAsker,
  source: SourcePlace,
  bot: string | undefined,
  lookups: ReadLookups
): Promise<boolean> {
  if (asker.kind === 'member' && bot !== undefined && asker.platform === source.platform && asker.integrationId === bot)
    return await sameBotMayRead(asker.userId, source, bot, lookups)
  const sessions = source.sessions ?? []
  if (sessions.length === 0) return false
  // Stricter than the console: anything but a shared conversation (a DM, webchat, an undescribed place) is its owner's alone.
  const ownerOnly = source.kind !== 'channel' && source.kind !== 'group_dm'
  const verdict = await lookups.console(asker, sessions, ownerOnly)
  return verdict.asker === 'linked' && sessions.every((id) => verdict.visible.has(id))
}

/** Why `source` is closed to this turn, or undefined when every person on it may read it; `ownBot` is the session's own platform and bot. */
export async function readRefusal(
  source: SourcePlace,
  askers: TurnAskers,
  mayRead: (asker: ReadAsker) => Promise<boolean>,
  ownBot: boolean
): Promise<PlaceRefusal | undefined> {
  const kind = sourceClass(source)
  const closed: PlaceRefusal =
    kind === 'undetermined' ? 'undetermined' : kind === 'direct' || kind === 'webchat' ? 'direct' : 'private'
  // A turn, or part of one, that no person is behind reads only what its own bot confirms public.
  if ((askers.nobody || askers.people.length === 0) && !(ownBot && kind === 'public')) return closed
  for (const asker of askers.people) if (!(await mayRead(asker).catch(() => false))) return closed
  return undefined
}

/** Whether a chat member on the turn linked no console account, so a refusal may say how cross-platform reads open. */
export async function askerUnlinked(askers: TurnAskers, lookups: ReadLookups): Promise<boolean> {
  for (const asker of askers.people) {
    if (asker.kind !== 'member') continue
    const verdict = await lookups.console(asker, [], false).catch(() => undefined)
    if (verdict?.asker === 'unlinked') return true
  }
  return false
}

/** The one answer for anything that cannot be shared here; it never says that a place exists or where. */
export const NOT_SHARED_HERE =
  'That cannot be shared here. Do not repeat, summarize, hint at or guess the content, and do not say where it ' +
  'might be or whether it exists; answer: "I can\'t share that here."'

/** The same answer for an asker with no linked console account, who may be told how a cross-platform read opens. */
export const NOT_SHARED_UNLINKED =
  `${NOT_SHARED_HERE} You may add that reading a conversation on another platform or bot needs their account ` +
  'linked under Sign-in methods in their console Profile.'

const SOURCE_WORDS: Record<PlaceKind, string> = {
  channel: 'the private channel',
  group_dm: 'the group DM',
  dm: 'the direct message',
  webchat: 'the console conversation'
}

/** What a read of a private source tells the model alongside it; a hint, never a gate. */
export function privateSourceNote(source: SourcePlace): string {
  const what = `${SOURCE_WORDS[source.kind ?? 'channel']} "${source.name ?? source.channel}"`
  return (
    `This comes from ${what}, a private conversation. When you use it, say so in one short clause, so the ` +
    'person can judge whether it belongs here.'
  )
}

const meter = metrics.getMeter('@agentconnect.md/daemon-assistant', '1.0.0')
const refusedReads = meter.createCounter('agentconnect.assistant.place_reads_refused', {
  unit: '{read}',
  description: 'Cross-place reads refused by the read rule, by tool and reason'
})

/** Where refused reads are counted; labels are the closed tool and reason sets, never a place or an agent. */
export interface PlaceReadMetrics {
  refused(tool: PlaceReadTool, reason: PlaceRefusal): void
}

export const placeReadMetrics: PlaceReadMetrics = {
  refused: (tool, reason) => refusedReads.add(1, { tool, reason })
}

/** The rule every cross-place read passes: the current conversation always, anything else as `readRefusal` decides; a refusal is counted. */
export async function checkPlaceRead(
  tool: PlaceReadTool,
  current: PlaceRef,
  source: SourcePlace,
  askers: TurnAskers,
  mayRead: (asker: ReadAsker) => Promise<boolean>,
  ownBot: boolean,
  recorder: PlaceReadMetrics = placeReadMetrics
): Promise<PlaceRefusal | undefined> {
  if (samePlace(current, source)) return undefined
  const refusal = await readRefusal(source, askers, mayRead, ownBot)
  if (refusal) recorder.refused(tool, refusal)
  return refusal
}
