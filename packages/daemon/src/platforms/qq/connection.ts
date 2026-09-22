import { createHash, randomUUID } from 'node:crypto'
import { normalizeQQMessage, parseQQUserId, QQAvatarUrl, type QQMessageEvent } from '@agentconnect.md/message'
import type { LoadedAgent } from '../../agents/load-agents.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { Logger } from '../../log.js'
import type { PlatformConnection } from '../contract.js'
import { platformIntegrationConfig } from '../integration-config.js'
import { QQSender, QQTargetForChannel, type QQRestPort, type QQStreamCursor } from './sender.js'
import { QQ_ATTACHMENT_TOOL } from './attachments.js'
import { downloadQQAttachment, downloadQQImage } from './images.js'
import type { ImageUploader, UploadOutcome } from '../../mcp/ops/context.js'
import { QQReferences } from './references.js'
import { loadQQProtocol } from './sdk.js'
import type { QQProtocol } from './sdk.js'

export interface QQConnectionGroup {
  appId: string
  appSecret: string
  integrations: { agentId: string; integrationId: string }[]
}

export function QQConnKey(group: Pick<QQConnectionGroup, 'appId' | 'appSecret'>): string {
  return createHash('sha256')
    .update(JSON.stringify([group.appId, group.appSecret]))
    .digest('hex')
}

export function consolidateQQ(agents: LoadedAgent[]): Map<string, QQConnectionGroup> {
  const groups = new Map<string, QQConnectionGroup>()
  for (const agent of agents)
    for (const integration of agent.integrations) {
      const config = platformIntegrationConfig('qq', integration)
      if (!config) continue
      const key = QQConnKey(config)
      const group = groups.get(key) ?? { ...config, integrations: [] }
      group.integrations.push({ agentId: agent.id, integrationId: integration.id })
      groups.set(key, group)
    }
  return groups
}

export class QQConnection implements PlatformConnection {
  readonly botUserId: string
  private tokens?: InstanceType<QQProtocol['TokenManager']>
  private readonly abort = new AbortController()
  private api?: QQRestPort
  private loop?: Promise<void>
  private sender?: QQSender
  private readonly channels = new Set<string>()
  private readonly references = new QQReferences()
  private readonly attachmentTypes = new Map<string, string>()

  constructor(
    readonly group: QQConnectionGroup,
    private readonly deps: {
      onMessage(msg: NormalizedMessage): void
      log: Logger
      api?: QQRestPort
      token?: () => Promise<string>
      fetchImpl?: typeof fetch
    }
  ) {
    this.botUserId = group.appId
    this.api = deps.api
    if (this.api) this.sender = this.createSender(this.api)
  }

  private createSender(api: QQRestPort): QQSender {
    return new QQSender(
      api,
      () => this.token(),
      this.abort.signal,
      (message) => this.deps.log.warn(message),
      (message) => this.deps.log.info(message),
      this.deps.fetchImpl,
      (target, receipt, content) =>
        this.references.remember(
          `${target.kind === 'c2c' ? 'dm' : 'group'}:${target.id}`,
          [receipt.ext_info?.ref_idx, receipt.id],
          { messageId: receipt.id, sender: 'QQ bot', content }
        )
    )
  }

  private async ensureProtocol(): Promise<QQProtocol> {
    const protocol = await loadQQProtocol()
    this.api ??= new protocol.ApiClient({ defaultTimeoutMs: 15_000 })
    this.tokens ??= new protocol.TokenManager()
    this.sender ??= this.createSender(this.api)
    return protocol
  }

  private token(): Promise<string> {
    if (this.deps.token) return this.deps.token()
    return this.ensureProtocol().then(() => this.tokens!.getAccessToken(this.group.appId, this.group.appSecret))
  }

  async start(): Promise<void> {
    if (this.loop) return
    this.abort.signal.throwIfAborted()
    const { GatewayConnection } = await this.ensureProtocol()
    const tokens = this.tokens!
    const stopped = new Promise<void>((resolve) =>
      this.abort.signal.addEventListener('abort', () => resolve(), { once: true })
    )
    const gateway = new GatewayConnection({
      account: { accountId: this.group.appId, appId: this.group.appId, clientSecret: this.group.appSecret },
      abortSignal: this.abort.signal,
      intents: 1 << 25,
      getAccessToken: async () => {
        this.abort.signal.throwIfAborted()
        try {
          return await this.token()
        } catch (error) {
          if (!this.abort.signal.aborted) this.deps.log.warn('qq: token request failed; gateway will retry')
          throw error
        }
      },
      clearTokenCache: () => tokens.clearCache(),
      getGatewayUrl: async (token) => {
        this.abort.signal.throwIfAborted()
        try {
          const { url } = await this.api!.request<{ url: string }>(token, 'GET', '/gateway')
          this.abort.signal.throwIfAborted()
          return url
        } catch (error) {
          if (!this.abort.signal.aborted) this.deps.log.warn('qq: gateway discovery failed; gateway will retry')
          throw error
        }
      },
      onReady: () => this.deps.log.info('qq: gateway ready'),
      onResumed: () => this.deps.log.info('qq: gateway resumed'),
      onError: () => this.deps.log.warn('qq: gateway connection failed; reconnecting'),
      onMessage: (event) => {
        if (this.abort.signal.aborted) return
        const msg = this.normalizeMessage(event)
        if (!msg) return
        for (const attachment of msg.attachments ?? []) {
          if (attachment.mimeType.startsWith('image/'))
            attachment.unavailableText =
              '[QQ image unavailable: the image could not be downloaded within the size limit, its format is unsupported, or this agent cannot accept image input. Ask the user to resend a PNG, JPEG or WEBP image or select an image-capable agent.]'
        }
        this.channels.add(msg.channel)
        this.deps.onMessage(msg)
      }
    })
    // SDK logging is omitted because gateway debug output contains raw message payloads.
    this.loop = Promise.race([gateway.start(), stopped]).catch(() =>
      this.deps.log.warn('qq: gateway stopped unexpectedly')
    )
  }

