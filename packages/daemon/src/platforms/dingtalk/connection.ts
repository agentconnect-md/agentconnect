// One DingTalk internal app's daemon connection: the Stream client, robot sends, and what it observed (dingtalk-integration.md §3, §4).
import { createHash, randomUUID } from 'node:crypto'
import { dingTalkDmChannel, normalizeDingTalkMessage, type DingTalkRobotMessage } from '@agentconnect.md/message'
import type { DingTalkEdition } from '@agentconnect.md/protocol'
import type { LoadedAgent } from '../../agents/load-agents.js'
import type { Logger } from '../../log.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type {
  InteractionActor,
  PlatformChannelInfo,
  PlatformConnection,
  PlatformMemberRef,
  PlatformUserProfile
} from '../contract.js'
import { platformIntegrationConfig } from '../integration-config.js'
import {
  DINGTALK_CARD_CALLBACK_TOPIC,
  DINGTALK_ROBOT_TOPIC,
  DingTalkApi,
  DingTalkApiError,
  DINGTALK_MSG_PARAM_MAX_BYTES,
  dingTalkMarkdownTitle,
  dingTalkTargetForChannel,
  splitForMsgParam,
  type DingTalkApiOptions
} from './api.js'
import { DingTalkCardClient, type DingTalkCardPort } from './card.js'
import { DINGTALK_CARD_PROMPT_CAP, dingTalkCardTap, dingTalkMentionCard } from './elicit-card.js'
import { DingTalkReactionClient, type DingTalkReactionPort } from './reaction.js'
import { rewriteDingTalkMarkdown } from './markdown.js'
import { DingTalkStream, type DingTalkSocket, type DingTalkStreamTiming } from './stream.js'
import type { SendIdentity, UploadOutcome } from '../../mcp/ops/context.js'
import { DINGTALK_ATTACHMENT_TOOL } from './attachments.js'
import {
  DINGTALK_MEDIA_MAX_BYTES,
  dingTalkMediaMessage,
  downloadDingTalkFile,
  uploadDingTalkMedia,
  type DingTalkMediaDeps,
  type DingTalkMediaPort
} from './media.js'

export interface DingTalkConnectionGroup {
  clientId: string
  clientSecret: string
  edition: DingTalkEdition
  integrations: { agentId: string; integrationId: string }[]
}

export function dingTalkConnKey(group: Pick<DingTalkConnectionGroup, 'clientId' | 'clientSecret' | 'edition'>): string {
  return createHash('sha256')
    .update(JSON.stringify([group.clientId, group.clientSecret, group.edition]))
    .digest('hex')
}

// One connection per app: integrations sharing credentials share its single Stream client (§3.1).
export function consolidateDingTalk(agents: LoadedAgent[]): Map<string, DingTalkConnectionGroup> {
  const groups = new Map<string, DingTalkConnectionGroup>()
  for (const agent of agents)
    for (const integration of agent.integrations) {
      const config = platformIntegrationConfig('dingtalk', integration)
      if (!config) continue
      const key = dingTalkConnKey(config)
      const group = groups.get(key) ?? {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        edition: config.edition,
        integrations: []
      }
      group.integrations.push({ agentId: agent.id, integrationId: integration.id })
      groups.set(key, group)
    }
  return groups
}

/** One part of a sent reply and the process query key its send returned, undefined when that send failed. */
export interface DingTalkSentPart {
  text: string
  processQueryKey?: string
  /** Why the part was not sent, so a quota refusal can be named (§4.4). */
  error?: unknown
}

/** The sends a turn makes through the connection it leased. */
export interface DingTalkReplyPort {
  sendMarkdown(channel: string, text: string, opts?: { suffix?: string }): Promise<DingTalkSentPart[]>
  sendText(channel: string, text: string): Promise<string | undefined>
  /** The reaction calls that acknowledge a turn (§4.3). */
  readonly reactions?: DingTalkReactionPort
  /** The question card calls; absent when tap cards are turned off (§4.6). */
  readonly cards?: DingTalkCardPort
}

const SEEN_LIMIT = 2_000
const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MEMBERS_PER_CHANNEL = 200
const TENANT_REPORT_INTERVAL_MS = 60 * 60 * 1000
// A reply address this close to expiry is left for the card, so a send never races its expiry.
const WEBHOOK_MARGIN_MS = 60_000

