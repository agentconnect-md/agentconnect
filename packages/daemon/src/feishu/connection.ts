import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as Lark from '@larksuiteoapi/node-sdk'
import type { FeishuRegion } from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { Logger } from '../log.js'
import { SlackSendQueue } from '../slack/send-queue.js'
import { normalizeFeishuMessage, type FeishuAttachmentLike, type FeishuMessageLike } from './normalize.js'
import {
  buildCompletedReplyCard,
  buildPermissionUpdateCard,
  buildStreamingReplyCard,
  chunkForFeishu,
  FEISHU_STREAMING_ELEMENT_ID
} from './render.js'

/**
 * §Feishu / Lark edge unit. Mirrors discord/connection.ts but over the official
 * SDK's `Lark.WSClient` long-connection (an OUTBOUND WebSocket, so it works behind
 * NAT like Slack Socket Mode / Telegram long-polling / Discord Gateway). One WSClient
 * per unique appId (one self-built app = one bot).
 *
 * Agent replies use one CardKit entity per turn: create + send-by-card-id, cumulative
 * element updates, then a final full-card replacement. Short chrome/control messages
 * remain `msg_type:'text'`; `sendChatAction` is a no-op (Feishu has no typing API).
 * The static platform-permission notice remains an inline open-URL card.
 *
 * Attachments need AUTH to download (like Slack, unlike Discord): the inbound event
 * carries an opaque `image_key`/`file_key`, fetched via `im.messageResource.get` with a
 * tenant token the SDK maintains internally. Bytes stay daemon-local (§9.2).
 */

/** One WSClient long-connection per unique appId (one self-built app = one bot). */
export interface ConsolidatedFeishuGroup {
  appId: string
  appSecret: string
  /** Open-platform gateway the SDK talks to: 'feishu' (open.feishu.cn, default) vs
   *  'lark' (open.larksuite.com). Same across an appId (an app is region-scoped);
   *  taken from the first integration for the appId. */
  region: FeishuRegion
  /** From the first integration's feishu.botOpenId (same across the appId). */
  botOpenId?: string
  integrations: { agentId: string; integrationId: string }[]
}

/** §6.1 analog: group feishu integrations by appId (one Lark.WSClient per appId). */
export function consolidateFeishu(agents: Agent[]): Map<string, ConsolidatedFeishuGroup> {
  const groups = new Map<string, ConsolidatedFeishuGroup>()
  for (const a of agents) {
    for (const int of a.integrations) {
      if (int.platform !== 'feishu') continue
      const k = int.feishu.appId
      const g = groups.get(k) ?? {
        appId: k,
        appSecret: int.feishu.appSecret,
        region: int.feishu.region,
        ...(int.feishu.botOpenId ? { botOpenId: int.feishu.botOpenId } : {}),
        integrations: []
      }
      // A later integration on the same app may carry the botOpenId the first lacked.
      if (!g.botOpenId && int.feishu.botOpenId) g.botOpenId = int.feishu.botOpenId
      g.integrations.push({ agentId: a.id, integrationId: int.id })
      groups.set(k, g)
    }
  }
  return groups
}

export interface FeishuDeps {
  group: ConsolidatedFeishuGroup
  onMessage: (msg: NormalizedMessage) => void
  newTraceId: () => string
  log?: Logger
  /** Min spacing (ms) between outbound writes (serialized send-queue). Tests pass 0. */
  sendIntervalMs?: number
  // NOTE: no onCallback/onStatusAction/onSelectAction in v1; the permission card's
  // button is an open-URL behavior and sends no callback.
}

/** The raw `im.message.receive_v1` event body the WSClient dispatches. `data` IS the
 *  event (the SDK unwraps the envelope), so this is the plain shape we adapt to a pure
 *  {@link FeishuMessageLike} before normalizing. All fields optional — we never trust
 *  the shape and default-fill in {@link FeishuConnection.toLike}. */
export interface FeishuRawEvent {
  sender?: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string }
    sender_type?: string
  }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    content?: string
    // root_id = the topic thread's root message id (present on thread replies) — drives
    // per-thread session keying + threaded replies (see normalize + postMessage).
    root_id?: string
    mentions?: { key?: string; id?: { open_id?: string }; name?: string }[]
  }
}

/**
 * The slice of the Lark SDK the connection drives — hand-declared (like Telegram's
 * `TelegramApi` / Slack's `AppLike`) so the connection is testable with a fake and
 * doesn't fight the SDK's deep generics. The default factory adapts a real
 * `Lark.Client`; `startWs`/`close` wrap a real `Lark.WSClient` + `EventDispatcher`.
 */
