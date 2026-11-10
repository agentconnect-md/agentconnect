// One iLink bot's daemon connection: the long poll, plain-text sends, reply tokens and received media (wechat-integration.md §3, §4).
import { createHash, randomUUID } from 'node:crypto'
import {
  normalizeWeChatMessage,
  weChatDmChannel,
  weChatQuote,
  type WeChatInboundMessage,
  type WeChatMediaRef,
  type WeChatQuoteRef
} from '@agentconnect.md/message'
import type { QuotedMessage } from '@agentconnect.md/protocol'
import type { LoadedAgent } from '../../agents/load-agents.js'
import type { Logger } from '../../log.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { PlatformChannelInfo, PlatformConnection, PlatformMemberRef, PlatformUserProfile } from '../contract.js'
import { platformIntegrationConfig } from '../integration-config.js'
import { WeChatApi, WeChatApiError, WeChatTransportError, type WeChatApiOptions } from './api.js'
import { WECHAT_ATTACHMENT_TOOL } from './attachments.js'
import { downloadWeChatMedia } from './media.js'
import { WeChatPoller, type WeChatPollerDeps } from './poller.js'
import { resolveWeChatPartial, WECHAT_QUOTE_UNAVAILABLE } from './quote.js'
import type { WeChatStatePort } from './state.js'
import { splitWeChatText } from './text.js'

export interface WeChatConnectionGroup {
  botId: string
  botToken: string
  boundUserId: string
  apiUrl?: string
  cdnUrl?: string
  integrations: { agentId: string; integrationId: string }[]
}

type WeChatIdentity = Pick<WeChatConnectionGroup, 'botId' | 'botToken' | 'boundUserId' | 'apiUrl' | 'cdnUrl'>

export function weChatConnKey(group: WeChatIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify([group.botId, group.botToken, group.boundUserId, group.apiUrl ?? '', group.cdnUrl ?? '']))
    .digest('hex')
}

// One connection per bot: iLink delivers every message to every poller, so a bot is never polled twice (§3.2).
export function consolidateWeChat(
  agents: LoadedAgent[],
  overrides: { apiUrl?: string; cdnUrl?: string } = {}
): Map<string, WeChatConnectionGroup> {
  const groups = new Map<string, WeChatConnectionGroup>()
  for (const agent of agents)
    for (const integration of agent.integrations) {
      const config = platformIntegrationConfig('wechat', integration)
      if (!config) continue
      const identity: WeChatIdentity = {
        botId: config.botId,
        botToken: config.botToken,
        boundUserId: config.boundUserId,
        ...((overrides.apiUrl ?? config.apiUrl) ? { apiUrl: overrides.apiUrl ?? config.apiUrl } : {}),
        ...((overrides.cdnUrl ?? config.cdnUrl) ? { cdnUrl: overrides.cdnUrl ?? config.cdnUrl } : {})
      }
      const key = weChatConnKey(identity)
      const group = groups.get(key) ?? { ...identity, integrations: [] }
      group.integrations.push({ agentId: agent.id, integrationId: integration.id })
      groups.set(key, group)
    }
  return groups
}

/** One part of a sent answer; `error` names why it, and every part after it, was not sent. */
export interface WeChatSentPart {
  text: string
  messageId?: string
  error?: unknown
}

/** A turn's way to cut its own sends short once it is stopped; the shared connection stays open. */
export interface WeChatSendOptions {
  stopped?(): boolean
}

/** The sends a turn makes through the connection it leased. */
export interface WeChatReplyPort {
  sendText(channel: string, text: string, options?: WeChatSendOptions): Promise<WeChatSentPart[]>
}

/** The error a part carries when its turn was stopped before it went out. */
export const WECHAT_SEND_STOPPED = new Error('wechat: turn stopped; not sent')

const MEDIA_LIMIT = 2_000
const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

export class WeChatConnection implements PlatformConnection, WeChatReplyPort {
  readonly botUserId: string
  private readonly abort = new AbortController()
  private readonly api: WeChatApi
  private readonly poller: WeChatPoller
  // Reference → download material; the keys never leave this map (§4.6).
  private readonly media = new Map<string, WeChatMediaRef>()
  private contextToken?: string
  private sends: Promise<unknown> = Promise.resolve()
  private inbound: Promise<void> = Promise.resolve()
  private foreignSenderLogged = false

