import { createHash } from 'node:crypto'
import type { NormalizedPlatformMessage } from '@agentconnect.md/protocol'
import type { LoadedAgent } from '../../agents/load-agents.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { Logger } from '../../log.js'
import type { PlatformConnection } from '../contract.js'
import { platformIntegrationConfig } from '../integration-config.js'
import { loadWeixinProtocol } from './sdk.js'
import { normalizeWeixinEvent, parseWeixinUserId } from './message.js'
import type { IlinkBot } from './vendor/sdk/ilink-bot.js'
import type { NormalizedChatEvent } from './vendor/sdk/protocol/chat-event.js'

export interface WeixinConnectionGroup {
  accountId: string
  botToken: string
  baseUrl?: string
  integrations: { agentId: string; integrationId: string }[]
}

export function WeixinConnKey(group: Pick<WeixinConnectionGroup, 'accountId' | 'botToken'>): string {
  return createHash('sha256')
    .update(JSON.stringify([group.accountId, group.botToken]))
    .digest('hex')
}

export function consolidateWeixin(agents: LoadedAgent[]): Map<string, WeixinConnectionGroup> {
  const groups = new Map<string, WeixinConnectionGroup>()
  for (const agent of agents)
    for (const integration of agent.integrations) {
      const config = platformIntegrationConfig('weixin', integration)
      if (!config) continue
      const key = WeixinConnKey(config)
      const group = groups.get(key) ?? { ...config, integrations: [] }
      group.integrations.push({ agentId: agent.id, integrationId: integration.id })
      groups.set(key, group)
    }
  return groups
}

export interface WeixinConnectionDeps {
  log: Logger
  onMessage(msg: NormalizedMessage): void
}

export class WeixinConnection implements PlatformConnection {
  readonly botUserId: string
  private bot?: IlinkBot
  private readonly abort = new AbortController()
  private readonly channels = new Set<string>()
  private readonly mediaIndex = new Map<string, { messageId: string; itemIndex: number }>()

  constructor(
    readonly group: WeixinConnectionGroup,
    private readonly deps: WeixinConnectionDeps
  ) {
    this.botUserId = group.accountId
  }

  async start(): Promise<void> {
    if (this.bot) return
    this.abort.signal.throwIfAborted()
    const { IlinkBot } = await loadWeixinProtocol()
    const bot = new IlinkBot({
      token: this.group.botToken,
      accountId: this.group.accountId,
      ...(this.group.baseUrl ? { baseUrl: this.group.baseUrl } : {})
    })
    this.bot = bot
    bot.on('message', (event: NormalizedChatEvent) => {
      if (this.abort.signal.aborted) return
      const msg = this.normalizeMessage(event)
      if (!msg) return
      this.channels.add(msg.channel)
      this.deps.onMessage(msg)
    })
    bot.on('polling_error', (error: unknown) => {
      this.deps.log.warn(`weixin: polling error (loop retries): ${String(error)}`)
    })
    bot.on('credential_stale', (error: unknown) => {
      this.deps.log.warn(`weixin: iLink credential stale — the bot needs a fresh QR login: ${String(error)}`)
    })
    this.deps.log.info(`weixin: starting iLink long-poll, account=${this.group.accountId}`)
    // Resolves once the loop is armed; the long-running poll lives inside the bot
    // (`pollLoop`) and surfaces failures through the `polling_error` event.
    await bot.startPolling({ signal: this.abort.signal })
  }

  async stop(): Promise<void> {
    this.abort.abort()
    try {
      await this.bot?.stopPolling()
    } catch {
      // best-effort teardown
    }
  }

  workspaceId(): string {
    return this.group.accountId
  }

  normalizeMessage(event: NormalizedChatEvent): NormalizedMessage | null {
    const msg = normalizeWeixinEvent(this.group.accountId, event) as NormalizedMessage | null
    if (!msg) return null
    // index ilink-media refs so `downloadFile` can resolve them through the bot's
    // CDN decrypt path without parsing adapterExt again.
    for (const attachment of msg.attachments ?? []) {
      if (!attachment.sourceUrl?.startsWith('ilink-media:')) continue
      const itemIndex = Number(attachment.id.split(':').pop() ?? '0')
      this.mediaIndex.set(attachment.sourceUrl, {
        messageId: attachment.id.slice(0, attachment.id.lastIndexOf(':')),
        itemIndex
      })
      while (this.mediaIndex.size > 2000) this.mediaIndex.delete(this.mediaIndex.keys().next().value!)
    }
    return msg
  }

  async getChannelInfo(channel: string) {
    const peer = channel.startsWith('dm:') ? channel.slice(3) : channel
    return { id: channel, name: `微信用户 · ${peer.slice(-8)}`, isIm: true, isPrivate: true }
  }

  async listMembers() {
    return []
  }

  async listChannels() {
    return [...this.channels].map((id) => ({ id, isPrivate: true }))
  }

  async getUserProfile(user: string) {
    const identity = parseWeixinUserId(user)
    if (!identity || identity.accountId !== this.group.accountId) return { id: user }
    return { id: user }
  }

  async getChannelHistory(): Promise<never> {
    // iLink exposes no history read API.
    throw new Error('weixin: no channel history')
  }

  async downloadFile(source: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer | null> {
    if (!source.startsWith('ilink-media:')) return null
    const ref = this.mediaIndex.get(source)
    if (!ref || !this.bot) return null
    try {
      const result = await this.bot.downloadRecentMedia(ref.messageId, ref.itemIndex)
      if (result.buffer.length > maxBytes) return null
      return result.buffer
    } catch (error) {
      this.deps.log.warn(`weixin: media download failed for ${source}: ${String(error)}`)
      return null
    }
  }

  /** The turn output's egress: text reply to one peer. context_token routing is
   *  owned inside the vendored SDK (it memorizes the inbound token per peer). */
  async sendText(channel: string, text: string): Promise<{ messageId: string }> {
    if (!this.bot) throw new Error('weixin: connection not started')
    const peer = channel.startsWith('dm:') ? channel.slice(3) : channel
    return this.bot.sendTextToUser(peer, text)
  }

  async sendTyping(channel: string): Promise<void> {
    if (!this.bot) return
    const peer = channel.startsWith('dm:') ? channel.slice(3) : channel
    await this.bot.sendTypingToUser(peer).catch(() => undefined)
  }
}