export interface FeishuApi {
  /** im.message.create (msg_type 'text'). Returns the new message_id when known. */
  createText(chatId: string, text: string): Promise<{ messageId?: string }>
  /** im.message.create (msg_type 'interactive') for a static open-URL card. */
  createCard(chatId: string, card: Record<string, unknown>): Promise<{ messageId?: string }>
  /** im.message.reply (msg_type 'text', reply_in_thread) — the agent's reply lands in the
   *  topic thread rooted at `messageId`. Returns the new message_id when known. */
  replyText(messageId: string, text: string): Promise<{ messageId?: string }>
  /** im.message.reply (msg_type 'interactive', reply_in_thread). */
  replyCard(messageId: string, card: Record<string, unknown>): Promise<{ messageId?: string }>
  /** cardkit.card.create. */
  createCardEntity(card: Record<string, unknown>): Promise<{ cardId?: string }>
  /** im.message.create/reply with an interactive CardKit `card_id` reference. */
  createCardEntityMessage(chatId: string, cardId: string): Promise<{ messageId?: string }>
  replyCardEntityMessage(messageId: string, cardId: string): Promise<{ messageId?: string }>
  /** cardkit.cardElement.content (native typewriter update). */
  updateCardEntityElement(cardId: string, elementId: string, text: string, sequence: number): Promise<void>
  /** cardkit.card.settings + card.update terminal lifecycle. */
  setCardEntityStreaming(cardId: string, streaming: boolean, sequence: number): Promise<void>
  updateCardEntity(cardId: string, card: Record<string, unknown>, sequence: number): Promise<void>
  /** im.message.delete (retract an unfinished/no-response card). */
  deleteMessage(messageId: string): Promise<void>
  /** im.message.update (in-place text edit). */
  updateText(messageId: string, text: string): Promise<void>
  /** im.messageResource.get(...).writeFile(destPath) — auth'd resource download. */
  downloadResource(messageId: string, fileKey: string, type: 'image' | 'file', destPath: string): Promise<void>
  /** im.chat.get. */
  getChat(chatId: string): Promise<{ id: string; name?: string; chatMode?: string }>
  /** im.chatMembers.get (capped). */
  listChatMembers(chatId: string, cap: number): Promise<{ id: string; name?: string; isBot?: boolean }[]>
  /** im.chat.list (capped). */
  listChats(cap: number): Promise<{ id: string; name?: string }[]>
  /** contact.user.get. */
  getUser(userId: string): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean }>
  /** GET /open-apis/bot/v3/info — the bot's own open_id + display name. */
  getBotInfo(): Promise<{ openId?: string; name?: string }>
}

/** Opaque turn-local reference returned after the CardKit entity is visible in chat. */
export interface FeishuStreamingCard {
  cardId: string
  messageId?: string
}

/** The handle the connection holds: outbound {@link FeishuApi} + the WSClient lifecycle. */
export interface FeishuClientHandle {
  api: FeishuApi
  /** Open the WSClient long-connection, dispatching each `im.message.receive_v1` event
   *  to `onEvent`. Resolves once the first handshake succeeds. */
  startWs(onEvent: (event: FeishuRawEvent) => void): Promise<void>
  /** Close the WSClient (there is NO WSClient.stop()). */
  close(): void
}

/** Map our region enum to the SDK's gateway domain. Omitting `domain` would default to
 *  Feishu, but we pass it explicitly so the region is unambiguous at both the REST client
 *  and the WSClient long-connection. */
function regionDomain(region: FeishuRegion): Lark.Domain {
  return region === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu
}

