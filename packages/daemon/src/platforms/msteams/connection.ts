// One Teams bot's daemon connection (teams-integration.md §3, §4.3): relay-terminated ingress, Bot Connector egress, no socket.
import { createHash } from 'node:crypto'
import {
  MSTEAMS_PLATFORM,
  type IntegrationMsTeamsConfig,
  type PlaceExternalReason,
  type WireMsTeamsMembersAdded
} from '@agentconnect.md/protocol'
import type { Agent } from '../../agents/agent-schema.js'
import type { Logger } from '../../log.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import { splitMarkdownByBytes } from '../../messages/split-markdown-bytes.js'
import type {
  PlatformChannelHistoryOptions,
  PlatformChannelHistoryPage,
  PlatformChannelInfo,
  PlatformChannelRef,
  PlatformConnection,
  PlatformMemberRef,
  PlatformThreadMessage,
  PlatformThreadWindow,
  PlatformUserProfile
} from '../contract.js'
import { platformIntegrationConfig } from '../integration-config.js'
import { PlatformSendQueue } from '../send-queue.js'
import type { WriteBudget } from '../write-budget.js'
import {
  MSTEAMS_GRAPH_SCOPE,
  MSTEAMS_TEXT_FORMAT,
  MSTEAMS_WRITE_TIMEOUT_MS,
  MsTeamsApi,
  MsTeamsApiError,
  type MsTeamsChannelKind,
  type MsTeamsMember,
  type MsTeamsTarget
} from './api.js'
import {
  MSTEAMS_GRAPH_PAGE_MAX,
  MsTeamsGraph,
  msTeamsSkiptoken,
  type MsTeamsTeamVisibility,
  type MsTeamsGraphMessage,
  type MsTeamsHistorySource
} from './graph.js'

/** Every write into one conversation is spaced this far apart: Microsoft allows 1,800 an hour per conversation (§4.3). */
export const MSTEAMS_CONVERSATION_INTERVAL_MS = 2_000
/** An answer above this many UTF-8 bytes is split into consecutive messages, under Teams' 100 KB message limit (§4.3). */
export const MSTEAMS_MESSAGE_MAX_BYTES = 80 * 1024

const CONVERSATIONS_MAX = 2_000
const MEMBERS_PER_CONVERSATION = 200
const NAMES_MAX = 5_000
const CARDS_MAX = 2_000

/** The attachment type of an Adaptive Card (§4.4). */
export const MSTEAMS_ADAPTIVE_CARD_TYPE = 'application/vnd.microsoft.card.adaptive'

/** One connection's worth of consolidated integrations (§7.5 registry group shape). */
export interface MsTeamsConnectionGroup {
  key: string
  agentId: string
  integrationId: string
  config: IntegrationMsTeamsConfig
  integrations: { agentId: string; integrationId: string }[]
}

/** §7.5 opaque identity: the app, its tenant and its secret, so a rotated secret opens a new client and the old one drains. */
export function msTeamsConnKey(c: Pick<IntegrationMsTeamsConfig, 'appId' | 'tenantId' | 'clientSecret'>): string {
  return createHash('sha256')
    .update(JSON.stringify([c.appId.toLowerCase(), c.tenantId.toLowerCase(), c.clientSecret]))
    .digest('hex')
}

/** Group an agent set's Teams integrations, one connection per bot credential; a rejected config is skipped. */
export function consolidateMsTeams(agents: Agent[], log?: Logger): Map<string, MsTeamsConnectionGroup> {
  const groups = new Map<string, MsTeamsConnectionGroup>()
  for (const agent of agents)
    for (const int of agent.integrations) {
      if (int.platform !== MSTEAMS_PLATFORM) continue
      const config = platformIntegrationConfig(MSTEAMS_PLATFORM, int)
      if (!config) {
        log?.warn(`msteams: integration ${int.id} skipped — config failed the msteams schema`)
        continue
      }
      const key = msTeamsConnKey(config)
      const group = groups.get(key)
      if (group) group.integrations.push({ agentId: agent.id, integrationId: int.id })
      else
        groups.set(key, {
          key,
          agentId: agent.id,
          integrationId: int.id,
          config,
          integrations: [{ agentId: agent.id, integrationId: int.id }]
        })
    }
  return groups
}

/** Split an answer into consecutive messages under the size limit, fences closed and reopened across a cut. */
export function splitMsTeamsText(text: string): string[] {
  return splitMarkdownByBytes(text, MSTEAMS_MESSAGE_MAX_BYTES)
}

