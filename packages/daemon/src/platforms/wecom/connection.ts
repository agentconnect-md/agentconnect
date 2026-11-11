// One WeCom smart bot's daemon connection: the long connection, inbound hand-off, stream replies and proactive sends.
import { createHash, randomUUID } from 'node:crypto'
import { normalizeWeComMessage, type WeComInboundMessage, type WeComMediaRef } from '@agentconnect.md/message'
import type { LoadedAgent } from '../../agents/load-agents.js'
import type { Logger } from '../../log.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import { splitMarkdownByBytes } from '../../messages/split-markdown-bytes.js'
import type { PlatformChannelInfo, PlatformConnection, PlatformMemberRef, PlatformUserProfile } from '../contract.js'
import { platformIntegrationConfig } from '../integration-config.js'
import {
  WECOM_MSG_CALLBACK,
  WeComClient,
  WeComRequestError,
  WeComTransportError,
  type WeComCallback,
  type WeComClientTiming,
  type WeComSocket
} from './client.js'
import { WeComSendBudget } from './rate-limit.js'

export interface WeComConnectionGroup {
  botId: string
  secret: string
  integrations: { agentId: string; integrationId: string }[]
}

/** A changed Secret or BotID is a new key, so it connects at once instead of waiting out a kick cooldown. */
export function weComConnKey(group: Pick<WeComConnectionGroup, 'botId' | 'secret'>): string {
  return createHash('sha256')
    .update(JSON.stringify([group.botId, group.secret]))
    .digest('hex')
}

// One connection per bot: a second subscribe of the same bot evicts the first (official doc, path 101463).
export function consolidateWeCom(agents: LoadedAgent[]): Map<string, WeComConnectionGroup> {
  const groups = new Map<string, WeComConnectionGroup>()
  for (const agent of agents)
    for (const integration of agent.integrations) {
      const config = platformIntegrationConfig('wecom', integration)
      if (!config) continue
      const key = weComConnKey(config)
      const group = groups.get(key) ?? { botId: config.botId, secret: config.secret, integrations: [] }
      group.integrations.push({ agentId: agent.id, integrationId: integration.id })
      groups.set(key, group)
    }
  return groups
}

/** Markdown and stream content are capped at 20,480 bytes (official doc, path 101463). */
export const WECOM_MARKDOWN_MAX_BYTES = 20_480
// Replies are allowed for 24 hours after a callback (official doc); an hour of margin keeps a long turn clear of the edge.
const REPLY_WINDOW_MS = 23 * 60 * 60 * 1000
// Conservative kick cooldown: the doc says only that a kicked client must not loop, so the reconciler waits 60 s, doubling to 30 min.
export const WECOM_KICK_COOLDOWN_BASE_MS = 60_000
export const WECOM_KICK_COOLDOWN_MAX_MS = 30 * 60_000
// A redialed connection that holds the bot for twice the cap starts its cooldown from the base again.
const KICK_RESET_AFTER_MS = 2 * WECOM_KICK_COOLDOWN_MAX_MS
const SEEN_LIMIT = 2_000
const REPLY_LIMIT = 2_000
const MEDIA_LIMIT = 2_000
const MEMBERS_PER_CHANNEL = 200

/** A callback a turn may answer under its `req_id`; held by the connection, never put in the message. */
export interface WeComReplyHandle {
  reqId: string
  generation: number
  channel: string
  receivedAt: number
}

/** One part of a proactive send; `error` names why it, and every part after it, was not sent. */
export interface WeComSentPart {
  text: string
  error?: unknown
}

/** The sends a turn makes through the connection it leased. */
export interface WeComReplyPort {
  /** The callback this message arrived on, once per message and only inside the reply window; later claims get nothing. */
  claimReply(msgId: string): WeComReplyHandle | undefined
  /** Whether an optional stream refresh fits the conversation's send budget now. */
  refreshFits(channel: string): boolean
  /** Push stream content under the callback's `req_id`; `optional` refreshes skip the budget wait. */
  respondStream(
    handle: WeComReplyHandle,
    stream: { id: string; content: string; finish: boolean },
    optional?: boolean
  ): Promise<void>
  /** Proactive Markdown in parts within the byte cap, one at a time; a refused part leaves the rest unsent. */
  sendMarkdown(channel: string, text: string): Promise<WeComSentPart[]>
}

/** Where a proactive send addresses a conversation: a direct chat by its member's userid, a group by its chatid. */
export function weComSendTarget(channel: string): { chatid: string; chat_type: 1 | 2 } {
  return channel.startsWith('dm:') ? { chatid: channel.slice(3), chat_type: 1 } : { chatid: channel, chat_type: 2 }
}