/** Default factory: adapt a real `Lark.Client` + `Lark.WSClient` to {@link FeishuClientHandle}. */
function defaultFactory(appId: string, appSecret: string, region: FeishuRegion): FeishuClientHandle {
  const domain = regionDomain(region)
  const client = new Lark.Client({ appId, appSecret, domain, loggerLevel: Lark.LoggerLevel.error })
  let ws: Lark.WSClient | undefined

  const assertApiSuccess = <T extends { code?: number; msg?: string }>(result: T, api: string): T => {
    if (result.code === undefined || result.code === 0) return result
    throw Object.assign(new Error(`${api} failed (${result.code}): ${result.msg ?? 'unknown error'}`), {
      response: { data: result }
    })
  }

  const createMessage = async (
    chatId: string,
    msgType: 'text' | 'interactive',
    content: Record<string, unknown>
  ): Promise<{ messageId?: string }> => {
    const res = (await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) }
    })) as { data?: { message_id?: string } }
    return { messageId: res?.data?.message_id }
  }

  const replyMessage = async (
    messageId: string,
    msgType: 'text' | 'interactive',
    content: Record<string, unknown>
  ): Promise<{ messageId?: string }> => {
    const res = (await client.im.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify(content), msg_type: msgType, reply_in_thread: true }
    })) as { data?: { message_id?: string } }
    return { messageId: res?.data?.message_id }
  }

  const api: FeishuApi = {
    createText: (chatId, text) => createMessage(chatId, 'text', { text }),
    createCard: (chatId, card) => createMessage(chatId, 'interactive', card),
    replyText: (messageId, text) => replyMessage(messageId, 'text', { text }),
    replyCard: (messageId, card) => replyMessage(messageId, 'interactive', card),
    async createCardEntity(card) {
      const res = assertApiSuccess(
        await client.cardkit.v1.card.create({
          data: { type: 'card_json', data: JSON.stringify(card) }
        }),
        'cardkit.card.create'
      )
      return { cardId: res.data?.card_id }
    },
    createCardEntityMessage: (chatId, cardId) =>
      createMessage(chatId, 'interactive', { type: 'card', data: { card_id: cardId } }),
    replyCardEntityMessage: (messageId, cardId) =>
      replyMessage(messageId, 'interactive', { type: 'card', data: { card_id: cardId } }),
    async updateCardEntityElement(cardId, elementId, text, sequence) {
      assertApiSuccess(
        await client.cardkit.v1.cardElement.content({
          path: { card_id: cardId, element_id: elementId },
          data: {
            content: text,
            sequence,
            uuid: `c_${cardId}_${sequence}`
          }
        }),
        'cardkit.cardElement.content'
      )
    },
    async setCardEntityStreaming(cardId, streaming, sequence) {
      assertApiSuccess(
        await client.cardkit.v1.card.settings({
          path: { card_id: cardId },
          data: {
            settings: JSON.stringify({ config: { streaming_mode: streaming } }),
            sequence,
            uuid: `s_${cardId}_${sequence}`
          }
        }),
        'cardkit.card.settings'
      )
    },
    async updateCardEntity(cardId, card, sequence) {
      assertApiSuccess(
        await client.cardkit.v1.card.update({
          path: { card_id: cardId },
          data: {
            card: { type: 'card_json', data: JSON.stringify(card) },
            sequence,
            uuid: `u_${cardId}_${sequence}`
          }
        }),
        'cardkit.card.update'
      )
    },
    async deleteMessage(messageId) {
      await client.im.message.delete({ path: { message_id: messageId } })
    },
    async updateText(messageId, text) {
      await client.im.message.update({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text }) }
      })
    },
    async downloadResource(messageId, fileKey, type, destPath) {
      const res = (await client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type }
      })) as { writeFile: (p: string) => Promise<unknown> }
      await res.writeFile(destPath)
    },
    async getChat(chatId) {
      const res = (await client.im.chat.get({ path: { chat_id: chatId } })) as {
        data?: { name?: string; chat_mode?: string }
      }
      const d = res?.data ?? {}
      return { id: chatId, ...(d.name ? { name: d.name } : {}), ...(d.chat_mode ? { chatMode: d.chat_mode } : {}) }
    },
    async listChatMembers(chatId, cap) {
      const res = (await client.im.chatMembers.get({
        path: { chat_id: chatId },
        params: { member_id_type: 'open_id', page_size: cap }
      })) as { data?: { items?: { member_id?: string; name?: string }[] } }
      return (res?.data?.items ?? [])
        .slice(0, cap)
        .map((i) => ({ id: i.member_id ?? '', ...(i.name ? { name: i.name } : {}) }))
    },
    async listChats(cap) {
      const res = (await client.im.chat.list({ params: { page_size: cap } })) as {
        data?: { items?: { chat_id?: string; name?: string }[] }
      }
      return (res?.data?.items ?? [])
        .slice(0, cap)
        .map((i) => ({ id: i.chat_id ?? '', ...(i.name ? { name: i.name } : {}) }))
    },
    async getUser(userId) {
      const res = (await client.contact.user.get({
        path: { user_id: userId },
        params: { user_id_type: 'open_id' }
      })) as { data?: { user?: { name?: string; en_name?: string } } }
      const u = res?.data?.user ?? {}
      return { id: userId, ...(u.name ? { name: u.name } : {}), ...(u.en_name ? { realName: u.en_name } : {}) }
    },
    async getBotInfo() {
      const res = (await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })) as {
        bot?: { open_id?: string; app_name?: string }
      }
      const bot = res?.bot ?? {}
      return { ...(bot.open_id ? { openId: bot.open_id } : {}), ...(bot.app_name ? { name: bot.app_name } : {}) }
    }
  }

  return {
    api,
    async startWs(onEvent) {
      const dispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: FeishuRawEvent) => {
          onEvent(data)
        }
      })
      ws = new Lark.WSClient({ appId, appSecret, domain, loggerLevel: Lark.LoggerLevel.error })
      await ws.start({ eventDispatcher: dispatcher })
    },
    close() {
      ws?.close()
    }
  }
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
/** Cap on channels/members enumerated per read call (bounds the response). */
const CHANNEL_CAP = 200
const MEMBER_CAP = 50
const PERMISSION_NOTICE_RETRY_MS = 5 * 60_000

type FeishuPermissionIssue = 'app-permissions' | 'bot-capability' | 'app-availability' | 'chat-access'

type UnknownRecord = Record<string, unknown>
type FeishuPermissionState = { issue: FeishuPermissionIssue; scopes: string[] }

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' ? (value as UnknownRecord) : undefined
}

function feishuErrorBody(err: unknown): UnknownRecord | undefined {
  const outer = asRecord(err)
  return asRecord(asRecord(outer?.response)?.data) ?? asRecord(outer?.data) ?? outer
}

/** Feishu/Lark returns stable business codes inside the SDK's HTTP error payload.
 * Classify only documented authorization/configuration failures; rate limits,
 * malformed requests, and transient network failures must not produce a misleading
 * permission card. */
function feishuPermissionIssueFrom(err: unknown): FeishuPermissionIssue | null {
  const body = feishuErrorBody(err)
  const candidate = body?.code ?? asRecord(body?.error)?.code
  const code = typeof candidate === 'number' ? candidate : Number(candidate)
  if (code === 99991672 || code === 230027) return 'app-permissions'
  if (code === 230006 || code === 232025) return 'bot-capability'
  if (code === 230013 || code === 232034) return 'app-availability'
  if (code === 230002 || code === 230035) return 'chat-access'
  return null
}

function feishuErrorCode(err: unknown): number | undefined {
  const body = feishuErrorBody(err)
  const candidate = body?.code ?? asRecord(body?.error)?.code
  const code = typeof candidate === 'number' ? candidate : Number(candidate)
  return Number.isFinite(code) ? code : undefined
}