  constructor(
    readonly group: WeChatConnectionGroup,
    private readonly deps: {
      onMessage(msg: NormalizedMessage): void
      /** iLink refused the token (-14): the bot needs a re-scan (§2.3). */
      onTokenRejected?(): void
      state: WeChatStatePort
      log: Logger
      fetchImpl?: typeof fetch
      version?: string
      sleep?: WeChatPollerDeps['sleep']
    }
  ) {
    this.botUserId = group.botId
    const options: WeChatApiOptions = { signal: this.abort.signal }
    if (deps.fetchImpl) options.fetchImpl = deps.fetchImpl
    if (deps.version) options.version = deps.version
    this.api = new WeChatApi({ botToken: group.botToken, ...(group.apiUrl ? { apiUrl: group.apiUrl } : {}) }, options)
    this.poller = new WeChatPoller({
      api: this.api,
      state: deps.state,
      botId: group.botId,
      onMessage: (payload) => this.onPayload(payload),
      onStaleToken: () => deps.onTokenRejected?.(),
      log: deps.log,
      ...(deps.sleep ? { sleep: deps.sleep } : {})
    })
  }

  get channel(): string {
    return weChatDmChannel(this.group.boundUserId)
  }

  async start(): Promise<void> {
    this.abort.signal.throwIfAborted()
    const stored = await this.deps.state.load(this.group.botId)
    this.contextToken ??= stored.contextToken
    await this.poller.start()
    this.deps.log.info('wechat: polling')
  }

  async stop(): Promise<void> {
    await this.poller.stop()
    await this.settled()
    this.abort.abort()
  }

  /** Resolves once every polled message so far has been handed on or dropped. */
  settled(): Promise<void> {
    return this.inbound
  }

  workspaceId(): string {
    return this.group.botId
  }

  // Serialized, so a quote lookup never lets a later message of the same batch overtake this one.
  private onPayload(payload: WeChatInboundMessage): Promise<void> {
    return (this.inbound = this.inbound
      .then(async () => {
        if (this.abort.signal.aborted) return
        const prepared = this.prepare(payload)
        if (!prepared) return
        const { message: msg, quoteRef, record } = prepared
        if (quoteRef) msg.quoted = await this.resolveQuote(quoteRef)
        if (this.abort.signal.aborted) return
        await this.remember(record.messageId, record.text)
        this.deps.onMessage(msg)
      })
      .catch((error: unknown) => {
        this.deps.log.warn(`wechat: dropped a message (${error instanceof Error ? error.message : 'unknown error'})`)
      }))
  }

  // A quote naming only an id reads its text from this bot's record; an aged-out one says so, never guesses (§4.3).
  private async resolveQuote(ref: WeChatQuoteRef): Promise<QuotedMessage> {
    const text = await this.deps.state.messageText(this.group.botId, ref.messageId).catch(() => undefined)
    if (!text) return weChatQuote(WECHAT_QUOTE_UNAVAILABLE, ref.messageId)
    const selection = ref.partial ? resolveWeChatPartial(text, ref.partial) : undefined
    return weChatQuote(selection ?? text, ref.messageId, selection !== undefined)
  }

  private async remember(messageId: string, text: string): Promise<void> {
    if (!text.trim()) return
    await this.deps.state.rememberMessage(this.group.botId, messageId, text).catch(() => {
      this.deps.log.warn('wechat: could not record a message for quotes')
    })
  }

  /** Normalize one polled message from the bound user, keeping its reply token and media keys here (§4.1, §4.5). */
  normalize(payload: WeChatInboundMessage): NormalizedMessage | null {
    return this.prepare(payload)?.message ?? null
  }

  private prepare(
    payload: WeChatInboundMessage
  ): { message: NormalizedMessage; quoteRef?: WeChatQuoteRef; record: { messageId: string; text: string } } | null {
    if (payload.message_type === 1 && payload.from_user_id && payload.from_user_id !== this.group.boundUserId) {
      // iLink should never deliver one (§1.1); admitting it would hand the agent to someone nobody bound.
      if (!this.foreignSenderLogged)
        this.deps.log.warn('wechat: dropped a message from a user this bot is not bound to')
      this.foreignSenderLogged = true
      return null
    }
    const result = normalizeWeChatMessage(payload, {
      botId: this.group.botId,
      boundUserId: this.group.boundUserId,
      traceId: randomUUID()
    })
    if (!result) return null
    this.rememberContextToken(payload.context_token)
    for (const ref of result.media) {
      this.media.delete(ref.ref)
      this.media.set(ref.ref, ref)
    }
    while (this.media.size > MEDIA_LIMIT) this.media.delete(this.media.keys().next().value!)
    const msg = result.message as NormalizedMessage
    for (const attachment of msg.attachments ?? []) attachment.readerToolName = WECHAT_ATTACHMENT_TOOL.name
    return { message: msg, ...(result.quoteRef ? { quoteRef: result.quoteRef } : {}), record: result.record }
  }

