import { EventEmitter } from 'node:events'
import { RecentEventDeduplicator } from '../onebots/index.js'

import { ILINK_LONG_WAIT_MS, ILINK_QR_BOT_CLASS_DEFAULT } from './internal/config.js'
import { MissingReplyLaneFault, GatewayFault } from './internal/errors.js'
import { pickCredentialOrNull } from './internal/session-snapshot.js'
import { materializeUserSuppliedFile } from './internal/load-bytes.js'
import { AuthorKind, UploadKind } from './protocol/wire-models.js'
import type {
  CredentialBlob,
  DownloadMediaOptions,
  DownloadMediaResult,
  InputFile,
  LoginOutcome,
  LoginTicket,
  NormalizedChatEvent,
  OnTextListener,
  PollingOptions,
  SendCommonOptions,
  SendMediaOptions,
  SendTypingOptions,
  SessionStore,
  WaitForLoginOptions
} from './protocol/chat-event.js'
import type { ClearSessionOptions, IlinkBotOptions } from './ilink-options.js'
import { mapInboundWirePacket } from './protocol/inbound-mapper.js'
import { allocateLoginTicket, awaitLoginTicketResolution } from './login/qr-handshake.js'
import { createOutboundSender } from './outbound/assembler.js'
import { IlinkJsonTransport } from './transport/ilink-json-transport.js'
import { JsonFileCredentialStore, MemoryCredentialStore } from './state/persist.js'
import { pullUserMediaAttachment, stageBinaryForPeer, mapMimeFamilyToUploadKind } from './cdn/payload-pipeline.js'
import type { ClawbotContextTokenStore } from '../context-token-store.js'
import { runPollingLoop } from './polling-loop.js'
import {
  emitInbound,
  assertInboundWirePacket,
  inboundEventKey,
  rememberRecentMessage,
  runTextBindings,
  resolveRecentMedia,
  type RegexBinding
} from './inbound-runtime.js'
import { IlinkTypingRuntime } from './typing-runtime.js'
import type { IlinkBotEvents } from './ilink-events.js'

export class IlinkBot extends EventEmitter<IlinkBotEvents> {
  private readonly store: SessionStore
  private readonly transport: IlinkJsonTransport
  private snapshot: CredentialBlob | null = null
  private readonly seedCredential: Partial<CredentialBlob> | null
  private hydrated = false
  private pollArmed = false
  private pollingGeneration = 0
  private pollingAbort: AbortController | null = null
  /** 子类在凭证失效重登前可 await 其结束并置 null */
  protected pollLoop: Promise<void> | null = null
  private pollKnobs: PollingOptions
  private readonly regexBindings: RegexBinding[] = []
  private readonly typing: IlinkTypingRuntime
  private readonly recentMessages = new Map<string, NormalizedChatEvent>()
  private readonly receivedEvents = new RecentEventDeduplicator<string>()
  private readonly contextTokenStore?: ClawbotContextTokenStore
  private readonly contextTokenAccountKey?: string
  private readonly outbound: ReturnType<typeof createOutboundSender>
  private didMigrateContextTokensFromFile = false
  private contextTokensCarryover: Record<string, string> | null = null

  constructor(options: IlinkBotOptions = {}) {
    super()
    this.seedCredential =
      options.session ??
      (options.token && options.accountId
        ? {
            token: options.token,
            accountId: options.accountId,
            baseUrl: options.baseUrl,
            cdnBaseUrl: options.cdnBaseUrl,
            routeTag: options.routeTag,
            contextTokens: {}
          }
        : null)

    this.store =
      typeof options.sessionStore === 'string'
        ? new JsonFileCredentialStore(options.sessionStore)
        : (options.sessionStore ?? new MemoryCredentialStore())

    this.transport = new IlinkJsonTransport({
      baseUrl: options.baseUrl,
      cdnBaseUrl: options.cdnBaseUrl,
      routeTag: options.routeTag,
      token: options.token
    })
    this.typing = new IlinkTypingRuntime(this.transport)

    this.contextTokenStore = options.contextTokenStore
    this.contextTokenAccountKey = options.contextTokenAccountKey
    this.outbound = createOutboundSender(this.transport, options.outboundTextFormat ?? 'plain')

    this.pollKnobs = typeof options.polling === 'object' ? options.polling : { timeoutMs: ILINK_LONG_WAIT_MS }

    if (options.polling) {
      queueMicrotask(() => {
        void this.startPolling().catch((error: unknown) => this.emit('polling_error', error))
      })
    }
  }