/** A sender outside the robot's organization has no staff ID in it (**measured**, §4.1), or names another organization. */
function fromOutside(payload: DingTalkRobotMessage): boolean {
  if (typeof payload.senderStaffId !== 'string' || !payload.senderStaffId) return true
  const sender = payload.senderCorpId
  return typeof sender === 'string' && !!sender && !!payload.chatbotCorpId && sender !== payload.chatbotCorpId
}

export class DingTalkConnection implements PlatformConnection, DingTalkReplyPort, DingTalkMediaPort {
  readonly botUserId: string
  private readonly abort = new AbortController()
  private readonly api: DingTalkApi
  private readonly stream: DingTalkStream
  readonly reactions: DingTalkReactionClient
  readonly cards?: DingTalkCardClient
  private readonly seen = new Set<string>()
  private readonly channels = new Map<string, { name?: string; isIm: boolean }>()
  private readonly members = new Map<string, Map<string, string | undefined>>()
  private readonly names = new Map<string, string>()
  // Download code → declared MIME type, so an image download is held to image bytes.
  private readonly attachmentTypes = new Map<string, string>()
  private readonly media: DingTalkMediaDeps
  private tenantReport?: { corpId: string; at: number }
  // Each group's latest reply address (`sessionWebhook`), the one send that carries mentions in a plain message (§4.2).
  private readonly webhooks = new Map<string, { url: string; until: number }>()
  // Groups already reported as holding an outsider; the detection is sticky, so once per connection is enough.
  private readonly outsiderPlaces = new Set<string>()

  constructor(
    readonly group: DingTalkConnectionGroup,
    private readonly deps: {
      onMessage(msg: NormalizedMessage): void
      /** A tap on a question card; a refusal for the tapper comes back, which DingTalk has nowhere private to show. */
      onElicitChoice?(a: {
        requestId: string
        token: string | null
        ts?: string
        actor?: InteractionActor
      }): Promise<string | undefined>
      /** The question card template; absent ⇒ every question is the numbered text card (§4.6). */
      questionTemplate?: string
      /** The organization a robot message named (§2.2); true once the CP was told. */
      onTenant?(corpId: string): boolean
      /** A group just heard from someone outside the robot's organization (§4.1). */
      onPlaceExternal?(channel: string, reason: 'externalMember'): void
      log: Logger
      fetchImpl?: typeof fetch
      origin?: string
      createSocket?(url: string): DingTalkSocket
      streamTiming?: Partial<DingTalkStreamTiming>
    }
  ) {
    // The robot code a mention names is the Client ID (§2).
    this.botUserId = group.clientId
    const apiOptions: DingTalkApiOptions = { signal: this.abort.signal }
    if (deps.fetchImpl) apiOptions.fetchImpl = deps.fetchImpl
    if (deps.origin) apiOptions.origin = deps.origin
    this.api = new DingTalkApi(group, apiOptions)
    this.reactions = new DingTalkReactionClient(this.api, group.clientId, deps.log)
    // The international edition offers no card permission, so its questions are the numbered text card (§2.1).
    if (deps.questionTemplate && group.edition === 'mainland')
      this.cards = new DingTalkCardClient(this.api, group.clientId, deps.questionTemplate, deps.log)
    const api = this.api
    this.media = {
      accessToken: () => api.accessToken(),
      robotCode: group.clientId,
      signal: this.abort.signal,
      get origin() {
        return api.origin
      },
      get oapiOrigin() {
        return api.oapiOrigin
      },
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
    }
    this.stream = new DingTalkStream({
      openConnection: () => this.api.openStream(),
      ...(deps.createSocket ? { createSocket: deps.createSocket } : {}),
      onCallback: (topic, data) => this.onCallback(topic, data),
      log: deps.log,
      ...(deps.streamTiming ? { timing: deps.streamTiming } : {})
    })
  }

  async start(): Promise<void> {
    this.abort.signal.throwIfAborted()
    await this.stream.start()
    this.deps.log.info('dingtalk: stream connected')
  }

  async stop(): Promise<void> {
    this.abort.abort()
    await this.stream.stop()
  }

  workspaceId(): string {
    return this.group.clientId
  }

  private onCallback(topic: string, data: string): void {
    if (this.abort.signal.aborted) return
    if (topic === DINGTALK_CARD_CALLBACK_TOPIC) return this.onCardCallback(data)
    if (topic !== DINGTALK_ROBOT_TOPIC) return
    let payload: DingTalkRobotMessage
    try {
      payload = JSON.parse(data) as DingTalkRobotMessage
    } catch {
      this.deps.log.warn('dingtalk: dropped an unparseable robot message')
      return
    }
    const msg = this.normalize(payload)
    if (msg) this.deps.onMessage(msg)
  }