export interface WeComConnectionDeps {
  onMessage(msg: NormalizedMessage): void
  /** Another connection took the bot over; the reconciler may redial at `redialAt`, never sooner. */
  onKicked?(redialAt: number): void
  log: Logger
  url?: string
  createSocket?(url: string): WeComSocket
  timing?: Partial<WeComClientTiming>
  now?(): number
}

export class WeComConnection implements PlatformConnection, WeComReplyPort {
  readonly botUserId: string
  private readonly client: WeComClient
  private readonly budget: WeComSendBudget
  private readonly seen = new Set<string>()
  private readonly replies = new Map<string, WeComReplyHandle & { claimed: boolean }>()
  // Reference → download material for the attachments PR; the keys never leave this map.
  private readonly media = new Map<string, WeComMediaRef>()
  private readonly channels = new Map<string, { isIm: boolean }>()
  private readonly members = new Map<string, Set<string>>()
  private readonly sendChains = new Map<string, Promise<unknown>>()
  private stopped = false
  private kicks = 0
  private heldSince = 0
  private redialAt?: number
  private downloadRefusalLogged = false

  constructor(
    readonly group: WeComConnectionGroup,
    private readonly deps: WeComConnectionDeps
  ) {
    this.botUserId = group.botId
    const now = deps.now ?? Date.now
    this.budget = new WeComSendBudget(now)
    this.client = new WeComClient({
      botId: group.botId,
      secret: group.secret,
      ...(deps.url ? { url: deps.url } : {}),
      ...(deps.createSocket ? { createSocket: deps.createSocket } : {}),
      ...(deps.timing ? { timing: deps.timing } : {}),
      onCallback: (callback) => this.onCallback(callback),
      onKicked: () => this.onKicked('another connection subscribed this bot, so this one stays down'),
      log: deps.log
    })
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('stopped')
    await this.client.start()
    this.heldSince = this.now()
    this.deps.log.info('wecom: connected')
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.client.stop()
  }

  workspaceId(): string {
    return this.group.botId
  }

  get connected(): boolean {
    return this.client.connected
  }

  /** When a kicked connection may dial again; undefined while it is up or reconnecting by itself. */
  redialDueAt(): number | undefined {
    return this.client.kicked ? this.redialAt : undefined
  }

  /** Dial again after a kick, once its cooldown has passed; a failure counts as another kick for the backoff. */
  async redial(): Promise<void> {
    const due = this.redialDueAt()
    if (this.stopped || due === undefined || this.now() < due) return
    try {
      await this.client.redial()
      this.redialAt = undefined
      this.heldSince = this.now()
      this.deps.log.info('wecom: connected again after a takeover')
    } catch {
      if (!this.stopped) this.onKicked('a redial after a takeover failed')
    }
  }

  private onKicked(reason: string): void {
    const now = this.now()
    if (this.heldSince && now - this.heldSince >= KICK_RESET_AFTER_MS) this.kicks = 0
    const delay = Math.min(WECOM_KICK_COOLDOWN_MAX_MS, WECOM_KICK_COOLDOWN_BASE_MS * 2 ** this.kicks)
    this.kicks++
    this.heldSince = 0
    this.redialAt = now + delay
    this.deps.log.warn(`wecom: ${reason}; the next attempt is in ${Math.round(delay / 1000)} s`)
    this.deps.onKicked?.(this.redialAt)
  }

  private onCallback(callback: WeComCallback): void {
    if (this.stopped) return
    // Events (enter_chat, template_card_event, feedback_event, and any new one) are served by later changes.
    if (callback.cmd !== WECOM_MSG_CALLBACK) return
    const payload = callback.body as WeComInboundMessage
    const msgid = typeof payload.msgid === 'string' ? payload.msgid : undefined
    if (!msgid || this.seen.has(msgid)) return
    this.seen.add(msgid)
    while (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!)
    const msg = this.normalize(payload)
    if (!msg) return
    this.replies.set(msg.msgId, {
      reqId: callback.reqId,
      generation: callback.generation,
      channel: msg.channel,
      receivedAt: this.now(),
      claimed: false
    })
    while (this.replies.size > REPLY_LIMIT) this.replies.delete(this.replies.keys().next().value!)
    this.deps.onMessage(msg)
  }