  onText(pattern: RegExp, listener: OnTextListener): this {
    this.regexBindings.push({ pattern, listener })
    return this
  }
  protected async ensureSessionLoaded(): Promise<CredentialBlob | null> {
    if (this.hydrated) return this.snapshot

    const disk = pickCredentialOrNull(await this.store.load())
    const inline = pickCredentialOrNull(this.seedCredential)
    this.snapshot = disk ?? inline

    if (this.snapshot) {
      this.transport.patchRuntimeTargets({
        token: this.snapshot.token,
        baseUrl: this.snapshot.baseUrl || undefined,
        cdnBaseUrl: this.snapshot.cdnBaseUrl,
        routeTag: this.snapshot.routeTag
      })
    }

    await this.maybeMigrateContextTokensFromSessionFile()

    this.hydrated = true
    return this.snapshot
  }

  private stripForJsonSave(blob: CredentialBlob): CredentialBlob {
    if (!this.contextTokenStore) return blob
    return { ...blob, contextTokens: {} }
  }

  private async maybeMigrateContextTokensFromSessionFile(): Promise<void> {
    if (this.didMigrateContextTokensFromFile) return
    this.didMigrateContextTokensFromFile = true
    if (!this.contextTokenStore || !this.contextTokenAccountKey || !this.snapshot) return
    const ct = this.snapshot.contextTokens
    if (!ct || Object.keys(ct).length === 0) return
    for (const [peerId, tok] of Object.entries(ct)) {
      if (typeof tok === 'string' && tok.length > 0) {
        this.contextTokenStore.set(this.contextTokenAccountKey, this.snapshot.accountId, peerId, tok)
      }
    }
    this.snapshot.contextTokens = {}
    await this.store.save(this.stripForJsonSave(this.snapshot))
  }

  private async persistSnapshot(): Promise<void> {
    if (!this.snapshot) return
    this.snapshot.updatedAt = new Date().toISOString()
    await this.store.save(this.stripForJsonSave(this.snapshot))
  }

  async getSession(): Promise<CredentialBlob | null> {
    return this.ensureSessionLoaded()
  }
  async clearSession(options?: ClearSessionOptions): Promise<void> {
    if (!this.contextTokenStore && options?.preserveContextTokens && this.snapshot?.contextTokens) {
      const prev = this.snapshot.contextTokens
      const keys = Object.keys(prev)
      if (keys.length > 0) {
        this.contextTokensCarryover = { ...prev }
      }
    } else {
      this.contextTokensCarryover = null
    }
    this.snapshot = null
    this.hydrated = true
    this.typing.clear()
    await this.store.clear()
    this.transport.patchRuntimeTargets({ token: undefined, routeTag: undefined })
  }

  async useSession(session: CredentialBlob): Promise<void> {
    const carried = this.contextTokenStore ? {} : (this.contextTokensCarryover ?? {})
    this.contextTokensCarryover = null
    this.snapshot = {
      ...session,
      syncBuffer: session.syncBuffer ?? '',
      contextTokens: this.contextTokenStore ? {} : { ...carried, ...(session.contextTokens ?? {}) },
      updatedAt: new Date().toISOString(),
      createdAt: session.createdAt ?? new Date().toISOString()
    }
    this.hydrated = true
    this.transport.patchRuntimeTargets({
      token: session.token,
      baseUrl: session.baseUrl || undefined,
      cdnBaseUrl: session.cdnBaseUrl,
      routeTag: session.routeTag
    })
    await this.persistSnapshot()
  }

  async createLoginSession(options?: { botType?: string; signal?: AbortSignal }): Promise<LoginTicket> {
    const session = await this.ensureSessionLoaded()
    return allocateLoginTicket(this.transport, {
      botType: options?.botType ?? ILINK_QR_BOT_CLASS_DEFAULT,
      localTokens: session?.token ? [session.token] : [],
      signal: options?.signal
    })
  }

  async waitForLogin(sessionKey: string, options?: WaitForLoginOptions): Promise<LoginOutcome> {
    const outcome = await awaitLoginTicketResolution(this.transport, sessionKey, options)
    if (outcome.connected && outcome.session) {
      await this.useSession(outcome.session)
      this.emit('login', outcome.session)
    }
    return outcome
  }