const FEISHU_SCOPE_RE = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)+$/

function validatedFeishuScopes(values: unknown[]): string[] {
  const scopes = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 128 || !FEISHU_SCOPE_RE.test(value)) continue
    scopes.add(value)
    if (scopes.size >= 20) break
  }
  return [...scopes]
}

/** Retain the exact missing scopes reported by Feishu/Lark instead of guessing from
 * the error code. `99991672` is shared by every API family (including contact reads),
 * so a fixed IM scope list can produce a successful but useless repair card. */
function feishuRequiredScopes(err: unknown, appId: string, region: FeishuRegion): string[] {
  const body = feishuErrorBody(err)
  const nested = asRecord(body?.error)
  const violations = Array.isArray(nested?.permission_violations)
    ? nested.permission_violations
    : Array.isArray(body?.permission_violations)
      ? body.permission_violations
      : []
  const subjects = validatedFeishuScopes(violations.map((item) => asRecord(item)?.subject))
  if (subjects.length) return subjects

  // Some API versions expose only `error.helps[].url`. Accept its q scopes only when
  // the link points to this exact app on the configured regional developer domain.
  const helps = Array.isArray(nested?.helps) ? nested.helps : Array.isArray(body?.helps) ? body.helps : []
  const expectedOrigin = region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  const expectedPath = `/app/${appId}/auth`
  for (const help of helps) {
    const candidate = asRecord(help)?.url
    if (typeof candidate !== 'string') continue
    try {
      const url = new URL(candidate)
      if (url.origin !== expectedOrigin || url.pathname !== expectedPath) continue
      const scopes = validatedFeishuScopes((url.searchParams.get('q') ?? '').split(','))
      if (scopes.length) return scopes
    } catch {
      // Ignore malformed platform help data and fall back to the app settings page.
    }
  }
  return []
}

const FEISHU_PERMISSION_NOTICE: Record<
  FeishuPermissionIssue,
  { hint: string; description: string; buttonLabel: string }
> = {
  'app-permissions': {
    hint: 'add the required API permissions, publish a new app version, and complete approval if required',
    description:
      'Add the required API permissions, publish a new app version, and complete administrator approval if required.',
    buttonLabel: 'Update permissions'
  },
  'bot-capability': {
    hint: 'enable the Bot capability and publish a new app version',
    description: 'Enable the Bot capability, then publish a new app version.',
    buttonLabel: 'Review app settings'
  },
  'app-availability': {
    hint: 'update the app availability, publish a new version, and verify tenant administrator settings',
    description: "Update the app's availability, publish a new version, and verify the tenant administrator settings.",
    buttonLabel: 'Review app settings'
  },
  'chat-access': {
    hint: 'add the bot to the chat or restore its posting permission',
    description: 'Add the bot to this chat or restore its posting permission, then try again.',
    buttonLabel: 'Review app settings'
  }
}

/** The `sourceUrl` separator normalize.ts encodes the compound download key with. */
const DOWNLOAD_KEY_SEP = ':'

/** Parse the compound download key `<messageId>:<type>:<fileKey>` (encoded by
 *  normalize's toAttachment). A message_id / image_key / file_key never contains a
 *  colon, so the messageId + type split off the front and the remainder rejoins as the
 *  colon-safe file key. Null when malformed or the type isn't a resource type. */
function parseDownloadKey(sourceUrl: string): { messageId: string; type: 'image' | 'file'; fileKey: string } | null {
  const i1 = sourceUrl.indexOf(DOWNLOAD_KEY_SEP)
  if (i1 < 0) return null
  const i2 = sourceUrl.indexOf(DOWNLOAD_KEY_SEP, i1 + 1)
  if (i2 < 0) return null
  const messageId = sourceUrl.slice(0, i1)
  const type = sourceUrl.slice(i1 + 1, i2)
  const fileKey = sourceUrl.slice(i2 + 1)
  if (!messageId || !fileKey || (type !== 'image' && type !== 'file')) return null
  return { messageId, type, fileKey }
}

export class FeishuConnection {
  private handle: FeishuClientHandle
  // All outbound writes funnel through one queue so streamed edits are FIFO-ordered
  // per connection (keeps a post-then-edit pair from racing on the same progress msg).
  private queue: SlackSendQueue
  /** CardKit sequence numbers are scoped to a card entity and must increase across
   * element, settings, and full-card updates. */
  private streamingCards = new Map<string, { sequence: number; lastText: string }>()
  /** App-level permission failures repeat across streamed writes. Announce once per
   * connection, with a bounded retry when the bot currently cannot send the card. */
  private globalPermissionIssues = new Set<Exclude<FeishuPermissionIssue, 'chat-access'>>()
  private permissionScopes = new Set<string>()
  private globalPermissionRevision = 0
  private permissionIssueChannels = new Set<string>()
  private loggedPermissionIssues = new Set<string>()
  private permissionNoticeSent = false
  private permissionNoticeInFlight = false
  private permissionNoticeRetryAt = new Map<string, number>()
  /** The appId this connection authenticated with (used to detect a swap). */
  readonly appId: string
  /** The gateway region this connection dialed (feishu.cn vs larksuite.com). Reconcile
   *  compares it so a region change on the same appId forces a reconnect rather than
   *  leaving the app bound to the old-domain client. */
  readonly region: FeishuRegion
  /** The bot's own open_id, resolved at start() (config value preferred; best-effort
   *  API fallback). Mention-routing matches this (normalize's mentionedBots are
   *  open_ids). '' when neither config nor bot/info yields one. */
  botOpenId = ''
  /** The bot's display name, best-effort (logging/parity). */
  botName = ''
  /** No workspace permalink base on Feishu (unlike Slack); '' so the daemon's deep-link
   *  base falls through to the configured / CP / local default Web App URL. */
  readonly workspaceUrl = ''

