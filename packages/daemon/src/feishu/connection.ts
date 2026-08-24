import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as Lark from '@larksuiteoapi/node-sdk'
import type {
  FeishuRegion,
  WireFeishuCardActionEvent,
  WireFeishuCardActionResponse,
  WireFeishuCardActionTarget
} from '@agentconnect.md/protocol'
import type { Agent } from '../agents/agent-schema.js'
import { integrationCore, platformIntegrationConfig } from '../platforms/integration-config.js'
import type { ReplyAttributionInfo } from '../messages/attribution.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { Logger } from '../log.js'
import { isSendQueueTimeout, PlatformSendQueue } from '../platforms/send-queue.js'
import type { UploadAnchor, UploadFailReason, UploadOutcome } from '../mcp/ops/context.js'
import {
  extractFeishuMessageText,
  feishuEventToMessageLike,
  normalizeFeishuMessage,
  type FeishuMention,
  type FeishuRawEvent
} from './normalize.js'
import {
  buildCompletedReplyCard,
  buildPermissionUpdateCard,
  buildStreamingReplyCard,
  chunkForFeishu,
  FEISHU_REPLY_ACTION_VALUE,
  FEISHU_REPLY_CANCEL_OPTION,
  FEISHU_STREAMING_ELEMENT_ID
} from './render.js'
import type {
  InteractionActor,
  PlatformChannelHistoryOptions,
  PlatformChannelHistoryPage,
  PlatformConnection
} from '../platforms/contract.js'

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

/** One provider client per unique appId (one self-built app = one bot). */
export interface ConsolidatedFeishuGroup {
  appId: string
  appSecret: string
  /** Direct owns the SDK long connection; shared keeps provider APIs send-only. */
  mode: 'direct' | 'shared'
  /** Open-platform gateway the SDK talks to: 'feishu' (open.feishu.cn, default) vs
   *  'lark' (open.larksuite.com). Same across an appId (an app is region-scoped);
   *  taken from the first integration for the appId. */
  region: FeishuRegion
  /** From the first integration's feishu.botOpenId (same across the appId). */
  botOpenId?: string
  integrations: { agentId: string; integrationId: string }[]
}

/** §6.1 analog: group Feishu integrations by appId (one provider client per app). */
/** §7.5 opaque identity of one Feishu provider client. Feishu needed a composite
 *  key long before the registry existed (the daemon carried a private
 *  `feishuConnKey` for it): an app is region-scoped, and direct vs shared decide
 *  whether a long connection is opened at all, so all three fields identify it. */
export function feishuConnKey(c: { appId: string; region: string; mode: 'direct' | 'shared' }): string {
  return `${c.appId}\u0000${c.region}\u0000${c.mode}`
}

export function consolidateFeishu(agents: Agent[]): Map<string, ConsolidatedFeishuGroup> {
  const groups = new Map<string, ConsolidatedFeishuGroup>()
  for (const a of agents) {
    for (const int of a.integrations) {
      if (int.platform !== 'feishu') continue
      // §6.4: config validated by this platform's module schema; invalid ⇒ no
      // connection. The ingress mode is a core-envelope read.
      const feishu = platformIntegrationConfig('feishu', int)
      if (!feishu) continue
      const k = feishu.appId
      const g = groups.get(k) ?? {
        appId: k,
        appSecret: feishu.appSecret,
        mode: integrationCore(int).mode,
        region: feishu.region,
        ...(feishu.botOpenId ? { botOpenId: feishu.botOpenId } : {}),
        integrations: []
      }
      // A later integration on the same app may carry the botOpenId the first lacked.
      if (!g.botOpenId && feishu.botOpenId) g.botOpenId = feishu.botOpenId
      g.integrations.push({ agentId: a.id, integrationId: int.id })
      groups.set(k, g)
    }
  }
  return groups
}

export interface FeishuDeps {
  group: ConsolidatedFeishuGroup
  onMessage: (msg: NormalizedMessage) => void
  /** Fired when a user selects Cancel run from an active reply card's overflow menu.
   * The connection resolves the callback message id to the turn's local session key. */
  onStatusAction?: (a: { kind: 'cancel'; sessionKey: string; actor?: InteractionActor }) => void
  newTraceId: () => string
  log?: Logger
  /** Min spacing (ms) between outbound writes (serialized send-queue). Tests pass 0. */
  sendIntervalMs?: number
}

