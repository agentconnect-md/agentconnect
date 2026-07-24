import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as Lark from '@larksuiteoapi/node-sdk'
import type { Agent } from '../agents/agent-schema.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { Logger } from '../log.js'
import { SlackSendQueue } from '../slack/send-queue.js'
import { normalizeFeishuMessage, type FeishuAttachmentLike, type FeishuMessageLike } from './normalize.js'
import { chunkForFeishu } from './render.js'

/**
 * §Feishu / Lark edge unit. Mirrors discord/connection.ts but over the official
 * SDK's `Lark.WSClient` long-connection (an OUTBOUND WebSocket, so it works behind
 * NAT like Slack Socket Mode / Telegram long-polling / Discord Gateway). One WSClient
 * per unique appId (one self-built app = one bot).
 *
 * v1 is TEXT-ONLY: `postMessage`/`postChrome` send `msg_type:'text'` (content is the
 * Feishu JSON wrapper `{"text":…}`) chunked to a safe cap, `sendChatAction` is a no-op
 * (Feishu has no typing API), and control actions (`/status`, `/models`, …) are TYPED
 * TEXT COMMANDS routed through the normal onMessage path — there is NO native slash
 * registration and NO interactive card in v1 (that's a v2 enhancement).
 *
 * Attachments need AUTH to download (like Slack, unlike Discord): the inbound event
 * carries an opaque `image_key`/`file_key`, fetched via `im.messageResource.get` with a
 * tenant token the SDK maintains internally. Bytes stay daemon-local (§9.2).
 */

/** One WSClient long-connection per unique appId (one self-built app = one bot). */
export interface ConsolidatedFeishuGroup {
  appId: string
  appSecret: string
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
  // NOTE: no onCallback/onStatusAction/onSelectAction in v1 (no interactive cards).
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
  /** im.message.reply (msg_type 'text', reply_in_thread) — the agent's reply lands in the
   *  topic thread rooted at `messageId`. Returns the new message_id when known. */
  replyText(messageId: string, text: string): Promise<{ messageId?: string }>
  /** im.message.patch (in-place text edit). */
  patchText(messageId: string, text: string): Promise<void>
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

/** The handle the connection holds: outbound {@link FeishuApi} + the WSClient lifecycle. */
export interface FeishuClientHandle {
  api: FeishuApi
  /** Open the WSClient long-connection, dispatching each `im.message.receive_v1` event
   *  to `onEvent`. Resolves once the first handshake succeeds. */
  startWs(onEvent: (event: FeishuRawEvent) => void): Promise<void>
  /** Close the WSClient (there is NO WSClient.stop()). */
  close(): void
}

/** Default factory: adapt a real `Lark.Client` + `Lark.WSClient` to {@link FeishuClientHandle}. */
function defaultFactory(appId: string, appSecret: string): FeishuClientHandle {
  const client = new Lark.Client({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error })
  let ws: Lark.WSClient | undefined

  const api: FeishuApi = {
    async createText(chatId, text) {
      const res = (await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }
      })) as { data?: { message_id?: string } }
      return { messageId: res?.data?.message_id }
    },
    async replyText(messageId, text) {
      const res = (await client.im.message.reply({
        path: { message_id: messageId },
        data: { content: JSON.stringify({ text }), msg_type: 'text', reply_in_thread: true }
      })) as { data?: { message_id?: string } }
      return { messageId: res?.data?.message_id }
    },
    async patchText(messageId, text) {
      await client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify({ text }) }
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
      ws = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error })
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
  /** The appId this connection authenticated with (used to detect a swap). */
  readonly appId: string
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
    factory: (appId: string, appSecret: string) => FeishuClientHandle = defaultFactory
  ) {
    this.appId = deps.group.appId
    this.handle = factory(deps.group.appId, deps.group.appSecret)
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
          this.deps.log?.debug(`feishu: send failed (ch=${channel}): ${err.message}`)
          return null
        })
        if (res && firstId === undefined) firstId = res.messageId
      }
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
        return res.messageId
      } catch (err) {
        this.deps.log?.debug(`feishu: send (chrome) failed (ch=${channel}): ${(err as Error).message}`)
        return undefined
      }
    })
  }

  /**
   * Edit a previously-posted message in place (im.message.patch, text). `channel` is
   * accepted for parity (Feishu edits by message_id only). Best-effort: a patch failure
   * degrades harmlessly (the streamed progress just doesn't refresh). Only the first
   * chunk is shown (progress messages are short).
   */
  async updateMessage(_channel: string, messageId: string, text: string, _opts: object = {}): Promise<void> {
    await this.queue.enqueue(async () => {
      try {
        await this.handle.api.patchText(messageId, chunkForFeishu(text)[0] ?? '')
      } catch (err) {
        this.deps.log?.debug(`feishu: patch failed (id=${messageId}): ${(err as Error).message}`)
      }
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
      this.deps.log?.debug(`feishu: getChat failed (ch=${channel}): ${(err as Error).message}`)
      return { id: channel }
    }
  }

  async listMembers(channel: string): Promise<{ id: string; name?: string; isBot?: boolean }[]> {
    try {
      return await this.handle.api.listChatMembers(channel, MEMBER_CAP)
    } catch (err) {
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
      this.deps.log?.debug(`feishu: listChannels failed: ${(err as Error).message}`)
      return []
    }
  }

  async getUserProfile(user: string): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean }> {
    try {
      return await this.handle.api.getUser(user)
    } catch {
      return { id: user }
    }
  }

  async stop(): Promise<void> {
    this.handle.close()
  }
}