  constructor(
    private deps: FeishuDeps,
    factory: (appId: string, appSecret: string, region: FeishuRegion) => FeishuClientHandle = defaultFactory
  ) {
    this.appId = deps.group.appId
    this.region = deps.group.region
    this.handle = factory(deps.group.appId, deps.group.appSecret, deps.group.region)
    this.queue = new SlackSendQueue(deps.sendIntervalMs ?? 350)
  }

  async start(): Promise<void> {
    const log = this.deps.log
    // Resolve the bot's own open_id BEFORE opening the socket so the self-echo skip is
    // armed for the very first event. Config value wins; bot/info is a best-effort
    // fallback (a failure just leaves botOpenId '', and recordUnrouted's own check plus
    // the CP-seeded value still guard against self-triggering).
    this.botOpenId = this.deps.group.botOpenId ?? ''
    if (!this.botOpenId) {
      try {
        const info = await this.handle.api.getBotInfo()
        if (info.openId) this.botOpenId = info.openId
        if (info.name) this.botName = info.name
      } catch (err) {
        this.rememberPermissionIssue(err)
        log?.debug(`feishu: bot/info lookup failed: ${(err as Error).message}`)
      }
    }
    log?.debug(`feishu: opening WSClient long-connection (app ${this.appId}, bot ${this.botOpenId || '?'})…`)

    await this.handle.startWs((event) => {
      // The 3s constraint: ONLY normalize + hand off (which enqueues) — never await the
      // agent turn here.
      try {
        const like = this.toLike(event)
        // Skip our own messages — the agent's replies must not re-trigger a turn.
        if (like.senderOpenId && like.senderOpenId === this.botOpenId) return
        const msg = normalizeFeishuMessage(like, { traceId: this.deps.newTraceId() })
        log?.debug(
          `feishu: inbound ch=${msg.channel} user=${msg.sender.id} isBot=${msg.sender.isBot} isDm=${msg.isDm} ` +
            `mentions=[${msg.mentionedBots.join(',')}] text=${JSON.stringify(msg.text.slice(0, 80))}`
        )
        this.deps.onMessage(msg)
      } catch (err) {
        log?.debug(`feishu: inbound normalize failed: ${(err as Error).message}`)
      }
    })
    log?.debug('feishu: WSClient long-connection established')
  }

  /** Adapt a raw `im.message.receive_v1` event to the pure normalizer's plain-object
   *  view. Parses `message.content` (a JSON string) by type to derive attachments. */
  private toLike(event: FeishuRawEvent): FeishuMessageLike {
    const m = event.message ?? {}
    const senderType = event.sender?.sender_type
    return {
      messageId: m.message_id ?? '',
      chatId: m.chat_id ?? '',
      chatType: m.chat_type ?? 'group',
      messageType: m.message_type ?? 'text',
      content: m.content ?? '',
      ...(m.root_id ? { rootId: m.root_id } : {}),
      senderOpenId: event.sender?.sender_id?.open_id ?? '',
      // Feishu marks human senders 'user'; treat anything else (e.g. 'app') as a bot.
      senderIsBot: senderType != null && senderType !== 'user',
      mentions: (m.mentions ?? []).map((x) => ({
        key: x.key ?? '',
        ...(x.id ? { id: x.id } : {}),
        ...(x.name ? { name: x.name } : {})
      })),
      attachments: this.deriveAttachments(m.message_type ?? 'text', m.content ?? '')
    }
  }

  /** Derive an attachment view from a message's type + JSON content. Feishu ships an
   *  opaque key (image_key / file_key), not a URL — the connection downloads it with a
   *  tenant token at prompt-assembly time (§7.2). Empty when the type carries no file. */
  private deriveAttachments(messageType: string, content: string): FeishuAttachmentLike[] {
    try {
      const c = JSON.parse(content || '{}') as Record<string, unknown>
      if (messageType === 'image' && typeof c.image_key === 'string') {
        return [{ fileKey: c.image_key, type: 'image' }]
      }
      // Both 'file' and 'media' (video/audio) carry a file_key + file_name.
      if ((messageType === 'file' || messageType === 'media') && typeof c.file_key === 'string') {
        return [
          {
            fileKey: c.file_key,
            type: 'file',
            ...(typeof c.file_name === 'string' ? { name: c.file_name } : {})
          }
        ]
      }
      return []
    } catch {
      return []
    }
  }