/** The raw `card.action.trigger` body delivered by the Lark WSClient. CardKit v2
 * nests message/chat ids under `context`; root-level fallbacks cover older payloads. */
export type FeishuRawCardActionEvent = WireFeishuCardActionEvent
export type FeishuCardActionResponse = WireFeishuCardActionResponse

export interface FeishuHistoryItem {
  message_id?: string
  thread_id?: string
  msg_type?: string
  create_time?: string
  sender?: { id: string; sender_type: string; open_bot_id?: string }
  body?: { content: string }
  mentions?: { key: string; id: string; name: string }[]
}

export interface FeishuHistoryPage {
  items: FeishuHistoryItem[]
  hasMore: boolean
  nextCursor?: string
}

export interface FeishuHistoryRequest {
  cursor?: string
  limit: number
  startTime?: string
  endTime?: string
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
  /** im.message.list, newest-first and limited to chat/thread roots. */
  listMessages(chatId: string, request: FeishuHistoryRequest): Promise<FeishuHistoryPage>
  /** cardkit.card.create. */
  createCardEntity(card: Record<string, unknown>): Promise<{ cardId?: string }>
  /** im.message.create/reply with an interactive CardKit `card_id` reference. */
  createCardEntityMessage(chatId: string, cardId: string): Promise<{ messageId?: string }>
  replyCardEntityMessage(messageId: string, cardId: string): Promise<{ messageId?: string }>
  /** cardkit.cardElement.content (native typewriter update). */
  updateCardEntityElement(cardId: string, elementId: string, text: string, sequence: number): Promise<void>
  /** cardkit.card.settings closes the native stream before the final message patch. */
  setCardEntityStreaming(cardId: string, streaming: boolean, sequence: number): Promise<void>
  /** im.message.patch materializes the final card JSON so message history can read it. */
  patchCardMessage(messageId: string, card: Record<string, unknown>): Promise<void>
  /** im.message.delete (retract an unfinished/no-response card). */
  deleteMessage(messageId: string): Promise<void>
  /** im.message.update (in-place text edit). */
  updateText(messageId: string, text: string): Promise<void>
  /** im.messageResource.get(...).writeFile(destPath) — auth'd resource download. */
  downloadResource(messageId: string, fileKey: string, type: 'image' | 'file', destPath: string): Promise<void>
  /** im.image.create — host bytes and get the `image_key` a message can then reference.
   *  Feishu splits hosting from sending, so an outbound image is always two calls. */
  uploadImage(bytes: Buffer): Promise<{ imageKey?: string }>
  /** im.message.create/reply (msg_type 'image') for an already-hosted `image_key`. */
  createImage(chatId: string, imageKey: string): Promise<{ messageId?: string }>
  replyImage(messageId: string, imageKey: string): Promise<{ messageId?: string }>
  /** im.chat.get. */
  getChat(chatId: string): Promise<{ id: string; name?: string; chatMode?: string }>
  /** im.chatMembers.get (capped). */
  listChatMembers(chatId: string, cap: number): Promise<{ id: string; name?: string; isBot?: boolean }[]>
  /** im.chat.list (capped). */
  listChats(cap: number): Promise<{ id: string; name?: string }[]>
  /** contact.user.get. */
  getUser(
    userId: string,
    userIdType: 'open_id' | 'union_id'
  ): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean; avatarUrl?: string }>
  /** GET /open-apis/bot/v3/info — the bot's own open_id + display name. */
  getBotInfo(): Promise<{ openId?: string; name?: string }>
}

/** Map a Feishu send error to the port's typed failure vocabulary via the permission sniffer. */
function classifyFeishuUploadError(err: unknown): UploadFailReason {
  const issue = feishuPermissionIssueFrom(err)
  if (issue === 'app-permissions') return 'missing_scope'
  if (issue) return 'forbidden'
  return 'platform_error'
}

/** Opaque turn-local reference returned after the CardKit entity is visible in chat. */
export interface FeishuStreamingCard {
  cardId: string
  messageId?: string
}

export interface FeishuStreamingCardControls {
  sessionKey: string
  sessionUrl: string
  target?: WireFeishuCardActionTarget
}

/** The handle the connection holds: outbound {@link FeishuApi} + the WSClient lifecycle. */
export interface FeishuClientHandle {
  api: FeishuApi
  /** Open the WSClient long-connection, dispatching inbound messages and CardKit
   * interactions. Resolves once the first handshake succeeds. */
  startWs(
    onEvent: (event: FeishuRawEvent) => void,
    onCardAction: (event: FeishuRawCardActionEvent) => FeishuCardActionResponse | undefined
  ): Promise<void>
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
  const client = new Lark.Client({
    appId,
    appSecret,
    domain,
    logger: feishuSdkLogger,
    loggerLevel: Lark.LoggerLevel.error
  })
  let ws: Lark.WSClient | undefined