/** The reply coordinates a Teams message carries in `adapterExt.msteams`, read defensively because the bag is persisted. */
export function msTeamsTargetOf(msg: Pick<NormalizedMessage, 'platform' | 'adapterExt'>): MsTeamsTarget | undefined {
  if (msg.platform !== MSTEAMS_PLATFORM) return undefined
  const ext = msg.adapterExt?.[MSTEAMS_PLATFORM] as { serviceUrl?: unknown; conversationId?: unknown } | undefined
  const serviceUrl = typeof ext?.serviceUrl === 'string' ? ext.serviceUrl : undefined
  const conversationId = typeof ext?.conversationId === 'string' ? ext.conversationId : undefined
  return serviceUrl?.startsWith('https://') && conversationId ? { serviceUrl, conversationId } : undefined
}

/** What a turn's output needs: a send that answers the activity ID, an edit, and a delete. */
export interface MsTeamsEgressPort {
  post(target: MsTeamsTarget, text: string): Promise<string>
  update(target: MsTeamsTarget, activityId: string, text: string): Promise<void>
  remove(target: MsTeamsTarget, activityId: string): Promise<void>
}

/** The egress port plus chrome: a conversation's recorded target, and a plain post split under the limit. */
export interface MsTeamsReplyPort extends MsTeamsEgressPort {
  targetFor(channel: string, thread?: string): MsTeamsTarget | undefined
  postText(target: MsTeamsTarget, text: string): Promise<void>
}

/** What a card facet needs: a card post that answers the activity ID, and its replacement where it landed. */
export interface MsTeamsCardPort {
  targetFor(channel: string, thread?: string): MsTeamsTarget | undefined
  postCard(target: MsTeamsTarget, card: Record<string, unknown>, summary?: string): Promise<string>
  replaceCard(
    activityId: string,
    card: Record<string, unknown>,
    at: { channel: string; thread?: string }
  ): Promise<void>
}

/** A conversation as the bot has seen it: the serviceUrl its latest activity carried and its kind. */
interface KnownConversation {
  serviceUrl: string
  kind: 'personal' | 'chat' | 'channel'
  /** A 1:1 chat's counterpart, or a channel's name read from its team; group chats stay unnamed. */
  name?: string
  /** A channel's enclosing team, whose channel list names it. */
  teamId?: string
}

/** What Teams answers unnamed in a team's channel list: the default channel, which its client calls General. */
const DEFAULT_CHANNEL_NAME = 'General'
/** How long a team's channel names are trusted, and how long a failed read waits before trying again. */
const TEAM_CHANNELS_TTL_MS = 10 * 60_000
/** How long a conversation's member list is trusted, and how long a failed read waits before trying again. */
const ROSTER_TTL_MS = 10 * 60_000
/** The most members one read returns, five pages of the Bot Connector's hundred. */
const ROSTER_MAX = 500
/** The most Graph reads one history page makes to fill itself past dropped system events. */
const HISTORY_FILL_READS = 5
/** How long a person's standing is trusted before it is looked up again. */
const STANDING_TTL_MS = 10 * 60_000
/** The most members an authoritative listing reads before it refuses to answer a partial one. */
const MEMBER_IDS_MAX = 2_000

/** A channel as its team's list reports it. */
interface TeamChannel {
  name: string
  kind?: MsTeamsChannelKind
}

/** A guest, or a member of another tenant, makes the place they joined external; null for a member of the bot's own tenant. */
export function memberExternalReason(member: MsTeamsMember, homeTenantId: string): PlaceExternalReason | null {
  if (member.userRole?.toLowerCase() === 'guest') return 'guestMember'
  return member.tenantId && member.tenantId.toLowerCase() !== homeTenantId.toLowerCase() ? 'externalMember' : null
}

/** A full member of the bot's organization, who may approve a draft: stricter than the reason above, so an unknown role is not one. */
export function fullMember(member: MsTeamsMember, homeTenantId: string): boolean {
  return (
    member.userRole?.toLowerCase() === 'user' &&
    member.tenantId?.toLowerCase() === homeTenantId.toLowerCase() &&
    !member.id.startsWith('28:')
  )
}

export interface MsTeamsDeps {
  group: MsTeamsConnectionGroup
  log?: Logger
  /** Injected so tests need no network. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  /** Min spacing (ms) between writes into one conversation. Tests pass 0. */
  sendIntervalMs?: number
  /** The (app, tenant) write budget on this daemon, shared by every connection of the app; absent ⇒ unbudgeted. */
  budget?: WriteBudget
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value!)
}