  /** Send one chunk: reply INTO the topic thread when `anchor` is a message id (the
   *  session thread root, `om_…` — set for group turns by normalize), else post flat to
   *  the chat (`anchor` is the chat id `oc_…`, e.g. a p2p DM). Feishu id prefixes are
   *  stable, so the prefix cleanly separates "reply to a message" from "post to a chat".
   *  ponytail: prefix sniff over threading an isDm flag through the applier — id shapes
   *  are a Feishu guarantee. */
  private sendChunk(channel: string, anchor: string | undefined, text: string): Promise<{ messageId?: string }> {
    return anchor && anchor.startsWith('om_')
      ? this.handle.api.replyText(anchor, text)
      : this.handle.api.createText(channel, text)
  }

  private sendPermissionCard(
    channel: string,
    anchor: string | undefined,
    card: Record<string, unknown>
  ): Promise<{ messageId?: string }> {
    return anchor && anchor.startsWith('om_')
      ? this.handle.api.replyCard(anchor, card)
      : this.handle.api.createCard(channel, card)
  }

  private sendCardEntity(channel: string, anchor: string | undefined, cardId: string): Promise<{ messageId?: string }> {
    return anchor && anchor.startsWith('om_')
      ? this.handle.api.replyCardEntityMessage(anchor, cardId)
      : this.handle.api.createCardEntityMessage(channel, cardId)
  }

  private rememberPermissionIssue(err: unknown, channel?: string): boolean {
    const issue = feishuPermissionIssueFrom(err)
    if (!issue) return false
    const scopes = issue === 'app-permissions' ? feishuRequiredScopes(err, this.appId, this.region) : []
    const logKey = `${issue}:${scopes.join(',')}`
    if (!this.loggedPermissionIssues.has(logKey)) {
      this.loggedPermissionIssues.add(logKey)
      const code = feishuErrorCode(err)
      this.deps.log?.warn(
        `feishu: bot permission update required${code === undefined ? '' : ` (code ${code})`}; ` +
          FEISHU_PERMISSION_NOTICE[issue].hint
      )
    }
    // Chat access is target-specific. Without a concrete chat there is nowhere
    // accurate to display "add the bot to this chat", so keep only the diagnostic log.
    if (issue === 'chat-access') {
      if (channel && !this.permissionIssueChannels.has(channel)) {
        this.permissionIssueChannels.add(channel)
        this.permissionNoticeRetryAt.delete(`channel:${channel}`)
      }
      return true
    }

    const wasNewIssue = !this.globalPermissionIssues.has(issue)
    this.globalPermissionIssues.add(issue)
    const oldScopeCount = this.permissionScopes.size
    for (const scope of scopes) this.permissionScopes.add(scope)
    if (wasNewIssue || this.permissionScopes.size !== oldScopeCount) {
      this.globalPermissionRevision += 1
      this.permissionNoticeRetryAt.delete('global')
    }
    return true
  }

  private pendingGlobalPermission(): FeishuPermissionState | undefined {
    if (this.globalPermissionIssues.has('app-permissions')) {
      return { issue: 'app-permissions', scopes: [...this.permissionScopes] }
    }
    if (this.globalPermissionIssues.has('bot-capability')) return { issue: 'bot-capability', scopes: [] }
    if (this.globalPermissionIssues.has('app-availability')) return { issue: 'app-availability', scopes: [] }
    return undefined
  }

  private pendingPermission(channel: string): { permission: FeishuPermissionState; key: string } | undefined {
    const global = this.pendingGlobalPermission()
    if (global) return { permission: global, key: 'global' }
    return this.permissionIssueChannels.has(channel)
      ? { permission: { issue: 'chat-access', scopes: [] }, key: `channel:${channel}` }
      : undefined
  }

  private permissionUpdateUrl({ issue, scopes }: FeishuPermissionState): string | undefined {
    if (!/^cli_[A-Za-z0-9]+$/.test(this.appId)) return undefined
    const host = this.region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
    const appRoot = `${host}/app/${encodeURIComponent(this.appId)}`
    if (issue !== 'app-permissions' || scopes.length === 0) return appRoot
    const params = new URLSearchParams({
      q: scopes.join(','),
      op_from: 'openapi',
      token_type: 'tenant'
    })
    return `${appRoot}/auth?${params.toString()}`
  }

  /** Post one static permission card. Claim before the first await so concurrent
   * progress/reply failures cannot race into duplicate cards. A failed attempt is
   * retried only after a cooldown because missing send/chat access also blocks the
   * warning itself. */
  private async postPermissionUpdateCard(channel: string, anchor?: string): Promise<void> {
    const pending = this.pendingPermission(channel)
    if (
      !pending ||
      this.permissionNoticeSent ||
      this.permissionNoticeInFlight ||
      Date.now() < (this.permissionNoticeRetryAt.get(pending.key) ?? 0)
    )
      return
    const updateUrl = this.permissionUpdateUrl(pending.permission)
    if (!updateUrl) return

    const globalPermissionRevision = this.globalPermissionRevision
    this.permissionNoticeInFlight = true
    const notice = FEISHU_PERMISSION_NOTICE[pending.permission.issue]
    try {
      await this.sendPermissionCard(
        channel,
        anchor,
        buildPermissionUpdateCard(updateUrl, notice.description, notice.buttonLabel)
      )
      if (this.globalPermissionRevision === globalPermissionRevision) this.permissionNoticeSent = true
    } catch (err) {
      this.rememberPermissionIssue(err, channel)
      this.permissionNoticeRetryAt.set(
        this.pendingPermission(channel)?.key ?? pending.key,
        Date.now() + PERMISSION_NOTICE_RETRY_MS
      )
      this.deps.log?.debug(`feishu: permission update card failed (ch=${channel}): ${(err as Error).message}`)
    } finally {
      this.permissionNoticeInFlight = false
    }
  }