  const assertApiSuccess = <T extends { code?: number; msg?: string }>(result: T, api: string): T => {
    if (result.code === undefined || result.code === 0) return result
    throw Object.assign(new Error(`${api} failed (${result.code}): ${result.msg ?? 'unknown error'}`), {
      response: { data: result }
    })
  }

  const createMessage = async (
    chatId: string,
    msgType: 'text' | 'interactive' | 'image',
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
    msgType: 'text' | 'interactive' | 'image',
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
    async listMessages(chatId, request) {
      const res = assertApiSuccess(
        await client.im.message.list({
          params: {
            container_id_type: 'chat',
            container_id: chatId,
            sort_type: 'ByCreateTimeDesc',
            page_size: request.limit,
            card_msg_content_type: 'user_card_content',
            only_thread_root_messages: true,
            ...(request.cursor ? { page_token: request.cursor } : {}),
            ...(request.startTime ? { start_time: request.startTime } : {}),
            ...(request.endTime ? { end_time: request.endTime } : {})
          }
        }),
        'im.message.list'
      )
      const data = res.data ?? {}
      const nextCursor = data.page_token?.trim() || undefined
      return {
        items: data.items ?? [],
        hasMore: Boolean(data.has_more || nextCursor),
        ...(nextCursor ? { nextCursor } : {})
      }
    },
    createImage: (chatId, imageKey) => createMessage(chatId, 'image', { image_key: imageKey }),
    replyImage: (messageId, imageKey) => replyMessage(messageId, 'image', { image_key: imageKey }),
    async uploadImage(bytes) {
      const res = (await client.im.image.create({
        data: { image_type: 'message', image: bytes }
      })) as { data?: { image_key?: string } }
      return { imageKey: res?.data?.image_key }
    },
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
    async patchCardMessage(messageId, card) {
      assertApiSuccess(
        await client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(card) }
        }),
        'im.message.patch'
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
    async getUser(userId, userIdType) {
      const res = (await client.contact.user.get({
        path: { user_id: userId },
        params: { user_id_type: userIdType }
      })) as {
        data?: {
          user?: {
            name?: string
            en_name?: string
            avatar?: { avatar_72?: string; avatar_240?: string; avatar_origin?: string }
          }
        }
      }
      const u = res?.data?.user ?? {}
      const avatarUrl = u.avatar?.avatar_72 ?? u.avatar?.avatar_240 ?? u.avatar?.avatar_origin
      return {
        id: userId,
        ...(u.name ? { name: u.name } : {}),
        ...(u.en_name ? { realName: u.en_name } : {}),
        ...(avatarUrl ? { avatarUrl } : {})
      }
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
    async startWs(onEvent, onCardAction) {
      const dispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: FeishuRawEvent) => {
          onEvent(data)
        },
        'card.action.trigger': async (data: FeishuRawCardActionEvent) => {
          return onCardAction(data)
        }
      })
      ws = new Lark.WSClient({
        appId,
        appSecret,
        domain,
        logger: feishuSdkLogger,
        loggerLevel: Lark.LoggerLevel.error
      })
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
const FEISHU_CHANNEL_HISTORY_DEFAULT_LIMIT = 50
const FEISHU_CHANNEL_HISTORY_MAX_LIMIT = 50
const PERMISSION_NOTICE_RETRY_MS = 5 * 60_000

type FeishuPermissionIssue = 'app-permissions' | 'bot-capability' | 'app-availability' | 'chat-access'

type UnknownRecord = Record<string, unknown>
type FeishuPermissionState = { issue: FeishuPermissionIssue; scopes: string[] }

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' ? (value as UnknownRecord) : undefined
}

export function feishuSdkErrorSummary(values: unknown[]): string {
  let httpStatus: number | undefined
  let providerCode: number | undefined

  const visit = (value: unknown, depth = 0): void => {
    if (depth > 4) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    const record = asRecord(value)
    if (!record) return
    if (httpStatus === undefined && typeof record.status === 'number' && record.status >= 100 && record.status < 600) {
      httpStatus = record.status
    }
    const code = typeof record.code === 'number' ? record.code : Number(record.code)
    if (providerCode === undefined && Number.isFinite(code)) providerCode = code
    for (const key of ['response', 'data', 'error', 'cause']) visit(record[key], depth + 1)
  }

  visit(values)
  const details = [
    httpStatus === undefined ? '' : `http=${httpStatus}`,
    providerCode === undefined ? '' : `code=${providerCode}`
  ]
    .filter(Boolean)
    .join(' ')
  return details ? `feishu SDK error (${details})` : 'feishu SDK error'
}