export class MsTeamsConnection implements PlatformConnection, MsTeamsReplyPort, MsTeamsCardPort {
  readonly key: string
  readonly integrationId: string
  readonly agentId: string
  readonly appId: string
  readonly tenantId: string
  /** The bot's own `28:<appId>`, the ID a mention entity names (§4.1). */
  readonly botUserId: string
  /** Teams deep links come from the client, so the console URL is the fallback. */
  readonly workspaceUrl = ''
  private readonly api: MsTeamsApi
  private readonly graph: MsTeamsGraph
  /** Team thread ID → its Microsoft 365 group ID, which never changes; a failed read is forgotten. */
  private readonly teamGroups = new Map<string, Promise<string>>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly sendIntervalMs: number
  /** One write queue per raw conversation ID (§4.3): Microsoft's limits are per bot per conversation. */
  private readonly queues = new Map<string, PlatformSendQueue>()
  /** Normalized channel → what its traffic told us; the serviceUrl is read from activities, never built (§3). */
  private readonly conversations = new Map<string, KnownConversation>()
  private readonly members = new Map<string, Map<string, string | undefined>>()
  private readonly names = new Map<string, string>()
  /** Conversation → its member list and when it was read; a read in flight is shared, a failed one answers undefined. */
  private readonly rosters = new Map<string, { at: number; members: Promise<PlatformMemberRef[] | undefined> }>()
  /** Team → its channels' names and types and when they were read; a read in flight is shared. */
  private readonly teamChannels = new Map<string, { at: number; channels: Promise<Map<string, TeamChannel>> }>()
  /** Person, by `29:` and Entra object ID → their standing as a lookup or a member listing last answered. */
  private readonly standings = new Map<string, { at: number; member: MsTeamsMember }>()
  /** Team → its visibility and when it was read; a failed read answers undefined until the TTL passes. */
  private readonly teamVisibilities = new Map<
    string,
    { at: number; visibility: Promise<MsTeamsTeamVisibility | undefined> }
  >()
  /** Shared channel → whether it reaches another organization and when that was read. */
  private readonly sharedReaches = new Map<string, { at: number; reason: Promise<PlaceExternalReason | null> }>()
  /** Conversation + card activity ID → where it landed; an activity ID is unique only within its conversation (§4.2). */
  private readonly cards = new Map<string, MsTeamsTarget>()
  private readonly writeGate: (() => Promise<void>) | undefined
  private stopped = false

  constructor(private readonly deps: MsTeamsDeps) {
    const { group } = deps
    this.key = group.key
    this.integrationId = group.integrationId
    this.agentId = group.agentId
    this.appId = group.config.appId.toLowerCase()
    this.tenantId = group.config.tenantId.toLowerCase()
    this.botUserId = `28:${this.appId}`
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.sendIntervalMs = deps.sendIntervalMs ?? MSTEAMS_CONVERSATION_INTERVAL_MS
    this.api = new MsTeamsApi(group.config, {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      now: this.now,
      sleep: this.sleep,
      ...(deps.random ? { random: deps.random } : {})
    })
    // A Graph token carries the consent of the tenant it is minted in, so it comes from the conversations' tenant, never the token tenant.
    const { appId, tenantId, clientSecret } = group.config
    this.graph = new MsTeamsGraph(
      new MsTeamsApi(
        { appId, tenantId, clientSecret },
        {
          scope: MSTEAMS_GRAPH_SCOPE,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          now: this.now,
          sleep: this.sleep,
          ...(deps.random ? { random: deps.random } : {})
        }
      )
    )
    const budget = deps.budget
    this.writeGate = budget ? () => budget.take() : undefined
  }

  /** The tenant the bot is registered in: the durable anchor its people's Entra object IDs are scoped by. */
  workspaceId(): string {
    return this.tenantId
  }

  // ── 1. transport lifecycle ──