  // The callback was acknowledged already; a tap on an unknown or settled card is simply ignored by core.
  private onCardCallback(data: string): void {
    const tap = dingTalkCardTap(data)
    if (!tap || !this.deps.onElicitChoice) return
    const name = this.names.get(tap.userId)
    const actor: InteractionActor = { userId: tap.userId, ...(name ? { name } : {}) }
    void this.deps
      .onElicitChoice({ requestId: tap.requestId, token: tap.token, ts: tap.outTrackId, actor })
      .catch((error: unknown) =>
        this.deps.log.warn(`dingtalk: card tap failed (${error instanceof Error ? error.message : 'unknown error'})`)
      )
  }

  /** Normalize one robot message, dropping a `msgId` already delivered (two sockets overlap during a handover, §3.2). */
  normalize(payload: DingTalkRobotMessage): NormalizedMessage | null {
    const id = typeof payload.msgId === 'string' ? payload.msgId : undefined
    if (id) {
      if (this.seen.has(id)) return null
      this.seen.add(id)
      while (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!)
    }
    const msg = normalizeDingTalkMessage(payload, {
      robotCode: this.group.clientId,
      traceId: randomUUID()
    }) as NormalizedMessage | null
    if (!msg) return null
    for (const attachment of msg.attachments ?? []) {
      attachment.readerToolName = DINGTALK_ATTACHMENT_TOOL.name
      if (!attachment.sourceUrl) continue
      this.attachmentTypes.delete(attachment.sourceUrl)
      this.attachmentTypes.set(attachment.sourceUrl, attachment.mimeType)
    }
    while (this.attachmentTypes.size > SEEN_LIMIT)
      this.attachmentTypes.delete(this.attachmentTypes.keys().next().value!)
    this.observe(msg, payload)
    return msg
  }

  // Membership is observed, never enumerated: DingTalk lists no members of an ordinary group (§7).
  private observe(msg: NormalizedMessage, payload: DingTalkRobotMessage): void {
    const title = typeof payload.conversationTitle === 'string' ? payload.conversationTitle.trim() : ''
    const name = msg.isDm ? msg.sender.name : title || this.channels.get(msg.channel)?.name
    this.channels.delete(msg.channel)
    this.channels.set(msg.channel, { isIm: msg.isDm === true, ...(name ? { name } : {}) })
    const members = this.members.get(msg.channel) ?? new Map<string, string | undefined>()
    members.delete(msg.sender.id)
    members.set(msg.sender.id, msg.sender.name)
    while (members.size > MEMBERS_PER_CHANNEL) members.delete(members.keys().next().value!)
    this.members.set(msg.channel, members)
    if (msg.sender.name) this.names.set(msg.sender.id, msg.sender.name)
    this.reportTenant(payload.chatbotCorpId)
    this.noteWebhook(msg, payload)
    if (!msg.isDm && fromOutside(payload) && !this.outsiderPlaces.has(msg.channel)) {
      this.outsiderPlaces.add(msg.channel)
      while (this.outsiderPlaces.size > SEEN_LIMIT)
        this.outsiderPlaces.delete(this.outsiderPlaces.values().next().value!)
      this.deps.onPlaceExternal?.(msg.channel, 'externalMember')
    }
  }

  // Kept only when it is this edition's own address, so a send never goes anywhere a payload names.
  private noteWebhook(msg: NormalizedMessage, payload: DingTalkRobotMessage): void {
    const url = payload.sessionWebhook
    const until = payload.sessionWebhookExpiredTime
    if (msg.isDm || typeof url !== 'string' || typeof until !== 'number') return
    try {
      if (new URL(url).origin !== this.api.oapiOrigin) return
    } catch {
      return
    }
    this.webhooks.delete(msg.channel)
    this.webhooks.set(msg.channel, { url, until })
    while (this.webhooks.size > SEEN_LIMIT) this.webhooks.delete(this.webhooks.keys().next().value!)
  }

  // A robot join raises no event, so the first message names the organization; resent hourly in case the CP lost it.
  private reportTenant(corpId: unknown): void {
    if (typeof corpId !== 'string' || !corpId || !this.deps.onTenant) return
    const now = Date.now()
    const last = this.tenantReport
    if (last?.corpId === corpId && now - last.at < TENANT_REPORT_INTERVAL_MS) return
    if (this.deps.onTenant(corpId)) this.tenantReport = { corpId, at: now }
  }