  /** Create a CardKit entity and publish one IM message that references it. The initial
   * card is visible immediately as `Thinking…`; later updates address the entity id. */
  async startStreamingCard(channel: string, threadAnchor?: string): Promise<FeishuStreamingCard | undefined> {
    return this.queue.enqueue(async () => {
      try {
        const created = await this.handle.api.createCardEntity(buildStreamingReplyCard())
        if (!created.cardId) throw new Error('cardkit.card.create returned no card_id')
        const sent = await this.sendCardEntity(channel, threadAnchor, created.cardId)
        this.streamingCards.set(created.cardId, { sequence: 0, lastText: '' })
        await this.postPermissionUpdateCard(channel, threadAnchor)
        return { cardId: created.cardId, ...(sent.messageId ? { messageId: sent.messageId } : {}) }
      } catch (err) {
        this.rememberPermissionIssue(err, channel)
        await this.postPermissionUpdateCard(channel, threadAnchor)
        this.deps.log?.debug(`feishu: streaming card start failed (ch=${channel}): ${(err as Error).message}`)
        return undefined
      }
    })
  }

  /** Replace the streaming markdown element with the full cumulative answer. CardKit
   * computes the incremental diff and renders it with the native typewriter effect. */
  async updateStreamingCard(channel: string, card: FeishuStreamingCard, text: string): Promise<boolean> {
    return this.queue.enqueue(async () => {
      const state = this.streamingCards.get(card.cardId)
      if (!state) return false
      if (state.lastText === text) return true
      state.sequence += 1
      try {
        await this.handle.api.updateCardEntityElement(card.cardId, FEISHU_STREAMING_ELEMENT_ID, text, state.sequence)
        state.lastText = text
        return true
      } catch (err) {
        this.rememberPermissionIssue(err, channel)
        await this.postPermissionUpdateCard(channel)
        this.deps.log?.debug(`feishu: streaming card update failed (${card.cardId}): ${(err as Error).message}`)
        return false
      }
    })
  }

  /** Close streaming mode and replace the entity with the final answer/footer card.
   * Returns false only when the final full-card update failed, allowing the daemon to
   * fall back to a normal text message instead of losing the reply. */
  async finishStreamingCard(channel: string, card: FeishuStreamingCard, text: string, link?: string): Promise<boolean> {
    return this.queue.enqueue(async () => {
      const state = this.streamingCards.get(card.cardId)
      if (!state) return false
      state.sequence += 1
      try {
        await this.handle.api.setCardEntityStreaming(card.cardId, false, state.sequence)
      } catch (err) {
        this.rememberPermissionIssue(err, channel)
        this.deps.log?.debug(`feishu: streaming card close failed (${card.cardId}): ${(err as Error).message}`)
      }

      state.sequence += 1
      let updated = false
      try {
        await this.handle.api.updateCardEntity(card.cardId, buildCompletedReplyCard(text, link), state.sequence)
        updated = true
      } catch (err) {
        this.rememberPermissionIssue(err, channel)
        this.deps.log?.debug(`feishu: streaming card final update failed (${card.cardId}): ${(err as Error).message}`)
      } finally {
        this.streamingCards.delete(card.cardId)
      }
      await this.postPermissionUpdateCard(channel)
      return updated
    })
  }

  /** Retract an unfinished Thinking card (silent/no-response or a cancelled turn). */
  async cancelStreamingCard(channel: string, card: FeishuStreamingCard): Promise<void> {
    this.streamingCards.delete(card.cardId)
    const messageId = card.messageId
    if (!messageId) return
    await this.queue.enqueue(async () => {
      try {
        await this.handle.api.deleteMessage(messageId)
      } catch (err) {
        this.rememberPermissionIssue(err, channel)
        this.deps.log?.debug(`feishu: streaming card retract failed (${messageId}): ${(err as Error).message}`)
      }
    })
  }

  /**
   * Post a message. `channel` is the chat_id; `threadAnchor` is the session thread root —
   * a message id (`om_…`) for a group turn, so the reply lands in the topic thread rooted
   * at the triggering @mention; the chat id for a p2p DM, so it posts flat. Long text is
   * chunked; returns the FIRST resulting message id.
   */
  async postMessage(channel: string, text: string, threadAnchor?: string): Promise<string | undefined> {
    return this.queue.enqueue(async () => {
      let firstId: string | undefined
      for (const chunk of chunkForFeishu(text)) {
        const res = await this.sendChunk(channel, threadAnchor, chunk).catch((err: Error) => {
          this.rememberPermissionIssue(err, channel)
          this.deps.log?.debug(`feishu: send failed (ch=${channel}): ${err.message}`)
          return null
        })
        if (res && firstId === undefined) firstId = res.messageId
      }
      await this.postPermissionUpdateCard(channel, threadAnchor)
      return firstId
    })
  }