  /** Normalize one message callback body, keeping its media download material here. */
  normalize(payload: WeComInboundMessage): NormalizedMessage | null {
    let result
    try {
      result = normalizeWeComMessage(payload, { botId: this.group.botId, traceId: randomUUID() })
    } catch {
      this.deps.log.warn('wecom: dropped a message that could not be read')
      return null
    }
    if (!result) return null
    for (const ref of result.media) {
      this.media.delete(ref.ref)
      this.media.set(ref.ref, ref)
    }
    while (this.media.size > MEDIA_LIMIT) this.media.delete(this.media.keys().next().value!)
    const msg = result.message as NormalizedMessage
    this.channels.set(msg.channel, { isIm: msg.isDm })
    const members = this.members.get(msg.channel) ?? new Set<string>()
    members.delete(msg.sender.id)
    members.add(msg.sender.id)
    while (members.size > MEMBERS_PER_CHANNEL) members.delete(members.values().next().value!)
    this.members.set(msg.channel, members)
    return msg
  }

  /** Whether this connection holds download material for an attachment reference. */
  hasMedia(ref: string): boolean {
    return this.media.has(ref)
  }

  claimReply(msgId: string): WeComReplyHandle | undefined {
    const handle = this.replies.get(msgId)
    if (!handle || handle.claimed) return undefined
    handle.claimed = true
    if (this.now() - handle.receivedAt >= REPLY_WINDOW_MS) return undefined
    return {
      reqId: handle.reqId,
      generation: handle.generation,
      channel: handle.channel,
      receivedAt: handle.receivedAt
    }
  }

  refreshFits(channel: string): boolean {
    return this.client.connected && this.budget.refreshFits(channel)
  }

  async respondStream(
    handle: WeComReplyHandle,
    stream: { id: string; content: string; finish: boolean },
    optional = false
  ): Promise<void> {
    if (optional) this.budget.note(handle.channel)
    else await this.budget.take(handle.channel)
    await this.client.respond(handle.reqId, handle.generation, { msgtype: 'stream', stream })
  }

  sendMarkdown(channel: string, text: string): Promise<WeComSentPart[]> {
    const previous = this.sendChains.get(channel) ?? Promise.resolve()
    const run = previous.then(() => this.sendParts(channel, text))
    const settled = run.catch(() => undefined)
    this.sendChains.set(channel, settled)
    void settled.then(() => {
      if (this.sendChains.get(channel) === settled) this.sendChains.delete(channel)
    })
    return run
  }

  /** A short message for chrome and notices; false when WeCom did not take it. */
  async sendText(channel: string, text: string): Promise<boolean> {
    const parts = await this.sendMarkdown(channel, text)
    return parts.length > 0 && parts.every((part) => part.error === undefined)
  }

  private async sendParts(channel: string, text: string): Promise<WeComSentPart[]> {
    const sent: WeComSentPart[] = []
    let failed: unknown
    for (const part of splitMarkdownByBytes(text, WECOM_MARKDOWN_MAX_BYTES)) {
      if (failed !== undefined) {
        sent.push({ text: part, error: failed })
        continue
      }
      try {
        await this.budget.take(channel)
        await this.client.send({ ...weComSendTarget(channel), msgtype: 'markdown', markdown: { content: part } })
        sent.push({ text: part })
      } catch (error) {
        failed = error
        this.deps.log.warn(`wecom: send failed (${sendErrorLabel(error)})`)
        sent.push({ text: part, error })
      }
    }
    return sent
  }

  async getChannelInfo(channel: string): Promise<PlatformChannelInfo> {
    const isIm = this.channels.get(channel)?.isIm ?? channel.startsWith('dm:')
    return { id: channel, isIm, isPrivate: true }
  }

  async listMembers(channel: string): Promise<PlatformMemberRef[]> {
    return [...(this.members.get(channel) ?? [])].map((id) => ({ id, isBot: false }))
  }

  async listChannels() {
    return [...this.channels.keys()].map((id) => ({ id, isPrivate: true }))
  }

  async getUserProfile(user: string): Promise<PlatformUserProfile> {
    return { id: user }
  }

  // Attachment download and decryption arrive with the attachments change; until then every reference reads as unavailable.
  async downloadFile(_ref: string, _maxBytes?: number): Promise<Buffer | null> {
    if (!this.downloadRefusalLogged) this.deps.log.warn('wecom: attachment download is not available yet')
    this.downloadRefusalLogged = true
    return null
  }
}

/** A send failure as a log line names it: WeCom's code, or the transport's reason; never the content. */
export function sendErrorLabel(error: unknown): string {
  if (error instanceof WeComRequestError) return `errcode ${error.errcode}`
  if (error instanceof WeComTransportError)
    return error.maybeDelivered ? 'no answer; may have been delivered' : 'not sent'
  return error instanceof Error ? error.message : 'unknown error'
}