  // The latest token rides every send; it is a reply credential, never logged and never sent to the Control Plane.
  private rememberContextToken(token: unknown): void {
    if (typeof token !== 'string' || !token || token === this.contextToken) return
    this.contextToken = token
    void this.deps.state.saveContextToken(this.group.botId, token).catch(() => {
      this.deps.log.warn('wechat: could not store the reply token')
    })
  }

  async getChannelInfo(channel: string): Promise<PlatformChannelInfo> {
    return { id: channel, name: 'WeChat', isIm: true, isPrivate: true }
  }

  async listMembers(channel: string): Promise<PlatformMemberRef[]> {
    return channel === this.channel ? [{ id: this.group.boundUserId, isBot: false }] : []
  }

  async listChannels() {
    return [{ id: this.channel, name: 'WeChat', isPrivate: true }]
  }

  async getUserProfile(user: string): Promise<PlatformUserProfile> {
    return { id: user }
  }

  /** A received attachment's plaintext by its reference (§4.6); null for a reference this connection never received. */
  async downloadFile(ref: string, maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES): Promise<Buffer | null> {
    const media = this.media.get(ref)
    if (!media) {
      this.deps.log.warn('wechat: attachment download refused (unknown_reference)')
      return null
    }
    const deps = {
      signal: this.abort.signal,
      ...(this.group.cdnUrl ? { cdnUrl: this.group.cdnUrl } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {})
    }
    return downloadWeChatMedia(deps, media, maxBytes, (reason) =>
      this.deps.log.warn(`wechat: attachment download failed (${reason})`)
    )
  }

  /** Send an answer as plain-text messages, one at a time and never resent; a failure leaves the rest unsent (§4.4). */
  sendText(channel: string, text: string, options: WeChatSendOptions = {}): Promise<WeChatSentPart[]> {
    const run = this.sends.then(() => this.sendParts(channel, text, options))
    this.sends = run.catch(() => undefined)
    return run
  }

  private async sendParts(channel: string, text: string, options: WeChatSendOptions): Promise<WeChatSentPart[]> {
    const parts = splitWeChatText(text)
    // The bot has one counterpart; any other address is a routing error, never a send.
    if (channel !== this.channel) return parts.map((part) => ({ text: part, error: new Error('wechat: unknown chat') }))
    const sent: WeChatSentPart[] = []
    let failed: unknown
    for (const part of parts) {
      // Checked when a queued send starts and before each part, so a stop leaves the rest unsent and its receipt waits on one part at most.
      if (failed === undefined && options.stopped?.()) failed = WECHAT_SEND_STOPPED
      if (failed !== undefined) {
        sent.push({ text: part, error: failed })
        continue
      }
      try {
        // A fresh client id per message: iLink silently drops a repeated one (§4.4).
        const messageId = await this.api.sendText(this.group.boundUserId, `ac-${randomUUID()}`, part, this.contextToken)
        sent.push({ text: part, ...(messageId ? { messageId } : {}) })
        if (messageId) await this.remember(messageId, part)
      } catch (error) {
        failed = error
        const reason =
          error instanceof WeChatTransportError && error.timedOut
            ? 'timed out; not resent'
            : error instanceof Error
              ? error.message
              : 'unknown error'
        this.deps.log.warn(`wechat: send failed (${reason})`)
        if (error instanceof WeChatApiError && error.staleToken) this.deps.onTokenRejected?.()
        sent.push({ text: part, error })
      }
    }
    return sent
  }
}

/** Deployment overrides of the iLink endpoints, read once at daemon start (§6). */
export function weChatEndpointOverrides(env: NodeJS.ProcessEnv = process.env): { apiUrl?: string; cdnUrl?: string } {
  const apiUrl = env.AGENTCONNECT_WECHAT_API_URL?.trim()
  const cdnUrl = env.AGENTCONNECT_WECHAT_CDN_URL?.trim()
  return { ...(apiUrl ? { apiUrl } : {}), ...(cdnUrl ? { cdnUrl } : {}) }
}