  /**
   * Post a "chrome" message (progress / plan / reasoning / tool-output / a `/status`
   * reply) and return the new message id for later in-place edits. Threads the same way as
   * postMessage (`opts.threadTs` = the thread anchor). Best-effort: swallows send errors
   * (chrome must never break a turn). Only the first chunk is sent (chrome is short).
   */
  async postChrome(channel: string, text: string, opts: { threadTs?: string } = {}): Promise<string | undefined> {
    return this.queue.enqueue(async () => {
      try {
        const res = await this.sendChunk(channel, opts.threadTs, chunkForFeishu(text)[0] ?? '')
        await this.postPermissionUpdateCard(channel, opts.threadTs)
        return res.messageId
      } catch (err) {
        this.rememberPermissionIssue(err, channel)
        await this.postPermissionUpdateCard(channel, opts.threadTs)
        this.deps.log?.debug(`feishu: send (chrome) failed (ch=${channel}): ${(err as Error).message}`)
        return undefined
      }
    })
  }

  /** Edit a previously-posted text message in place with im.message.update. `patch`
   * is card-only in Feishu; using the text edit API keeps progress/reasoning chrome
   * refreshes valid alongside the CardKit reply. */
  async updateMessage(channel: string, messageId: string, text: string, _opts: object = {}): Promise<void> {
    await this.queue.enqueue(async () => {
      try {
        await this.handle.api.updateText(messageId, chunkForFeishu(text)[0] ?? '')
      } catch (err) {
        this.rememberPermissionIssue(err, channel)
        this.deps.log?.debug(`feishu: text update failed (id=${messageId}): ${(err as Error).message}`)
      }
      await this.postPermissionUpdateCard(channel)
    })
  }

  /** No-op — Feishu has no typing / chat-action API. Present for applier parity. */
  async sendChatAction(_channel: string): Promise<void> {
    // intentionally empty
  }

  /**
   * Download a Feishu message resource (auth'd, like Slack — unlike Discord's public
   * CDN). `sourceUrl` is the compound key `<messageId>:<type>:<fileKey>` normalize's
   * toAttachment encoded, so the single-arg generic downloadAttachment path round-trips
   * both ids here. Streams to a temp file (the SDK exposes writeFile, not a Buffer),
   * reads it under the byte cap, then cleans up. Returns null on any failure / over-cap
   * (best-effort; a failed attachment degrades to a resource_link, never breaks the
   * prompt). Bytes stay daemon-local (§9.2).
   */
  async downloadFile(sourceUrl: string, maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES): Promise<Buffer | null> {
    const parsed = parseDownloadKey(sourceUrl)
    if (!parsed) {
      this.deps.log?.debug(`feishu: downloadFile — unparseable key ${JSON.stringify(sourceUrl)}`)
      return null
    }
    const tmp = path.join(os.tmpdir(), `feishu-${randomUUID()}`)
    try {
      await this.handle.api.downloadResource(parsed.messageId, parsed.fileKey, parsed.type, tmp)
      const stat = await fs.stat(tmp).catch(() => null)
      if (stat && stat.size > maxBytes) {
        this.deps.log?.debug(`feishu: downloadFile skipped — ${stat.size} bytes > cap ${maxBytes}`)
        return null
      }
      const buf = await fs.readFile(tmp)
      if (buf.byteLength > maxBytes) {
        this.deps.log?.debug(`feishu: downloadFile discarded — ${buf.byteLength} bytes > cap ${maxBytes}`)
        return null
      }
      return buf
    } catch (err) {
      this.rememberPermissionIssue(err)
      this.deps.log?.debug(`feishu: downloadFile failed: ${(err as Error).message}`)
      return null
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }

  // ── MCP MessageGateway: read helpers backing the injected channel tools ──

  async getChannelInfo(channel: string): Promise<{ id: string; name?: string; isIm?: boolean; isPrivate?: boolean }> {
    try {
      const c = await this.handle.api.getChat(channel)
      return {
        id: channel,
        ...(c.name ? { name: c.name } : {}),
        isIm: c.chatMode === 'p2p',
        // A chat's visibility isn't reported cheaply here; treat as non-private best-effort.
        isPrivate: false
      }
    } catch (err) {
      this.rememberPermissionIssue(err, channel)
      this.deps.log?.debug(`feishu: getChat failed (ch=${channel}): ${(err as Error).message}`)
      return { id: channel }
    }
  }

  async listMembers(channel: string): Promise<{ id: string; name?: string; isBot?: boolean }[]> {
    try {
      return await this.handle.api.listChatMembers(channel, MEMBER_CAP)
    } catch (err) {
      this.rememberPermissionIssue(err, channel)
      this.deps.log?.debug(`feishu: listMembers failed (ch=${channel}): ${(err as Error).message}`)
      return []
    }
  }

  async listChannels(): Promise<{ id: string; name?: string; isPrivate?: boolean }[]> {
    try {
      return (await this.handle.api.listChats(CHANNEL_CAP)).map((c) => ({
        id: c.id,
        ...(c.name ? { name: c.name } : {}),
        isPrivate: false
      }))
    } catch (err) {
      this.rememberPermissionIssue(err)
      this.deps.log?.debug(`feishu: listChannels failed: ${(err as Error).message}`)
      return []
    }
  }

  async getUserProfile(user: string): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean }> {
    try {
      return await this.handle.api.getUser(user)
    } catch (err) {
      this.rememberPermissionIssue(err)
      return { id: user }
    }
  }

  async stop(): Promise<void> {
    this.handle.close()
  }
}