  /** No socket to open: warm the token, which proves the app, tenant and secret together (§2). */
  async start(): Promise<void> {
    this.stopped = false
    await this.api.token()
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  /** Record what a delivered message proves: its conversation's serviceUrl and kind, and who spoke there. */
  noteMessage(msg: NormalizedMessage): void {
    const target = msTeamsTargetOf(msg)
    if (!target) return
    const kind = msg.isDm ? 'personal' : target.conversationId.includes(';messageid=') ? 'channel' : 'chat'
    const known = this.conversations.get(msg.channel)
    const name = kind === 'personal' ? msg.sender.name : known?.name
    const ext = msg.adapterExt?.[MSTEAMS_PLATFORM] as { teamId?: unknown } | undefined
    const teamId = kind === 'channel' && typeof ext?.teamId === 'string' ? ext.teamId : known?.teamId
    remember(
      this.conversations,
      msg.channel,
      { serviceUrl: target.serviceUrl, kind, ...(name ? { name } : {}), ...(teamId ? { teamId } : {}) },
      CONVERSATIONS_MAX
    )
    const members = this.members.get(msg.channel) ?? new Map<string, string | undefined>()
    remember(members, msg.sender.id, msg.sender.name, MEMBERS_PER_CONVERSATION)
    remember(this.members, msg.channel, members, CONVERSATIONS_MAX)
    if (msg.sender.name) remember(this.names, msg.sender.id, msg.sender.name, NAMES_MAX)
  }

  /** A seen conversation's write target: a channel thread posts into `<channel>;messageid=<root>`, anything else into the conversation. */
  targetFor(channel: string, thread?: string): MsTeamsTarget | undefined {
    const known = this.conversations.get(channel)
    if (!known) return undefined
    const conversationId =
      known.kind === 'channel' && thread && /^[^\s:;]+$/.test(thread) ? `${channel};messageid=${thread}` : channel
    return { serviceUrl: known.serviceUrl, conversationId }
  }

  // ── 2. egress ──

  /** Post one message; answers the activity ID Teams assigned. */
  async post(target: MsTeamsTarget, text: string): Promise<string> {
    return await this.write(target, () => this.api.postActivity(target, activityOf(text)))
  }

  /** Edit a message this bot posted. */
  async update(target: MsTeamsTarget, activityId: string, text: string): Promise<void> {
    await this.write(target, () => this.api.updateActivity(target, activityId, activityOf(text)))
  }

  /** Delete a message this bot posted, as a withdrawn acknowledgement is. */
  async remove(target: MsTeamsTarget, activityId: string): Promise<void> {
    await this.write(target, () => this.api.deleteActivity(target, activityId))
  }

  /** Post an Adaptive Card; answers the activity ID Teams assigned. */
  async postCard(target: MsTeamsTarget, card: Record<string, unknown>, summary?: string): Promise<string> {
    const id = await this.write(target, () => this.api.postActivity(target, cardActivityOf(card, summary)))
    remember(this.cards, cardKey(channelOf(target.conversationId), id), target, CARDS_MAX)
    return id
  }

  /** Replace a posted card in place; one this process did not post is found by its conversation, else left as it is. */
  async replaceCard(
    activityId: string,
    card: Record<string, unknown>,
    at: { channel: string; thread?: string }
  ): Promise<void> {
    const target = this.cards.get(cardKey(at.channel, activityId)) ?? this.targetFor(at.channel, at.thread)
    if (!target) throw new MsTeamsApiError('msteams: the card’s conversation is unknown', 'not_found')
    await this.write(target, () => this.api.updateActivity(target, activityId, cardActivityOf(card)))
  }

  /** The send tool's post into a conversation the bot has seen; a long post's later parts follow its first into its thread. */
  async postMessage(channel: string, text: string, thread?: string): Promise<string | undefined> {
    let first: string | undefined
    for (const part of splitMsTeamsText(text)) {
      const target = this.targetFor(channel, thread ?? first)
      if (!target) throw new MsTeamsApiError('msteams: the conversation is unknown', 'not_found')
      const id = await this.post(target, part)
      first ??= id
    }
    return first
  }

  /** Chrome (a command reply, a notice): posted as is, split under the limit. */
  async postText(target: MsTeamsTarget, text: string): Promise<void> {
    for (const part of splitMsTeamsText(text)) await this.post(target, part)
  }

  private write<T>(target: MsTeamsTarget, task: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new MsTeamsApiError('msteams: connection stopped', 'unavailable'))
    return this.queueFor(target.conversationId).enqueue(task, this.writeGate)
  }

  private queueFor(conversationId: string): PlatformSendQueue {
    let queue = this.queues.get(conversationId)
    if (!queue) {
      // A throttled write waits out the server's Retry-After inside its task, so the queue allows the whole retry budget.
      queue = new PlatformSendQueue(this.sendIntervalMs, this.now, this.sleep, MSTEAMS_WRITE_TIMEOUT_MS)
      remember(this.queues, conversationId, queue, CONVERSATIONS_MAX)
    }
    return queue
  }

  // ── 3. read port: members from the Bot Connector, else observed from traffic; the audience as Slack's is judged (assistant-mode.md §5.3) ──