  /** The send tool's post (§4.2): DingTalk has no threads, so the first part's process query key names it. */
  async postMessage(channel: string, text: string): Promise<string | undefined> {
    const sent = await this.sendMarkdown(channel, text)
    const failed = sent.find((part) => part.error !== undefined)
    if (failed) throw failed.error instanceof Error ? failed.error : new Error('dingtalk: send failed')
    return sent[0]?.processQueryKey
  }

  /** A group post that @-mentions members: a Markdown message through the group's fresh reply address, else a card (§4.2). */
  async postMentioning(
    channel: string,
    text: string,
    users: string[],
    identity?: SendIdentity
  ): Promise<string | undefined> {
    if (channel.startsWith('dm:'))
      throw new Error('dingtalk: a direct message mentions no one; send it without a channel')
    const ids = [...new Set(users)]
    if (!ids.every((id) => /^[^\s:$]{1,64}$/.test(id))) throw new Error("dingtalk: a mention needs a member's staff ID")
    const hook = this.webhooks.get(channel)
    const fresh = hook && hook.until - Date.now() > WEBHOOK_MARGIN_MS ? hook.url : undefined
    if (fresh && (await this.mentionByWebhook(fresh, text, ids))) return undefined
    if (!this.cards)
      throw new Error(
        'dingtalk: mentions need a message in this group within the last 90 minutes, or a card, and this app sends no cards'
      )
    const names = Object.fromEntries(ids.map((id) => [id, this.names.get(id) ?? id]))
    const shown = `${ids.map((id) => `@${names[id]}`).join(' ')} ${text}`
    // A card body has a hard cap; a mention post that would not fit whole is refused rather than cut.
    if (shown.length > DINGTALK_CARD_PROMPT_CAP)
      throw new Error(
        `dingtalk: a mention card holds ${DINGTALK_CARD_PROMPT_CAP} characters with its names, and this one has ${shown.length}; shorten it or send it without toUser`
      )
    const outTrackId = `acm-${randomUUID()}`
    const params = dingTalkMentionCard(identity?.username ?? '', shown)
    if (!(await this.cards.deliver(channel, outTrackId, params, names)))
      throw new Error('dingtalk: the mention card was not delivered')
    return outTrackId
  }

