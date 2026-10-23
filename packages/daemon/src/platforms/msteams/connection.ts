// One Teams bot's daemon connection (teams-integration.md §3, §4.3): relay-terminated ingress, Bot Connector egress, no socket.
import { createHash } from 'node:crypto'
import { MSTEAMS_PLATFORM, type IntegrationMsTeamsConfig } from '@agentconnect.md/protocol'
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
  type MsTeamsTarget
} from './api.js'
import {
  MSTEAMS_GRAPH_PAGE_MAX,
  MsTeamsGraph,
  msTeamsSkiptoken,
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
  /** Team → its channel names and when they were read; a read in flight is shared. */
  private readonly teamChannels = new Map<string, { at: number; names: Promise<Map<string, string>> }>()
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

  // ── 3. read port: members from the Bot Connector, else observed from traffic ──

  async getChannelInfo(channel: string): Promise<PlatformChannelInfo> {
    const known = this.conversations.get(channel)
    const isIm = known ? known.kind === 'personal' : channel.startsWith('a:')
    // A channel's name follows its team's list, refreshed after the TTL; the last one read stands while a refresh fails.
    const name = known?.kind === 'channel' ? ((await this.channelName(channel, known)) ?? known.name) : known?.name
    return { id: channel, ...(name ? { name } : {}), isIm, isPrivate: true }
  }

  // A channel's name from its team's channel list, read at most once per TTL per team; a failed read names nothing.
  private async channelName(channel: string, known: KnownConversation): Promise<string | undefined> {
    const { teamId, serviceUrl } = known
    if (!teamId) return undefined
    let entry = this.teamChannels.get(teamId)
    if (!entry || this.now() - entry.at > TEAM_CHANNELS_TTL_MS) {
      const names = this.api.teamChannels(serviceUrl, teamId).then(
        (channels) => new Map(channels.map((c) => [c.id, c.name ?? DEFAULT_CHANNEL_NAME])),
        (err: unknown) => {
          this.deps.log?.debug(`msteams: reading a team's channels failed: ${(err as Error).message}`)
          return new Map<string, string>()
        }
      )
      entry = { at: this.now(), names }
      remember(this.teamChannels, teamId, entry, CONVERSATIONS_MAX)
    }
    const name = (await entry.names).get(channel)
    const current = this.conversations.get(channel)
    if (name && current) remember(this.conversations, channel, { ...current, name }, CONVERSATIONS_MAX)
    return name
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
      const members = this.api.conversationMembers(known.serviceUrl, channel, ROSTER_MAX).then(
        (list) =>
          list.map(({ id, aadObjectId, name }) => ({
            id: aadObjectId ?? id,
            ...(name ? { name } : {}),
            isBot: id.startsWith('28:')
          })),
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
    const page = await this.graph.page(source, {
      top,
      ...(options.cursor ? { skiptoken: msTeamsSkiptoken(options.cursor) } : {})
    })
    const nextCursor = page.messages.some((m) => oldest !== undefined && m.createdMs < oldest)
      ? undefined
      : page.skiptoken
    const messages = page.messages
      .filter((m) => (oldest === undefined || m.createdMs >= oldest) && (latest === undefined || m.createdMs <= latest))
      .sort(newestFirst)
      .map((m) => ({
        sender: m.sender,
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
      // Graph answers replies newest first, so pages are read only until the cap or the oldest bound is passed.
      const replies: MsTeamsGraphMessage[] = []
      let skiptoken: string | undefined
      let passedOldest = false
      while (cap > 0) {
        const page = await this.graph.page(source, {
          rootId: thread,
          top: MSTEAMS_GRAPH_PAGE_MAX,
          ...(skiptoken ? { skiptoken } : {})
        })
        for (const m of page.messages.sort(newestFirst)) {
          if (oldest !== undefined && m.createdMs <= oldest) passedOldest = true
          else if (latest === undefined || m.createdMs < latest) replies.push(m)
        }
        skiptoken = page.skiptoken
        if (!skiptoken || passedOldest || replies.length > cap) break
      }
      if (window?.readState && replies.length > cap) window.readState.truncated = true
      return [root, ...replies.slice(0, cap).reverse()].map((m) => this.threadMessage(m))
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
      ts: m.id,
      text: m.text,
      isBot: m.isBot,
      chrome: m.isBot && m.appId === this.appId && m.card,
      ...(m.appId ? { appId: m.appId } : {}),
      attachments: [],
      ...(m.link ? { link: m.link } : {})
    }
  }

  // Where a seen conversation's messages are read; a 1:1 chat has no history this consent reaches.
  private async historySource(channel: string): Promise<MsTeamsHistorySource> {
    const known = this.conversations.get(channel)
    if (!known) throw new MsTeamsApiError('msteams: the conversation is unknown to this bot', 'not_found')
    if (known.kind === 'chat') return { kind: 'chat', chatId: channel }
    if (known.kind === 'personal') throw new MsTeamsApiError('msteams: a 1:1 chat’s history cannot be read', 'invalid')
    if (!known.teamId) throw new MsTeamsApiError('msteams: the channel’s team is unknown', 'not_found')
    let groupId = this.teamGroups.get(known.teamId)
    if (!groupId) {
      const teamId = known.teamId
      groupId = this.api.teamGroupId(known.serviceUrl, teamId)
      groupId.catch(() => this.teamGroups.delete(teamId))
      remember(this.teamGroups, teamId, groupId, CONVERSATIONS_MAX)
    }
    return { kind: 'channel', groupId: await groupId, channelId: channel }
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