  async getChannelInfo(channel: string): Promise<PlatformChannelInfo> {
    const known = this.conversations.get(channel)
    const isIm = known ? known.kind === 'personal' : channel.startsWith('a:')
    if (known?.kind !== 'channel') {
      // A chat is shared with no organization; a person from another one in it is a member's reason, as on Slack.
      const name = known?.name
      return {
        id: channel,
        ...(name ? { name } : {}),
        isIm,
        isPrivate: true,
        ...(known ? { externalReason: null } : {})
      }
    }
    // A channel's name and type follow its team's list, refreshed after the TTL; the last name read stands while a refresh fails.
    const listed = await this.teamChannel(channel, known)
    const name = listed?.name ?? known.name
    // A standard channel is open to its whole team, which is public only when Graph says so; any other channel is its members'.
    const isPrivate = listed?.kind === 'standard' ? !(await this.teamPublic(known)) : true
    // A channel whose type is unread is unknown, never unshared.
    const externalReason = listed?.kind ? await this.channelShare(channel, known, listed.kind) : undefined
    return {
      id: channel,
      ...(name ? { name } : {}),
      isIm,
      isPrivate,
      ...(externalReason !== undefined ? { externalReason } : {})
    }
  }

  /** Whether a delivered message's channel is shared with another organization, so the message carries it as Slack's envelope does. */
  async sharedChannel(channel: string): Promise<boolean> {
    const known = this.conversations.get(channel)
    const kind = known?.kind === 'channel' ? (await this.teamChannel(channel, known))?.kind : undefined
    return kind !== undefined && (await this.channelShare(channel, known!, kind)) === 'externallyShared'
  }

  // A shared channel reaches another organization when a member is from another tenant; one whose members cannot be read is taken to.
  private async channelShare(
    channel: string,
    known: KnownConversation,
    kind: MsTeamsChannelKind
  ): Promise<PlaceExternalReason | null> {
    if (kind !== 'shared') return null
    let entry = this.sharedReaches.get(channel)
    if (!entry || this.now() - entry.at > ROSTER_TTL_MS) {
      const reason = this.memberList(channel, known, MEMBER_IDS_MAX).then(
        ({ members, complete }) =>
          !complete || members.some((m) => m.tenantId && m.tenantId.toLowerCase() !== this.tenantId)
            ? ('externallyShared' as const)
            : null,
        (err: unknown) => {
          this.deps.log?.debug(`msteams: reading a shared channel's members failed: ${(err as Error).message}`)
          return 'externallyShared' as const
        }
      )
      entry = { at: this.now(), reason }
      remember(this.sharedReaches, channel, entry, CONVERSATIONS_MAX)
    }
    return await entry.reason
  }

  // Whether a channel's team is public, read at most once per TTL per team; a failed read is not public.
  private async teamPublic(known: KnownConversation): Promise<boolean> {
    if (!known.teamId) return false
    const teamId = known.teamId
    let entry = this.teamVisibilities.get(teamId)
    if (!entry || this.now() - entry.at > TEAM_CHANNELS_TTL_MS) {
      const visibility = this.groupIdOf(known)
        .then((groupId) => this.graph.teamVisibility(groupId))
        .catch((err: unknown) => {
          this.deps.log?.debug(`msteams: reading a team's visibility failed: ${(err as Error).message}`)
          return undefined
        })
      entry = { at: this.now(), visibility }
      remember(this.teamVisibilities, teamId, entry, CONVERSATIONS_MAX)
    }
    return (await entry.visibility) === 'public'
  }

  // A conversation's members from the read that answers them: Graph for a shared channel, which refuses the Bot Connector's.
  private async memberList(
    channel: string,
    known: KnownConversation,
    max: number
  ): Promise<{ members: MsTeamsMember[]; complete: boolean }> {
    const kind = known.kind === 'channel' ? (await this.teamChannel(channel, known))?.kind : undefined
    const result =
      kind === 'shared'
        ? await this.graph.channelMembers(await this.groupIdOf(known), channel, max)
        : await this.api.conversationMembers(known.serviceUrl, channel, max)
    for (const m of result.members) this.noteStanding(m)
    return result
  }

  // A channel's name and type from its team's channel list; a failed read names nothing.
  private async teamChannel(channel: string, known: KnownConversation): Promise<TeamChannel | undefined> {
    if (!known.teamId) return undefined
    const listed = (await this.teamChannelList(known.teamId, known.serviceUrl)).get(channel)
    const current = this.conversations.get(channel)
    if (listed && current) remember(this.conversations, channel, { ...current, name: listed.name }, CONVERSATIONS_MAX)
    return listed
  }