export const feishuSdkLogger: Lark.Logger = {
  error: (...values) => console.error(`[agentconnect] ERROR ${feishuSdkErrorSummary(values)}`),
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined
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

export class FeishuConnection implements PlatformConnection {
  private handle: FeishuClientHandle
  // All outbound writes funnel through one queue so streamed edits are FIFO-ordered
  // per connection (keeps a post-then-edit pair from racing on the same progress msg).
  private queue: PlatformSendQueue
  /** CardKit sequence numbers are scoped to a card entity and increase across element and settings updates. */
  private streamingCards = new Map<
    string,
    { sequence: number; lastText: string; messageId: string; sessionUrl?: string }
  >()
  /** Card actions identify their source message, so active reply messages resolve back
   * to the daemon's local session key without putting that key in client-visible JSON. */
  private cardSessions = new Map<string, { channel: string; sessionKey: string }>()
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
  readonly mode: 'direct' | 'shared'
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
    this.mode = deps.group.mode
    this.handle = factory(deps.group.appId, deps.group.appSecret, deps.group.region)
    this.queue = new PlatformSendQueue(deps.sendIntervalMs ?? 350)
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
    if (this.mode === 'shared') {
      log?.debug(`feishu: send-only HTTP client ready (app ${this.appId}, bot ${this.botOpenId || '?'})`)
      return
    }
    log?.debug(`feishu: opening WSClient long-connection (app ${this.appId}, bot ${this.botOpenId || '?'})…`)

    await this.handle.startWs(
      (event) => {
        // The 3s constraint: ONLY normalize + hand off (which enqueues) — never await the
        // agent turn here.
        try {
          const like = feishuEventToMessageLike(event)
          // Skip our own messages — the agent's replies must not re-trigger a turn.
          if (like.senderOpenId && like.senderOpenId === this.botOpenId) return
          if (!like.senderUnionId) return
          const msg = normalizeFeishuMessage(like, { traceId: this.deps.newTraceId() })
          log?.debug(
            `feishu: inbound ch=${msg.channel} user=${msg.sender.id} isBot=${msg.sender.isBot} isDm=${msg.isDm} ` +
              `mentions=[${msg.mentionedBots.join(',')}] text=${JSON.stringify(msg.text.slice(0, 80))}`
          )
          this.deps.onMessage(msg)
        } catch (err) {
          log?.debug(`feishu: inbound normalize failed: ${(err as Error).message}`)
        }
      },
      (event) => this.handleCardAction(event)
    )
    log?.debug('feishu: WSClient long-connection established')
  }

  /** Resolve an active reply's overflow selection and acknowledge it within Lark's
   * callback deadline. The daemon owns the actual cancellation and resulting card
   * lifecycle; removing the mapping first makes redelivered clicks idempotent. */
  handleCardAction(event: FeishuRawCardActionEvent): FeishuCardActionResponse | undefined {
    const messageId = event.context?.open_message_id ?? event.open_message_id
    const channel = event.context?.open_chat_id ?? event.open_chat_id
    const actorId = event.operator?.open_id ?? event.operator?.user_id
    const value = asRecord(event.action?.value)
    if (
      !messageId ||
      !actorId ||
      event.action?.tag !== 'overflow' ||
      event.action.option !== FEISHU_REPLY_CANCEL_OPTION ||
      value?.action !== FEISHU_REPLY_ACTION_VALUE
    )
      return undefined

    const target = this.cardSessions.get(messageId)
    if (!target || (channel && target.channel !== channel) || !this.deps.onStatusAction) return undefined
    this.cardSessions.delete(messageId)
    this.deps.onStatusAction({
      kind: 'cancel',
      sessionKey: target.sessionKey,
      actor: { userId: actorId }
    })
    return { toast: { type: 'info', content: 'Cancellation requested.' } }
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

  private sendImage(channel: string, anchor: string | undefined, imageKey: string): Promise<{ messageId?: string }> {
    return anchor && anchor.startsWith('om_')
      ? this.handle.api.replyImage(anchor, imageKey)
      : this.handle.api.createImage(channel, imageKey)
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
  async startStreamingCard(
    channel: string,
    threadAnchor?: string,
    controls?: FeishuStreamingCardControls
  ): Promise<FeishuStreamingCard | undefined> {
    return this.queue.enqueue(async () => {
      try {
        const created = await this.handle.api.createCardEntity(
          buildStreamingReplyCard(controls?.sessionUrl, controls?.target)
        )
        if (!created.cardId) throw new Error('cardkit.card.create returned no card_id')
        const sent = await this.sendCardEntity(channel, threadAnchor, created.cardId)
        if (!sent.messageId) throw new Error('CardKit IM send returned no message_id')
        this.streamingCards.set(created.cardId, {
          sequence: 0,
          lastText: '',
          messageId: sent.messageId,
          ...(controls ? { sessionUrl: controls.sessionUrl } : {})
        })
        if (controls) {
          this.cardSessions.set(sent.messageId, { channel, sessionKey: controls.sessionKey })
        }
        await this.postPermissionUpdateCard(channel, threadAnchor)
        return { cardId: created.cardId, messageId: sent.messageId }
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
  async finishStreamingCard(
    channel: string,
    card: FeishuStreamingCard,
    text: string,
    attribution?: ReplyAttributionInfo
  ): Promise<boolean> {
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

      let updated = false
      try {
        await this.handle.api.patchCardMessage(
          state.messageId,
          buildCompletedReplyCard(text, attribution, state.sessionUrl)
        )
        updated = true
      } catch (err) {
        this.rememberPermissionIssue(err, channel)
        this.deps.log?.debug(`feishu: streaming card final update failed (${card.cardId}): ${(err as Error).message}`)
      } finally {
        this.cardSessions.delete(state.messageId)
        this.streamingCards.delete(card.cardId)
      }
      await this.postPermissionUpdateCard(channel)
      return updated
    })
  }

  /** Retract an unfinished Thinking card (silent/no-response or a cancelled turn). */
  async cancelStreamingCard(channel: string, card: FeishuStreamingCard): Promise<void> {
    const state = this.streamingCards.get(card.cardId)
    if (state) this.cardSessions.delete(state.messageId)
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
   * Put a file into a chat — the mirror of {@link downloadFile}. Feishu splits hosting from
   * sending, so this is `im.image.create` for the bytes and then a `msg_type: image` message
   * that references the returned key.
   *
   * An image message carries NO caption, so `comment` is a second message — sent AFTER the
   * image, so a failed image leaves the chat untouched rather than stranding a caption for a
   * picture that never arrived. The image is therefore the anchor. Images only: everything
   * forwardable today is one, and Feishu's file endpoint needs a `file_type` this has no
   * honest value for.
   */
  async uploadFile(
    channel: string,
    file: { bytes: Buffer; name: string; mimeType?: string },
    comment?: string,
    anchor?: UploadAnchor,
    _identity?: unknown
  ): Promise<UploadOutcome> {
    if (file.mimeType && !file.mimeType.startsWith('image/')) {
      this.deps.log?.debug(`feishu: uploadFile refused ${file.name} (${file.mimeType}) — images only`)
      return { ok: false, reason: 'platform_error' }
    }
    // REFUSE an anchor this platform cannot honor rather than repurpose it: `sendImage`
    // prefix-sniffs, so an unrecognized anchor would silently become a chat-ROOT post — in
    // topic mode a brand-new topic reported as success. A DM's anchor is its chat id.
    const threadAnchor = anchor?.thread
    if (threadAnchor !== undefined && !threadAnchor.startsWith('om_') && threadAnchor !== channel) {
      this.deps.log?.debug(`feishu: uploadFile refused unhonorable anchor (ch=${channel})`)
      return { ok: false, reason: 'not_found' }
    }
    const task: Promise<UploadOutcome> = this.queue.enqueue(async () => {
      try {
        const { imageKey } = await this.handle.api.uploadImage(file.bytes)
        if (!imageKey) {
          this.deps.log?.debug(`feishu: uploadFile got no image key for ${file.name}`)
          return { ok: false, reason: 'platform_error' }
        }
        let sent: { messageId?: string }
        try {
          sent = await this.sendImage(channel, threadAnchor, imageKey)
        } catch (err) {
          this.rememberPermissionIssue(err, channel)
          this.deps.log?.debug(`feishu: uploadFile ${file.name} → ch=${channel} failed: ${(err as Error).message}`)
          return { ok: false, reason: classifyFeishuUploadError(err) }
        }
        const posted = { ok: true as const, ...(sent.messageId !== undefined ? { messageId: sent.messageId } : {}) }
        // A long caption is several messages, so the warning has to say whether NONE or only
        // SOME of it landed: an agent told the whole caption failed would re-send all of it and
        // duplicate the chunks that did post — the very duplication the ordering above avoids.
        let landed = 0
        try {
          for (const chunk of comment ? chunkForFeishu(comment) : []) {
            await this.sendChunk(channel, threadAnchor, chunk)
            landed += 1
          }
          return posted
        } catch (err) {
          this.rememberPermissionIssue(err, channel)
          this.deps.log?.debug(`feishu: uploadFile caption failed (ch=${channel}): ${(err as Error).message}`)
          const lost = landed > 0 ? 'part of its caption' : 'its caption'
          return { ...posted, warning: `the image was sent, but ${lost} did not post` }
        }
      } catch (err) {
        this.rememberPermissionIssue(err, channel)
        this.deps.log?.debug(`feishu: uploadFile ${file.name} → ch=${channel} failed: ${(err as Error).message}`)
        return { ok: false, reason: classifyFeishuUploadError(err) }
      }
    })
    return task.catch((err) => ({
      ok: false,
      reason: isSendQueueTimeout(err) ? 'indeterminate' : 'platform_error'
    }))
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

  /** Fetch one bounded, provider-paginated page of Feishu/Lark chat roots. */
  async getChannelHistory(
    channel: string,
    options: PlatformChannelHistoryOptions = {}
  ): Promise<PlatformChannelHistoryPage> {
    const limit = Math.min(
      Math.max(options.limit ?? FEISHU_CHANNEL_HISTORY_DEFAULT_LIMIT, 1),
      FEISHU_CHANNEL_HISTORY_MAX_LIMIT
    )
    try {
      const oldest = options.oldest === undefined ? undefined : Number(options.oldest)
      const latest = options.latest === undefined ? undefined : Number(options.latest)
      if ((oldest !== undefined && !Number.isFinite(oldest)) || (latest !== undefined && !Number.isFinite(latest))) {
        throw new Error('invalid timestamp bound')
      }
      const page = await this.handle.api.listMessages(channel, {
        limit,
        ...(options.cursor ? { cursor: options.cursor } : {}),
        ...(oldest !== undefined ? { startTime: String(Math.floor(oldest / 1000)) } : {}),
        ...(latest !== undefined ? { endTime: String(Math.ceil(latest / 1000)) } : {})
      })
      const messages = page.items.flatMap((message) => {
        if (!message.create_time || !/^\d+$/.test(message.create_time)) return []
        const timestamp = Number(message.create_time)
        if ((oldest !== undefined && timestamp < oldest) || (latest !== undefined && timestamp > latest)) return []
        const mentions: FeishuMention[] = (message.mentions ?? []).map((mention) => ({
          key: mention.key,
          id: { open_id: mention.id },
          name: mention.name
        }))
        return [
          {
            sender: message.sender?.id || message.sender?.open_bot_id || 'unknown',
            ts: message.create_time,
            text: extractFeishuMessageText(message.msg_type ?? 'text', message.body?.content ?? '', mentions),
            isBot: message.sender?.sender_type === 'app',
            ...(message.thread_id ? { threadTs: message.thread_id } : {})
          }
        ]
      })
      return {
        messages,
        hasMore: page.hasMore,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      }
    } catch (err) {
      this.rememberPermissionIssue(err, channel)
      const code = feishuErrorCode(err)
      this.deps.log?.debug(`feishu: channel history failed (ch=${channel}): ${code ?? 'unknown'}`)
      throw new Error(code === undefined ? 'Feishu channel history failed' : `Feishu channel history failed: ${code}`)
    }
  }

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

  async getUserProfile(
    user: string
  ): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean; avatarUrl?: string }> {
    try {
      // Message senders use union_id (`on_…`); callback actors and mentions may
      // still be provider-native open_id values (`ou_…`).
      return await this.handle.api.getUser(user, user.startsWith('on_') ? 'union_id' : 'open_id')
    } catch (err) {
      this.rememberPermissionIssue(err)
      return { id: user }
    }
  }

  async stop(): Promise<void> {
    this.streamingCards.clear()
    this.cardSessions.clear()
    this.handle.close()
  }
}