  normalizeMessage(event: QQMessageEvent): NormalizedMessage | null {
    const channel = event.kind === 'c2c' ? `dm:${event.senderId}` : `group:${event.groupOpenid}`
    const reference = event.refMsgIdx ? this.references.get(channel, event.refMsgIdx) : undefined
    const msg = normalizeQQMessage(this.group.appId, event, randomUUID(), reference) as NormalizedMessage | null
    if (!msg) return null
    for (const attachment of msg.attachments ?? []) {
      attachment.readerToolName = QQ_ATTACHMENT_TOOL.name
      if (!attachment.sourceUrl) continue
      this.attachmentTypes.delete(attachment.sourceUrl)
      this.attachmentTypes.set(attachment.sourceUrl, attachment.mimeType)
    }
    while (this.attachmentTypes.size > 2000) this.attachmentTypes.delete(this.attachmentTypes.keys().next().value!)
    this.references.remember(channel, [event.msgIdx, event.messageId], {
      messageId: event.messageId,
      sender: event.senderName ?? event.senderId,
      content: msg.text,
      attachments: event.attachments
    })
    return msg
  }

  async stop(): Promise<void> {
    this.abort.abort()
    this.tokens?.stopBackgroundRefresh()
    await this.loop
    this.tokens?.clearCache()
  }

  workspaceId(): string {
    return this.group.appId
  }
  // QQ exposes no group name and may omit user names, so fallback rows use the OpenID tail.
  async getChannelInfo(channel: string) {
    const target = QQTargetForChannel(channel)
    const isIm = target.kind === 'c2c'
    return { id: channel, name: `${isIm ? 'QQ user' : 'QQ group'} · ${target.id.slice(-8)}`, isIm, isPrivate: true }
  }
  async listMembers() {
    return []
  }
  async listChannels() {
    return [...this.channels].map((id) => ({ id, isPrivate: true }))
  }
  async getUserProfile(user: string) {
    const identity = parseQQUserId(user)
    if (!identity || identity.appId !== this.group.appId) return { id: user }
    return {
      id: user,
      avatarUrl: QQAvatarUrl(identity.appId, identity.openId)
    }
  }
  async downloadFile(source: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer | null> {
    const download = this.attachmentTypes.get(source)?.startsWith('image/') ? downloadQQImage : downloadQQAttachment
    return download(source, maxBytes, this.abort.signal, this.deps.fetchImpl, (reason) =>
      this.deps.log.warn(`qq: attachment download failed (${reason})`)
    )
  }

  sendImage(
    channel: string,
    replyId: string,
    file: Parameters<ImageUploader>[0],
    caption?: string,
    signal?: AbortSignal
  ): Promise<UploadOutcome> {
    return this.ensureSender().then((sender) =>
      sender.sendImage(QQTargetForChannel(channel), replyId, file, caption, signal)
    )
  }

  async sendText(channel: string, replyId: string, text: string): Promise<void> {
    await (await this.ensureSender()).sendText(QQTargetForChannel(channel), replyId, text)
  }

  async sendProgress(channel: string, replyId: string, text: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.ensureSender()).sendProgress(QQTargetForChannel(channel), replyId, text, signal)
  }

  async sendAcknowledgement(channel: string, replyId: string, text: string, signal?: AbortSignal): Promise<void> {
    await (await this.ensureSender()).sendAcknowledgement(QQTargetForChannel(channel), replyId, text, signal)
  }

  sendStream(
    channel: string,
    replyId: string,
    cursor: QQStreamCursor,
    text: string,
    done: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    return this.ensureSender().then((sender) =>
      sender.sendStream(QQTargetForChannel(channel), replyId, cursor, text, done, signal)
    )
  }

  private ensureSender(): Promise<QQSender> {
    return this.ensureProtocol().then(() => this.sender!)
  }
}

export function QQReplyId(message: NormalizedMessage): string | undefined {
  const ext = message.adapterExt?.qq as { replyId?: unknown } | undefined
  return typeof ext?.replyId === 'string' ? ext.replyId : undefined
}