  // A team's channels, read at most once per TTL per team; a failed read answers none until the TTL passes.
  private async teamChannelList(teamId: string, serviceUrl: string): Promise<Map<string, TeamChannel>> {
    let entry = this.teamChannels.get(teamId)
    if (!entry || this.now() - entry.at > TEAM_CHANNELS_TTL_MS) {
      const channels = this.api.teamChannels(serviceUrl, teamId).then(
        (list) =>
          new Map(
            list.map((c) => [c.id, { name: c.name ?? DEFAULT_CHANNEL_NAME, ...(c.kind ? { kind: c.kind } : {}) }])
          ),
        (err: unknown) => {
          this.deps.log?.debug(`msteams: reading a team's channels failed: ${(err as Error).message}`)
          return new Map<string, TeamChannel>()
        }
      )
      entry = { at: this.now(), channels }
      remember(this.teamChannels, teamId, entry, CONVERSATIONS_MAX)
    }
    return await entry.channels
  }

  /** The places a roster change made external and why: each added person looked up for a guest or another organization. */
  async joinedMemberReasons(
    join: WireMsTeamsMembersAdded
  ): Promise<{ channel: string; reason: PlaceExternalReason }[]> {
    const reasons = new Set<PlaceExternalReason>()
    for (const { id, aadObjectId } of join.members) {
      const member = await this.api
        .conversationMember(join.serviceUrl, join.conversationId, aadObjectId ?? id)
        .catch((err: unknown) => {
          this.deps.log?.warn(`msteams: looking up a member who joined failed: ${(err as Error).message}`)
          return undefined
        })
      if (!member) continue
      this.noteStanding(member)
      const reason = memberExternalReason(member, this.tenantId)
      if (reason) reasons.add(reason)
    }
    if (reasons.size === 0) return []
    // A person who joined the team reaches every standard channel; a channel or chat join reaches that one.
    const channels = new Set([join.conversationId])
    if (join.teamWide && join.teamId)
      for (const [id, c] of await this.teamChannelList(join.teamId, join.serviceUrl))
        if (c.kind === 'standard') channels.add(id)
    return [...channels].flatMap((channel) => [...reasons].map((reason) => ({ channel, reason })))
  }

  /** A full member of the bot's organization: a `user` of its tenant, never a guest, someone from another tenant, or a bot. */
  async isFullMember(user: string): Promise<boolean> {
    return fullMember(await this.standingOf(user), this.tenantId)
  }

  // A person's standing within the TTL, else looked up in a conversation they were seen in; rejects when none can tell.
  private async standingOf(user: string): Promise<MsTeamsMember> {
    const hit = this.standings.get(user)
    if (hit && this.now() - hit.at < STANDING_TTL_MS) return hit.member
    for (const [channel, seen] of this.members) {
      const known = seen.has(user) ? this.conversations.get(channel) : undefined
      if (!known) continue
      const member = await this.api.conversationMember(known.serviceUrl, channel, user).catch(() => undefined)
      if (member) {
        this.noteStanding(member)
        return member
      }
    }
    throw new MsTeamsApiError(
      'msteams: no conversation this bot shares with the person tells their standing',
      'not_found'
    )
  }

  private noteStanding(member: MsTeamsMember): void {
    const entry = { at: this.now(), member }
    remember(this.standings, member.id, entry, NAMES_MAX)
    if (member.aadObjectId) remember(this.standings, member.aadObjectId, entry, NAMES_MAX)
  }

  /** Every current member of a conversation, keyed as a sender is; rejects when the listing is refused or longer than one read. */
  async listMemberIds(channel: string): Promise<string[]> {
    const known = this.conversations.get(channel)
    if (!known) throw new MsTeamsApiError('msteams: the conversation is unknown to this bot', 'not_found')
    const { members, complete } = await this.memberList(channel, known, MEMBER_IDS_MAX)
    if (!complete)
      throw new MsTeamsApiError('msteams: the conversation has more members than one listing reads', 'invalid')
    return members.filter((m) => !m.id.startsWith('28:')).map((m) => m.aadObjectId ?? m.id)
  }

  // The conversation's member list read through the Bot Connector, else the people seen speaking there.
  async listMembers(channel: string): Promise<PlatformMemberRef[]> {
    const known = this.conversations.get(channel)
    const roster = known ? await this.roster(channel, known) : undefined
    if (roster) return roster
    return [...(this.members.get(channel) ?? [])].map(([id, name]) => ({ id, ...(name ? { name } : {}), isBot: false }))
  }