  async loginWithQr(options?: WaitForLoginOptions & { botType?: string }): Promise<{
    loginSession: LoginTicket
    result: LoginOutcome
  }> {
    const loginSession = await this.createLoginSession({
      botType: options?.botType,
      signal: options?.signal
    })
    const result = await this.waitForLogin(loginSession.sessionKey, options)
    return { loginSession, result }
  }

  async getLatestContextToken(chatId: string): Promise<string | undefined> {
    const s = await this.ensureSessionLoaded()
    if (this.contextTokenStore && this.contextTokenAccountKey && s) {
      const fromDb = this.contextTokenStore.get(this.contextTokenAccountKey, s.accountId, chatId)
      if (fromDb) return fromDb
    }
    return s?.contextTokens?.[chatId]
  }
  private insistSnapshot(s: CredentialBlob | null): CredentialBlob {
    if (!s) {
      throw new GatewayFault('SESSION_NOT_AVAILABLE', '未配置 iLink 会话：请先扫码或写入 token。')
    }
    return s
  }

  private async obtainReplyContext(peerKey: string, override?: string): Promise<string> {
    const s = this.insistSnapshot(await this.ensureSessionLoaded())
    let ctx = override
    if (ctx == null && this.contextTokenStore && this.contextTokenAccountKey) {
      ctx = this.contextTokenStore.get(this.contextTokenAccountKey, s.accountId, peerKey)
    }
    if (ctx == null) ctx = s.contextTokens?.[peerKey]
    if (!ctx) throw new MissingReplyLaneFault(peerKey)
    return ctx
  }

  private async memorizeReplyContext(peerKey: string, contextToken?: string): Promise<void> {
    if (!contextToken) return
    const s = this.insistSnapshot(await this.ensureSessionLoaded())
    if (this.contextTokenStore && this.contextTokenAccountKey) {
      this.contextTokenStore.set(this.contextTokenAccountKey, s.accountId, peerKey, contextToken)
    } else {
      s.contextTokens = s.contextTokens ?? {}
      s.contextTokens[peerKey] = contextToken
    }
    await this.persistSnapshot()
  }

  async sendTextToUser(chatId: string, text: string, options: SendCommonOptions = {}): Promise<{ messageId: string }> {
    await this.ensureSessionLoaded()
    const ctx = await this.obtainReplyContext(chatId, options.contextToken)
    return this.outbound.postText(chatId, ctx, text)
  }

  async sendPhotoToUser(
    chatId: string,
    input: InputFile,
    options: SendMediaOptions = {}
  ): Promise<{ messageId: string }> {
    await this.ensureSessionLoaded()
    const ctx = await this.obtainReplyContext(chatId, options.contextToken)
    const staged = await stageBinaryForPeer({
      transport: this.transport,
      input,
      peerKey: chatId,
      uploadKind: UploadKind.Image,
      filename: options.filename,
      contentType: options.contentType
    })
    const mid = await this.outbound.postPhoto(chatId, ctx, staged, options.caption)
    return { messageId: mid }
  }

  async sendVideoToUser(
    chatId: string,
    input: InputFile,
    options: SendMediaOptions = {}
  ): Promise<{ messageId: string }> {
    await this.ensureSessionLoaded()
    const ctx = await this.obtainReplyContext(chatId, options.contextToken)
    const staged = await stageBinaryForPeer({
      transport: this.transport,
      input,
      peerKey: chatId,
      uploadKind: UploadKind.Video,
      filename: options.filename,
      contentType: options.contentType
    })
    const mid = await this.outbound.postVideo(chatId, ctx, staged, options.caption)
    return { messageId: mid }
  }

  async sendDocumentToUser(
    chatId: string,
    input: InputFile,
    options: SendMediaOptions = {}
  ): Promise<{ messageId: string }> {
    await this.ensureSessionLoaded()
    const ctx = await this.obtainReplyContext(chatId, options.contextToken)
    const blob = await materializeUserSuppliedFile(input, {
      filename: options.filename,
      contentType: options.contentType
    })
    const staged = await stageBinaryForPeer({
      transport: this.transport,
      input: { source: blob.buffer, filename: blob.fileName, contentType: blob.contentType },
      peerKey: chatId,
      uploadKind: mapMimeFamilyToUploadKind(blob.contentType),
      filename: blob.fileName,
      contentType: blob.contentType
    })
    const mid = await this.outbound.postFile(chatId, ctx, staged, options.caption)
    return { messageId: mid }
  }