  // True once DingTalk took the message; false when it refused it, so the card may follow. A transport failure throws: the message may have landed.
  private async mentionByWebhook(url: string, text: string, ids: string[]): Promise<boolean> {
    const markdown = {
      title: dingTalkMarkdownTitle(text),
      text: `${ids.map((id) => `@${id}`).join(' ')} ${rewriteDingTalkMarkdown(text)}`
    }
    const bytes = Buffer.byteLength(JSON.stringify(markdown))
    if (bytes > DINGTALK_MSG_PARAM_MAX_BYTES)
      throw new Error(
        `dingtalk: a mention message holds ${DINGTALK_MSG_PARAM_MAX_BYTES} bytes, and this one has ${bytes}; shorten it or send it without toUser`
      )
    const response = await (this.deps.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown, at: { atUserIds: ids } }),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)])
    })
    const answer = (await response.json().catch(() => ({}))) as { errcode?: unknown }
    if (response.ok && answer.errcode === 0) return true
    this.deps.log.warn(
      `dingtalk: the reply address refused a mention (${String(answer.errcode ?? response.status)}); trying a card`
    )
    return false
  }

  /** A member's DM is the robot's own 1:1 chat, addressed by staff ID (§4.2); an outsider's opaque sender id has none. */
  async openDirectMessage(user: string): Promise<string> {
    if (!/^[^\s:$]{1,64}$/.test(user)) throw new Error("dingtalk: a direct message needs a member's staff ID")
    return dingTalkDmChannel(user)
  }

  async getChannelInfo(channel: string): Promise<PlatformChannelInfo> {
    const known = this.channels.get(channel)
    const isIm = known?.isIm ?? channel.startsWith('dm:')
    return {
      id: channel,
      name: known?.name ?? (isIm ? 'DingTalk direct message' : 'DingTalk group'),
      isIm,
      isPrivate: true
    }
  }

  async listMembers(channel: string): Promise<PlatformMemberRef[]> {
    return [...(this.members.get(channel) ?? [])].map(([id, name]) => ({ id, ...(name ? { name } : {}), isBot: false }))
  }

  async listChannels() {
    return [...this.channels].map(([id, { name }]) => ({ id, ...(name ? { name } : {}), isPrivate: true }))
  }

  async getUserProfile(user: string): Promise<PlatformUserProfile> {
    const name = this.names.get(user)
    return { id: user, ...(name ? { name } : {}) }
  }

  /** An attachment's bytes by its download code (§4.5); null when unavailable or over `maxBytes`, never a throw. */
  async downloadFile(code: string, maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES): Promise<Buffer | null> {
    return downloadDingTalkFile(this.media, code, maxBytes, {
      image: this.attachmentTypes.get(code)?.startsWith('image/') === true,
      reportFailure: (reason) => this.deps.log.warn(`dingtalk: attachment download failed (${reason})`)
    })
  }

  /** Upload a file and send it as an image or file message; the outcome's id is the send's process query key. */
  async sendMedia(
    channel: string,
    file: { bytes: Buffer; name: string; mimeType: string },
    caption?: string
  ): Promise<UploadOutcome> {
    if (file.bytes.byteLength > DINGTALK_MEDIA_MAX_BYTES) return { ok: false, reason: 'too_large' }
    let mediaId: string
    try {
      mediaId = await uploadDingTalkMedia(this.media, file, file.mimeType.startsWith('image/') ? 'image' : 'file')
    } catch (error) {
      this.deps.log.warn(`dingtalk: media upload failed (${error instanceof Error ? error.message : 'unknown error'})`)
      const code = error instanceof DingTalkApiError ? error.code : undefined
      return { ok: false, reason: 'platform_error', ...(code ? { detail: code } : {}) }
    }
    const message = dingTalkMediaMessage(mediaId, file)
    let messageId: string | undefined
    try {
      messageId = await this.api.send(dingTalkTargetForChannel(channel), message.msgKey, message.msgParam)
    } catch (error) {
      this.deps.log.warn(`dingtalk: media send failed (${error instanceof Error ? error.message : 'unknown error'})`)
      // Only DingTalk's own refusal proves nothing was sent; a lost response may still have delivered it.
      if (!(error instanceof DingTalkApiError)) return { ok: false, reason: 'indeterminate' }
      return { ok: false, reason: 'platform_error', ...(error.code ? { detail: error.code } : {}) }
    }
    const captioned = caption ? (await this.sendText(channel, caption)) !== undefined : true
    return {
      ok: true,
      ...(messageId ? { messageId } : {}),
      ...(captioned ? {} : { warning: 'The caption was not delivered.' })
    }
  }

  /** Send Markdown as one or more messages under the size limit; `suffix` rides the last one and is not part of any returned text. */
  async sendMarkdown(channel: string, text: string, opts: { suffix?: string } = {}): Promise<DingTalkSentPart[]> {
    const title = dingTalkMarkdownTitle(text)
    const suffix = opts.suffix ? `\n\n${opts.suffix}` : ''
    // Each part is rewritten for DingTalk's dialect as it is sized, so the rewrite's growth counts against the limit.
    const parts = splitForMsgParam(text, (part) => ({ title, text: `${rewriteDingTalkMarkdown(part)}${suffix}` }))
    const target = dingTalkTargetForChannel(channel)
    const sent: DingTalkSentPart[] = []
    let failed = false
    for (const [index, part] of parts.entries()) {
      if (failed) {
        sent.push({ text: part })
        continue
      }
      const body = `${rewriteDingTalkMarkdown(part)}${index === parts.length - 1 ? suffix : ''}`
      try {
        const processQueryKey = await this.api.send(target, 'sampleMarkdown', JSON.stringify({ title, text: body }))
        sent.push({ text: part, ...(processQueryKey ? { processQueryKey } : {}) })
      } catch (error) {
        // The rest of a reply is not sent after one part fails, so the conversation never shows a gap.
        failed = true
        this.deps.log.warn(
          `dingtalk: markdown send failed (${error instanceof Error ? error.message : 'unknown error'})`
        )
        sent.push({ text: part, error })
      }
    }
    return sent
  }

  /** A short control message as plain text; returns its process query key. */
  async sendText(channel: string, text: string): Promise<string | undefined> {
    const target = dingTalkTargetForChannel(channel)
    let key: string | undefined
    for (const part of splitForMsgParam(text, (content) => ({ content }))) {
      try {
        key = await this.api.send(target, 'sampleText', JSON.stringify({ content: part }))
      } catch (error) {
        this.deps.log.warn(`dingtalk: text send failed (${error instanceof Error ? error.message : 'unknown error'})`)
        return undefined
      }
    }
    return key
  }
}