  // A conversation's members keyed as the normalizer keys a sender, read at most once per TTL; a failed read answers undefined.
  private async roster(channel: string, known: KnownConversation): Promise<PlatformMemberRef[] | undefined> {
    let entry = this.rosters.get(channel)
    if (!entry || this.now() - entry.at > ROSTER_TTL_MS) {
      const members = this.memberList(channel, known, ROSTER_MAX).then(
        ({ members: list }) => {
          return list.map(({ id, aadObjectId, name }) => ({
            id: aadObjectId ?? id,
            ...(name ? { name } : {}),
            isBot: id.startsWith('28:')
          }))
        },
        (err: unknown) => {
          this.deps.log?.debug(`msteams: reading a conversation's members failed: ${(err as Error).message}`)
          return undefined
        }
      )
      entry = { at: this.now(), members }
      remember(this.rosters, channel, entry, CONVERSATIONS_MAX)
    }
    const members = await entry.members
    for (const m of members ?? []) if (m.name && !m.isBot) remember(this.names, m.id, m.name, NAMES_MAX)
    return members
  }

  async listChannels(): Promise<PlatformChannelRef[]> {
    return [...this.conversations].map(([id, { name }]) => ({ id, ...(name ? { name } : {}), isPrivate: true }))
  }

  async getUserProfile(user: string): Promise<PlatformUserProfile> {
    const name = this.names.get(user)
    return { id: user, ...(name ? { name } : {}) }
  }

  /** Attachments are unsupported in both directions (§1): never fetched. */
  async downloadFile(_ref: string, _maxBytes?: number): Promise<Buffer | null> {
    return null
  }

  // ── 4. history: Graph reads under the package's resource-specific consent, for conversations the bot has seen ──

  /** One newest-first page of a channel's posts or a group chat's messages, at most 50, within the inclusive bounds. */
  async getChannelHistory(
    channel: string,
    options: PlatformChannelHistoryOptions = {}
  ): Promise<PlatformChannelHistoryPage> {
    const source = await this.historySource(channel)
    const top = Math.min(Math.max(Math.trunc(options.limit ?? MSTEAMS_GRAPH_PAGE_MAX), 1), MSTEAMS_GRAPH_PAGE_MAX)
    const oldest = historyBoundMs(options.oldest)
    const latest = historyBoundMs(options.latest)
    const kept: MsTeamsGraphMessage[] = []
    let skiptoken = options.cursor ? msTeamsSkiptoken(options.cursor) : undefined
    let passedOldest = false
    // System events count toward Graph's `$top` but are dropped, so a short page reads on, asking only for what is still missing.
    for (let read = 0; read < HISTORY_FILL_READS && kept.length < top; read += 1) {
      const page = await this.graph.page(source, { top: top - kept.length, ...(skiptoken ? { skiptoken } : {}) })
      // Only a chat lists by creation; a channel lists by its threads' last activity, so an old post never ends its pages.
      passedOldest = source.kind === 'chat' && page.messages.some((m) => oldest !== undefined && m.createdMs < oldest)
      kept.push(
        ...page.messages.filter(
          (m) => (oldest === undefined || m.createdMs >= oldest) && (latest === undefined || m.createdMs <= latest)
        )
      )
      skiptoken = page.skiptoken
      if (!skiptoken || passedOldest) break
    }
    const nextCursor = passedOldest ? undefined : skiptoken
    this.rememberSenders(kept)
    const messages = kept.sort(newestFirst).map((m) => ({
      sender: m.sender,
      ...(m.senderName ? { senderName: m.senderName } : {}),
      ts: m.id,
      text: m.text,
      isBot: m.isBot,
      // Every channel post roots a thread named by its own ID; a group chat has no threads.
      ...(source.kind === 'channel' ? { threadTs: m.id } : {}),
      ...(m.link ? { link: m.link } : {})
    }))
    return { messages, hasMore: nextCursor !== undefined, ...(nextCursor ? { nextCursor } : {}) }
  }

