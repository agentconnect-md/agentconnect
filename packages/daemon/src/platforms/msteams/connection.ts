// One Teams bot's daemon connection (teams-integration.md §3, §4.3): relay-terminated ingress, Bot Connector egress, no socket.
import { createHash } from 'node:crypto'
import { MSTEAMS_PLATFORM, type IntegrationMsTeamsConfig } from '@agentconnect.md/protocol'
import type { Agent } from '../../agents/agent-schema.js'
import type { Logger } from '../../log.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import { splitMarkdownByBytes } from '../../messages/split-markdown-bytes.js'
import type {
  PlatformChannelInfo,
  PlatformChannelRef,
  PlatformConnection,
  PlatformMemberRef,
  PlatformUserProfile
} from '../contract.js'
import { platformIntegrationConfig } from '../integration-config.js'
import { PlatformSendQueue } from '../send-queue.js'
import type { WriteBudget } from '../write-budget.js'
import {
  MSTEAMS_TEXT_FORMAT,
  MSTEAMS_WRITE_TIMEOUT_MS,
  MsTeamsApi,
  MsTeamsApiError,
  type MsTeamsTarget
} from './api.js'

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
  /** A 1:1 chat's counterpart; group chats and channels arrive unnamed. */
  name?: string
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
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly sendIntervalMs: number
  /** One write queue per raw conversation ID (§4.3): Microsoft's limits are per bot per conversation. */
  private readonly queues = new Map<string, PlatformSendQueue>()
  /** Normalized channel → what its traffic told us; the serviceUrl is read from activities, never built (§3). */
  private readonly conversations = new Map<string, KnownConversation>()
  private readonly members = new Map<string, Map<string, string | undefined>>()
  private readonly names = new Map<string, string>()
  /** Card activity ID → where it landed, so its replacement addresses the very conversation, thread included. */
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
    const name = kind === 'personal' ? msg.sender.name : this.conversations.get(msg.channel)?.name
    remember(
      this.conversations,
      msg.channel,
      { serviceUrl: target.serviceUrl, kind, ...(name ? { name } : {}) },
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
    remember(this.cards, id, target, CARDS_MAX)
    return id
  }

  /** Replace a posted card in place; one this process did not post is found by its conversation, else left as it is. */
  async replaceCard(
    activityId: string,
    card: Record<string, unknown>,
    at: { channel: string; thread?: string }
  ): Promise<void> {
    const target = this.cards.get(activityId) ?? this.targetFor(at.channel, at.thread)
    if (!target) throw new MsTeamsApiError('msteams: the card’s conversation is unknown', 'not_found')
    await this.write(target, () => this.api.updateActivity(target, activityId, cardActivityOf(card)))
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

  // ── 3. read port: membership is observed from traffic, never enumerated ──

  async getChannelInfo(channel: string): Promise<PlatformChannelInfo> {
    const known = this.conversations.get(channel)
    const isIm = known ? known.kind === 'personal' : channel.startsWith('a:')
    return { id: channel, ...(known?.name ? { name: known.name } : {}), isIm, isPrivate: true }
  }

  async listMembers(channel: string): Promise<PlatformMemberRef[]> {
    return [...(this.members.get(channel) ?? [])].map(([id, name]) => ({ id, ...(name ? { name } : {}), isBot: false }))
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
}

function activityOf(text: string): Record<string, unknown> {
  return { type: 'message', textFormat: MSTEAMS_TEXT_FORMAT, text }
}

function cardActivityOf(card: Record<string, unknown>, summary?: string): Record<string, unknown> {
  return {
    type: 'message',
    attachments: [{ contentType: MSTEAMS_ADAPTIVE_CARD_TYPE, content: card }],
    ...(summary ? { summary } : {})
  }
}