  async sendTypingToUser(chatId: string, options: SendTypingOptions = {}): Promise<void> {
    await this.ensureSessionLoaded()
    const s = this.insistSnapshot(this.snapshot)
    const ctx = await this.obtainReplyContext(chatId, options.contextToken)
    await this.typing.send(chatId, ctx, options.status ?? 'active')
    s.updatedAt = new Date().toISOString()
    await this.persistSnapshot()
  }

  async downloadInboundMedia(
    message: NormalizedChatEvent,
    options?: DownloadMediaOptions
  ): Promise<DownloadMediaResult> {
    await this.ensureSessionLoaded()
    return pullUserMediaAttachment({ transport: this.transport, message, options })
  }

  async downloadRecentMedia(messageId: string, itemIndex?: number): Promise<DownloadMediaResult> {
    return this.downloadInboundMedia(resolveRecentMedia(this.recentMessages, messageId, itemIndex))
  }

  /**
   * 将一个原始 iLink 事件交给统一事件管线。
   * 长轮询、测试夹具和宿主已有连接均应调用此入口，确保 context_token 与 typed 事件一致。
   */
  async ingest(rawEvent: unknown): Promise<NormalizedChatEvent | undefined> {
    assertInboundWirePacket(rawEvent)
    // getupdates 会回送 BOT 副本；将它投递为入站消息会造成自触发与上下文污染。
    if (rawEvent.message_type !== AuthorKind.Human) return undefined
    const eventKey = inboundEventKey(rawEvent)
    if (this.receivedEvents.has(eventKey)) return undefined
    const evt = mapInboundWirePacket(rawEvent)
    rememberRecentMessage(this.recentMessages, evt)
    await this.memorizeReplyContext(evt.chat.id, evt.contextToken)
    await emitInbound(this, 'message', evt)
    if (evt.type !== 'unknown') {
      await emitInbound(this, evt.type, evt)
    }
    await runTextBindings(this, this.regexBindings, evt)
    this.receivedEvents.commit(eventKey)
    return evt
  }

  /** 启动无限恢复的长轮询；方法在轮询建立后返回，不占用账号启动生命周期。 */
  async startPolling(options?: PollingOptions): Promise<void> {
    if (this.pollArmed) return

    await this.ensureSessionLoaded()
    const s = this.insistSnapshot(this.snapshot)
    this.pollArmed = true
    const knobs = { ...this.pollKnobs, ...options }
    const generation = ++this.pollingGeneration
    const controller = new AbortController()
    this.pollingAbort = controller
    const abortFromOuter = () => controller.abort(knobs.signal?.reason)
    if (knobs.signal?.aborted) abortFromOuter()
    else knobs.signal?.addEventListener('abort', abortFromOuter, { once: true })
    try {
      await this.transport.notifyStart(controller.signal)
    } catch (error) {
      this.pollArmed = false
      this.pollingAbort = null
      knobs.signal?.removeEventListener('abort', abortFromOuter)
      throw error
    }

    this.pollLoop = runPollingLoop({
      transport: this.transport,
      session: s,
      options: knobs,
      signal: controller.signal,
      isCurrent: () => this.pollArmed && generation === this.pollingGeneration,
      persist: () => this.persistSnapshot(),
      ingest: (event) => this.ingest(event),
      credentialStale: async (error) => {
        this.pollArmed = false
        try {
          await this.clearSession({ preserveContextTokens: true })
        } catch (clearError: unknown) {
          this.emit('polling_error', clearError)
        }
        this.emit('credential_stale', error)
      },
      reportError: (error) => this.emit('polling_error', error)
    }).finally(() => {
      knobs.signal?.removeEventListener('abort', abortFromOuter)
      if (generation === this.pollingGeneration) {
        this.pollArmed = false
        this.pollingAbort = null
      }
    })
    void this.pollLoop.catch((error) => {
      if (!controller.signal.aborted) this.emit('polling_error', error)
    })
  }

  async stopPolling(): Promise<void> {
    this.pollArmed = false
    this.pollingGeneration += 1
    this.pollingAbort?.abort(new DOMException('轮询已停止', 'AbortError'))
    this.pollingAbort = null
    if (this.pollLoop) {
      await this.pollLoop.catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) throw error
      })
      this.pollLoop = null
    }
    const session = await this.getSession()
    if (session) await this.transport.notifyStop()
  }
}