  /** A channel thread's root, then its newest replies within the exclusive bounds, oldest first; best-effort unless `throwOnError`. */
  async getThreadReplies(
    channel: string,
    thread: string,
    maxMessages = 200,
    window?: PlatformThreadWindow
  ): Promise<PlatformThreadMessage[]> {
    try {
      const source = await this.historySource(channel)
      if (source.kind !== 'channel')
        throw new MsTeamsApiError('msteams: a group chat has no threads; read its messages as its history', 'invalid')
      if (!/^\d+$/.test(thread))
        throw new MsTeamsApiError('msteams: a thread is named by its root post’s ID', 'invalid')
      const root = await this.graph.message(source, thread)
      if (!root) throw new MsTeamsApiError('msteams: the thread is not found', 'not_found')
      const cap = Math.max(Math.trunc(maxMessages), 1) - 1
      const oldest = historyBoundMs(window?.oldest)
      const latest = historyBoundMs(window?.latest)
      // Replies come newest first by creation or last change; one last changed before the oldest bound ends the read under either order.
      const replies: MsTeamsGraphMessage[] = []
      let skiptoken: string | undefined
      let passedOldest = false
      while (cap > 0) {
        const page = await this.graph.page(source, {
          rootId: thread,
          top: MSTEAMS_GRAPH_PAGE_MAX,
          ...(skiptoken ? { skiptoken } : {})
        })
        for (const m of page.messages) {
          if (oldest !== undefined && m.modifiedMs <= oldest) passedOldest = true
          if ((oldest === undefined || m.createdMs > oldest) && (latest === undefined || m.createdMs < latest))
            replies.push(m)
        }
        skiptoken = page.skiptoken
        if (!skiptoken || passedOldest || replies.length > cap) break
      }
      if (window?.readState && replies.length > cap) window.readState.truncated = true
      const rows = [root, ...replies.sort(newestFirst).slice(0, cap).reverse()]
      this.rememberSenders(rows)
      return rows.map((m) => this.threadMessage(m))
    } catch (err) {
      this.deps.log?.debug(`msteams: reading a thread failed: ${(err as Error).message}`)
      if (window?.throwOnError) throw err
      return []
    }
  }

  // A history row; this bot's own card is a question or approval, chrome rather than conversation.
  private threadMessage(m: MsTeamsGraphMessage): PlatformThreadMessage {
    return {
      sender: m.sender,
      ...(m.senderName ? { senderName: m.senderName } : {}),
      ts: m.id,
      text: m.text,
      isBot: m.isBot,
      chrome: m.isBot && m.appId === this.appId && m.card,
      ...(m.appId ? { appId: m.appId } : {}),
      attachments: [],
      ...(m.link ? { link: m.link } : {})
    }
  }

  // A person's name a history read carried also answers `getUserProfile`.
  private rememberSenders(rows: readonly MsTeamsGraphMessage[]): void {
    for (const m of rows) if (!m.isBot && m.senderName) remember(this.names, m.sender, m.senderName, NAMES_MAX)
  }

  // Where a seen conversation's messages are read; a 1:1 chat has no history this consent reaches.
  private async historySource(channel: string): Promise<MsTeamsHistorySource> {
    const known = this.conversations.get(channel)
    if (!known) throw new MsTeamsApiError('msteams: the conversation is unknown to this bot', 'not_found')
    if (known.kind === 'chat') return { kind: 'chat', chatId: channel }
    if (known.kind === 'personal') throw new MsTeamsApiError('msteams: a 1:1 chat’s history cannot be read', 'invalid')
    return { kind: 'channel', groupId: await this.groupIdOf(known), channelId: channel }
  }

  // A channel's team as Graph addresses it, its Microsoft 365 group ID, read once per team; a failed read is forgotten.
  private async groupIdOf(known: KnownConversation): Promise<string> {
    if (!known.teamId) throw new MsTeamsApiError('msteams: the channel’s team is unknown', 'not_found')
    const teamId = known.teamId
    let groupId = this.teamGroups.get(teamId)
    if (!groupId) {
      groupId = this.api.teamGroupId(known.serviceUrl, teamId)
      groupId.catch(() => this.teamGroups.delete(teamId))
      remember(this.teamGroups, teamId, groupId, CONVERSATIONS_MAX)
    }
    return await groupId
  }
}

// A history bound as epoch milliseconds; a message ID is one, and seconds are accepted as Slack-style timestamps are.
function historyBoundMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0)
    throw new MsTeamsApiError('msteams: a history bound is a message ID or a timestamp', 'invalid')
  return value < 1e11 ? Math.round(value * 1000) : value
}

function newestFirst(a: MsTeamsGraphMessage, b: MsTeamsGraphMessage): number {
  return b.createdMs - a.createdMs
}

function activityOf(text: string): Record<string, unknown> {
  return { type: 'message', textFormat: MSTEAMS_TEXT_FORMAT, text }
}

// A raw conversation ID's normalized channel: a channel thread drops its `;messageid=` suffix.
function channelOf(conversationId: string): string {
  return conversationId.split(';')[0]!
}

// A posted card's cache key: its conversation and its activity ID, the pair Teams keeps unique.
function cardKey(channel: string, activityId: string): string {
  return `${channel}\u001f${activityId}`
}

function cardActivityOf(card: Record<string, unknown>, summary?: string): Record<string, unknown> {
  return {
    type: 'message',
    attachments: [{ contentType: MSTEAMS_ADAPTIVE_CARD_TYPE, content: card }],
    ...(summary ? { summary } : {})
  }
}
