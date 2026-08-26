import { Bot, InputFile } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import type { Agent } from '../agents/agent-schema.js'
import { platformIntegrationConfig } from '../platforms/integration-config.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { Logger } from '../log.js'
import { isSendQueueTimeout, PlatformSendQueue } from '../platforms/send-queue.js'
import type { UploadAnchor, UploadFailReason, UploadOutcome } from '../mcp/ops/context.js'
import { isTelegramMembershipServiceMessage, normalizeTelegramMessage, type TelegramMessage } from './normalize.js'
import type { PlatformConnection, PlatformReactionIntent } from '../platforms/contract.js'

/** Core names the intent; Telegram's alphabet is a fixed set of literal emoji. */
const TELEGRAM_REACTION_EMOJI: Record<PlatformReactionIntent, ReactionTypeEmoji['emoji']> = { seen: '👀' }

/** Map a Telegram Bot API error to the port's typed failure vocabulary, from its description. */
function classifyTelegramUploadError(err: unknown): UploadFailReason {
  const text = `${(err as { description?: string }).description ?? ''} ${(err as Error).message ?? ''}`
  if (/not found|not enough rights to send|chat not found/i.test(text) && /chat|topic|thread|message/i.test(text))
    return 'not_found'
  if (/too (big|large)|file is too|entity too large/i.test(text)) return 'too_large'
  if (/not enough rights|forbidden|bot was kicked|have no rights/i.test(text)) return 'forbidden'
  return 'platform_error'
}

/** Telegram truncates a caption past this instead of rejecting it, so we never send one longer. */
const TELEGRAM_CAPTION_LIMIT = 1024

/**
 * §Telegram edge unit. Mirrors slack/connection.ts but over grammY long-polling
 * (getUpdates) — an OUTBOUND long-lived connection, so it works behind NAT just
 * like Slack Socket Mode. One connection per bot token.
 *
 * Control surface: unlike Slack (interactive status bar + modal), Telegram exposes
 * session state and controls via slash commands — `/status`, `/stop`, `/cancel`, `/resume`,
 * `/fast`, `/queue`, parsed by the daemon like any inbound text. start() registers
 * them with BotFather (setMyCommands) so they autocomplete in the Telegram UI.
 */

/** The bot commands advertised to Telegram (setMyCommands) so they autocomplete.
 *  The daemon parses the actual invocations (commands/commands.ts); this list is
 *  purely the client-side menu. */
const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'status', description: 'Show session model, context, and token usage' },
  { command: 'stop', description: 'Stop the current turn and mute until you @mention me' },
  { command: 'cancel', description: 'Cancel the current turn (keep the session live)' },
  { command: 'resume', description: 'Reset loop protection and unmute this conversation' },
  { command: 'fast', description: 'Toggle fast mode — /fast on | off' },
  { command: 'models', description: 'Choose the model — /models [name] (bare = list)' },
  { command: 'effort', description: 'Choose reasoning effort — /effort [level] (bare = list)' },
  { command: 'permission', description: 'Choose permission mode — /permission [mode] (bare = list)' },
  { command: 'queue', description: 'Queue a message to run when idle — /queue <text>' }
]

/** One Telegram long-poll connection per unique bot token. */
export interface ConsolidatedTelegramGroup {
  botToken: string
  integrations: { agentId: string; integrationId: string }[]
}

/** §6.1 analog: group integrations by bot token (one grammY Bot per token). */
/** §7.5 opaque identity of one Telegram long-poll connection: the BotFather
 *  token is the whole identity (no app-level token exists). */
export function telegramConnKey(c: { botToken: string }): string {
  return c.botToken
}

export function consolidateTelegram(agents: Agent[]): Map<string, ConsolidatedTelegramGroup> {
  const groups = new Map<string, ConsolidatedTelegramGroup>()
  for (const a of agents) {
    for (const int of a.integrations) {
      if (int.platform !== 'telegram') continue
      // §6.4: config validated by this platform's module schema; invalid ⇒ no poll.
      const telegram = platformIntegrationConfig('telegram', int)
      if (!telegram) continue
      const k = telegram.botToken
      const g = groups.get(k) ?? { botToken: k, integrations: [] }
      g.integrations.push({ agentId: a.id, integrationId: int.id })
      groups.set(k, g)
    }
  }
  return groups
}

/** A tappable inline-keyboard button: shown `text`, and the ≤64-byte `callbackData`
 *  echoed back in the callback_query when tapped. */
export interface InlineButton {
  text: string
  callbackData: string
}

/** A normalized inline-keyboard tap (grammY `callback_query:data`), reduced to what the
 *  daemon needs to act: the id to ack, the button `data`, the originating chat/message
 *  (so the card can be edited in place), and who tapped (for authz). */
export interface TelegramCallback {
  id: string
  data: string
  channel: string
  messageId: number
  userId: string
  topicId?: string
}

/** A group/channel learned when Telegram reports that this bot was added. */
export interface TelegramObservedChat {
  id: string
  name?: string
  isPrivate: boolean
}

export interface TelegramDeps {
  group: ConsolidatedTelegramGroup
  onMessage: (msg: NormalizedMessage) => void
  /** Membership service records discover chats but never enter message routing. */
  onBotAddedToChat?: (chat: TelegramObservedChat) => void
  /** An inline-keyboard button was tapped (session-control cards — /models etc.). */
  onCallback?: (cb: TelegramCallback) => void
  newTraceId: () => string
  log?: Logger
  /** Min spacing (ms) between outbound writes (serialized send-queue). Tests pass 0. */
  sendIntervalMs?: number
}

/** grammY's `InlineKeyboardMarkup` slice we build. */
type InlineKeyboardMarkup = { inline_keyboard: { text: string; callback_data: string }[][] }

/** The raw grammY `callback_query` slice the connection reads. */
export interface TelegramCallbackQuery {
  id: string
  data?: string
  from?: { id: number }
  message?: { message_id: number; chat: { id: number }; message_thread_id?: number }
}

/** The slice of a Telegram user we surface through the gateway. */
interface TgUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

/**
 * The slice of grammY's `Api` we call — hand-declared (like slack's AppLike) so
 * the connection is testable with a fake and doesn't fight grammY's generics.
 * The default factory adapts a real `Bot`.
 */
export interface TelegramApi {
  sendMessage(
    chatId: number | string,
    text: string,
    opts?: {
      message_thread_id?: number
      parse_mode?: string
      reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean }
      reply_markup?: InlineKeyboardMarkup
    }
  ): Promise<{ message_id: number }>
  editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    opts?: { parse_mode?: string; reply_markup?: InlineKeyboardMarkup }
  ): Promise<unknown>
  /** The two outbound file forms. An image previews inline through sendPhoto; sendDocument
   *  takes everything else and is the only form that preserves the bytes exactly. */
  sendPhoto(
    chatId: number | string,
    photo: InputFile,
    opts?: {
      message_thread_id?: number
      caption?: string
      reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean }
    }
  ): Promise<{ message_id: number }>
  sendDocument(
    chatId: number | string,
    document: InputFile,
    opts?: {
      message_thread_id?: number
      caption?: string
      reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean }
    }
  ): Promise<{ message_id: number }>
  answerCallbackQuery(callbackQueryId: string, opts?: { text?: string }): Promise<unknown>
  sendChatAction(chatId: number | string, action: string): Promise<unknown>
  setMessageReaction(
    chatId: number | string,
    messageId: number,
    reaction: { type: 'emoji'; emoji: ReactionTypeEmoji['emoji'] }[]
  ): Promise<unknown>
  setMyCommands(commands: { command: string; description: string }[]): Promise<unknown>
  getChat(
    chatId: number | string
  ): Promise<{ id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string }>
  getChatMember(chatId: number | string, userId: number): Promise<{ user: TgUser }>
  getChatAdministrators(chatId: number | string): Promise<{ user: TgUser }[]>
  getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }>
  leaveChat(chatId: number | string): Promise<unknown>
}

/** The slice of grammY's `Bot` the connection drives. */
export interface TelegramBotHandle {
  readonly api: TelegramApi
  /** Fetch getMe → populate botInfo. */
  init(): Promise<void>
  readonly botInfo: { id: number; username?: string } | undefined
  /** Register the inbound message handler (grammY `bot.on('message')`). */
  onMessage(handler: (msg: TelegramMessage) => void): void
  /** Register the inline-keyboard tap handler (grammY `bot.on('callback_query:data')`). */
  onCallbackQuery(handler: (cb: TelegramCallbackQuery) => void): void
  /** Begin long-polling. NON-blocking: grammY's start() resolves only when the bot
   *  stops, so the default factory kicks it off without awaiting. */
  start(onStart?: () => void): void
  stop(): Promise<void>
}

/** Default factory: adapt a real grammY Bot to {@link TelegramBotHandle}. */
function defaultFactory(token: string): TelegramBotHandle {
  const bot = new Bot(token)
  return {
    api: bot.api as unknown as TelegramApi,
    init: () => bot.init(),
    get botInfo() {
      // grammY throws if read before init(); guard so callers can probe.
      try {
        return bot.botInfo
      } catch {
        return undefined
      }
    },
    onMessage(handler) {
      bot.on('message', (ctx) => handler(ctx.message as unknown as TelegramMessage))
    },
    onCallbackQuery(handler) {
      bot.on('callback_query:data', (ctx) => handler(ctx.callbackQuery as unknown as TelegramCallbackQuery))
    },
    start(onStart) {
      // drop_pending_updates: on (re)connect, skip the backlog Telegram buffered while
      // this daemon was down. grammY otherwise resumes from the last un-acked getUpdates
      // offset and replays stale updates — and since a fresh top-level @mention keys a new
      // session on its own message_id (canonicalizeTelegramThread), each replayed mention
      // would mint a duplicate session. We trade at-least-once for at-most-once here:
      // messages sent during a brief restart are dropped rather than answered late.
      void bot.start({ drop_pending_updates: true, ...(onStart ? { onStart: () => onStart() } : {}) })
    },
    stop: () => bot.stop()
  }
}

/** Map our button rows to grammY's `InlineKeyboardMarkup` wire shape. */
function toInlineKeyboard(buttons: InlineButton[][]): InlineKeyboardMarkup {
  return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callbackData }))) }
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
/** Cap on admins enriched per listMembers call (bounds the response). */
const MEMBER_CAP = 50

export class TelegramConnection implements PlatformConnection {
  private bot: TelegramBotHandle
  // All outbound writes funnel through one queue so streamed edits are FIFO-ordered
  // and rate-limited per bot connection (Telegram tolerates ~1 msg/s per chat).
  private queue: PlatformSendQueue
  /** The bot token this connection authenticated with (used to detect a swap). */
  readonly botToken: string
  /** The bot's numeric user id (as string), resolved at start() via getMe. */
  botUserId = ''
  /** The bot's @username (without '@'), for mention-routing. Resolved at start(). */
  botUsername = ''
  /** No workspace permalink base on Telegram (unlike Slack's workspaceUrl); '' so the
   *  daemon's deep-link base falls through to the configured / CP / local default Web App URL. */
  readonly workspaceUrl = ''

  constructor(
    private deps: TelegramDeps,
    factory: (token: string) => TelegramBotHandle = defaultFactory
  ) {
    this.botToken = deps.group.botToken
    this.bot = factory(deps.group.botToken)
    this.queue = new PlatformSendQueue(deps.sendIntervalMs ?? 350)
  }

  async start(): Promise<void> {
    const log = this.deps.log
    log?.debug('telegram: init → getMe (resolving bot identity)…')
    await this.bot.init()
    const info = this.bot.botInfo
    this.botUserId = info ? String(info.id) : ''
    this.botUsername = info?.username ?? ''
    log?.debug(`telegram: getMe ok → bot @${this.botUsername || '?'} (id ${this.botUserId || 'n/a'})`)

    this.bot.onMessage((message) => {
      if (isTelegramMembershipServiceMessage(message)) {
        const botWasAdded = message.new_chat_members?.some((member) => String(member.id) === this.botUserId) === true
        if (botWasAdded) {
          const chat = message.chat
          this.deps.onBotAddedToChat?.({
            id: String(chat.id),
            ...(chat.title || chat.username ? { name: chat.title ?? chat.username } : {}),
            isPrivate: chat.type === 'group' || chat.type === 'supergroup' ? !chat.username : chat.type !== 'channel'
          })
        }
        log?.debug(
          `telegram: membership service message ignored for routing ch=${message.chat.id}` +
            (botWasAdded ? ' (bot added; chat observed)' : '')
        )
        return
      }
      const msg = normalizeTelegramMessage(message, { traceId: this.deps.newTraceId() })
      log?.debug(
        `telegram: inbound ch=${msg.channel} user=${msg.sender.id} isBot=${msg.sender.isBot} isDm=${msg.isDm} ` +
          `topic=${msg.topicId ?? '-'} root=${msg.threadRoot ?? '-'} replyTo=${msg.replyTo ?? '-'} ` +
          `quoted=${msg.quoted ? `${msg.quoted.text.length}c${msg.quoted.excerpt ? ' excerpt' : ''}` : '-'} ` +
          `mentions=[${msg.mentionedBots.join(',')}] text=${JSON.stringify(msg.text.slice(0, 80))}`
      )
      this.deps.onMessage(msg)
    })

    this.bot.onCallbackQuery((q) => {
      // A stray tap on a card whose message we can't identify is unactionable — ack it
      // (so the client's spinner clears) and drop it.
      if (!q.message || q.data == null) return
      const cb: TelegramCallback = {
        id: q.id,
        data: q.data,
        channel: String(q.message.chat.id),
        messageId: q.message.message_id,
        userId: q.from ? String(q.from.id) : 'unknown',
        ...(q.message.message_thread_id != null ? { topicId: String(q.message.message_thread_id) } : {})
      }
      log?.debug(`telegram: callback ch=${cb.channel} user=${cb.userId} data=${JSON.stringify(cb.data)}`)
      this.deps.onCallback?.(cb)
    })

    // Advertise the slash-command menu (best-effort — a failure here must not stop the
    // bot from serving; the commands still work whether or not they autocomplete).
    try {
      await this.bot.api.setMyCommands(BOT_COMMANDS)
      log?.debug('telegram: setMyCommands ok')
    } catch (err) {
      log?.debug(`telegram: setMyCommands failed: ${(err as Error).message}`)
    }

    log?.debug('telegram: bot.start → opening long-poll (getUpdates), dropping pending backlog…')
    this.bot.start(() => log?.debug('telegram: long-poll established'))
  }

  /**
   * Post a message. `threadTs` (when numeric) is treated as a forum-topic
   * message_thread_id — the daemon's reply-based session threads are non-numeric
   * (`tg:<id>` / `dm`), so they correctly post to the chat root here. `replyTo`
   * (a message id) threads the post as a reply, which is how the bot anchors its
   * turn to the triggering message and keeps the reply chain intact. Returns the
   * resulting message id as a string.
   */
  async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
    // `replyTo` (a message id) anchors the post as a reply. The cross-platform
    // MessageGateway contract passes a sender-identity object in this 4th slot, which
    // Telegram can't honor (no per-message identity) — so those fields are accepted
    // for structural compatibility and ignored.
    opts?: { replyTo?: number; username?: string; icon_url?: string; agentAuthorId?: string }
  ): Promise<string | undefined> {
    const replyTo = opts?.replyTo
    const thread = threadTs != null && /^\d+$/.test(threadTs) ? Number(threadTs) : undefined
    return this.queue.enqueue(async () => {
      const res = await this.bot.api.sendMessage(channel, text, {
        ...(thread !== undefined ? { message_thread_id: thread } : {}),
        ...(replyTo !== undefined
          ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
          : {})
      })
      return res?.message_id != null ? String(res.message_id) : undefined
    })
  }

  /**
   * Put a file into a chat — the mirror of {@link downloadFile}. An image goes through
   * `sendPhoto` so it previews inline; anything else through `sendDocument`, which is also
   * the only form that preserves the bytes exactly.
   *
   * Telegram caps a caption at 1024 characters and silently truncates past it, so a longer
   * `comment` becomes its own message — sent AFTER the file, so that a rejected photo (extreme
   * dimensions, over the size cap) leaves the chat untouched instead of stranding a caption
   * for an image that never arrived. It reads below the image; that is the cost.
   *
   * `anchor.replyTo` is what PLACES the post in a non-forum group — the session thread key
   * there is deliberately non-numeric and cannot address anything — while a numeric
   * `anchor.thread` selects a forum topic. Both apply to the file and the overflow caption
   * alike. Returns the FILE message's id — the post a reply to this send threads from.
   */
  async uploadFile(
    channel: string,
    file: { bytes: Buffer; name: string; mimeType?: string },
    comment?: string,
    anchor?: UploadAnchor,
    _identity?: unknown
  ): Promise<UploadOutcome> {
    const thread = anchor?.thread != null && /^\d+$/.test(anchor.thread) ? Number(anchor.thread) : undefined
    const placeOpt = {
      ...(thread !== undefined ? { message_thread_id: thread } : {}),
      ...(anchor?.replyTo !== undefined
        ? { reply_parameters: { message_id: anchor.replyTo, allow_sending_without_reply: true } }
        : {})
    }
    const inCaption = comment && comment.length <= TELEGRAM_CAPTION_LIMIT ? comment : undefined
    const asOwnMessage = comment && !inCaption ? comment : undefined
    const task: Promise<UploadOutcome> = this.queue.enqueue(async () => {
      let sentId: string | undefined
      try {
        const input = new InputFile(file.bytes, file.name)
        const opts = { ...placeOpt, ...(inCaption ? { caption: inCaption } : {}) }
        const res = file.mimeType?.startsWith('image/')
          ? await this.bot.api.sendPhoto(channel, input, opts)
          : await this.bot.api.sendDocument(channel, input, opts)
        sentId = res?.message_id != null ? String(res.message_id) : undefined
      } catch (err) {
        this.deps.log?.debug(`telegram: uploadFile ${file.name} → ch=${channel} failed: ${(err as Error).message}`)
        return { ok: false, reason: classifyTelegramUploadError(err) }
      }
      const posted = { ok: true as const, ...(sentId !== undefined ? { messageId: sentId } : {}) }
      if (!asOwnMessage) return posted
      try {
        await this.bot.api.sendMessage(channel, asOwnMessage, placeOpt)
        return posted
      } catch (err) {
        this.deps.log?.debug(`telegram: uploadFile caption failed (ch=${channel}): ${(err as Error).message}`)
        return { ...posted, warning: 'the file was sent, but its caption was too long to attach and did not post' }
      }
    })
    return task.catch((err) => ({
      ok: false,
      reason: isSendQueueTimeout(err) ? 'indeterminate' : 'platform_error'
    }))
  }

  /**
   * Post a "chrome" message (progress / plan / reasoning / tool-output / a `/status`
   * reply) with an optional parse_mode + forum topic + reply target. Returns the new
   * message id for later in-place edits. Best-effort: swallows send errors (chrome
   * must never break a turn).
   */
  async postChrome(
    channel: string,
    text: string,
    opts: { parseMode?: string; threadTs?: string; replyTo?: number } = {}
  ): Promise<string | undefined> {
    const thread = opts.threadTs != null && /^\d+$/.test(opts.threadTs) ? Number(opts.threadTs) : undefined
    return this.queue.enqueue(async () => {
      try {
        const res = await this.bot.api.sendMessage(channel, text, {
          ...(thread !== undefined ? { message_thread_id: thread } : {}),
          ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
          ...(opts.replyTo !== undefined
            ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } }
            : {})
        })
        return res?.message_id != null ? String(res.message_id) : undefined
      } catch (err) {
        this.deps.log?.debug(`telegram: sendMessage (chrome) failed (ch=${channel}): ${(err as Error).message}`)
        return undefined
      }
    })
  }

  /**
   * Post an interactive "card": a message carrying an inline keyboard (rows of tappable
   * buttons) — the session-control pickers (/models, /effort, /permission). Best-effort;
   * returns the new message id so the card can be edited in place after a tap.
   */
  async postCard(
    channel: string,
    text: string,
    buttons: InlineButton[][],
    opts: { parseMode?: string; threadTs?: string; replyTo?: number } = {}
  ): Promise<string | undefined> {
    const thread = opts.threadTs != null && /^\d+$/.test(opts.threadTs) ? Number(opts.threadTs) : undefined
    return this.queue.enqueue(async () => {
      try {
        const res = await this.bot.api.sendMessage(channel, text, {
          ...(thread !== undefined ? { message_thread_id: thread } : {}),
          ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
          ...(opts.replyTo !== undefined
            ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } }
            : {}),
          reply_markup: toInlineKeyboard(buttons)
        })
        return res?.message_id != null ? String(res.message_id) : undefined
      } catch (err) {
        this.deps.log?.debug(`telegram: sendMessage (card) failed (ch=${channel}): ${(err as Error).message}`)
        return undefined
      }
    })
  }

  /** Re-render a card in place (new text + keyboard) after a tap. Best-effort. */
  async editCard(
    channel: string,
    messageId: number,
    text: string,
    buttons: InlineButton[][],
    opts: { parseMode?: string } = {}
  ): Promise<void> {
    await this.queue.enqueue(async () => {
      try {
        await this.bot.api.editMessageText(channel, messageId, text, {
          ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
          reply_markup: toInlineKeyboard(buttons)
        })
      } catch (err) {
        this.deps.log?.debug(
          `telegram: editMessageText (card) failed (ch=${channel} id=${messageId}): ${(err as Error).message}`
        )
      }
    })
  }

  /** Acknowledge an inline-keyboard tap (clears the client's loading spinner; the
   *  optional `text` shows as a transient toast). Not queued — a quick standalone ack. */
  async answerCallback(callbackId: string, text?: string): Promise<void> {
    try {
      await this.bot.api.answerCallbackQuery(callbackId, text ? { text } : undefined)
    } catch (err) {
      this.deps.log?.debug(`telegram: answerCallbackQuery failed: ${(err as Error).message}`)
    }
  }

  /** Edit a previously-posted message in place (editMessageText). Best-effort. */
  async updateMessage(
    channel: string,
    messageId: string,
    text: string,
    opts: { parseMode?: string } = {}
  ): Promise<void> {
    await this.queue.enqueue(async () => {
      try {
        await this.bot.api.editMessageText(channel, Number(messageId), text, {
          ...(opts.parseMode ? { parse_mode: opts.parseMode } : {})
        })
      } catch (err) {
        this.deps.log?.debug(
          `telegram: editMessageText failed (ch=${channel} id=${messageId}): ${(err as Error).message}`
        )
      }
    })
  }

  /** Best-effort transient "typing…" indicator (Telegram's analog of a status bar).
   *  Not queued — it's a fire-and-forget hint that expires on its own (~5s). */
  async sendChatAction(channel: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(channel, 'typing')
    } catch (err) {
      this.deps.log?.debug(`telegram: sendChatAction failed (ch=${channel}): ${(err as Error).message}`)
    }
  }

  /** Turn-start acknowledgement on the message that fired the turn. Not queued, for the
   *  same reason the typing hint is not: its whole value is arriving before the answer.
   *  A chat that forbids bot reactions degrades to nothing visible. */
  async react(channel: string, messageId: string, intent: PlatformReactionIntent): Promise<void> {
    const id = Number(messageId)
    if (!Number.isSafeInteger(id)) return
    try {
      await this.bot.api.setMessageReaction(channel, id, [{ type: 'emoji', emoji: TELEGRAM_REACTION_EMOJI[intent] }])
    } catch (err) {
      this.deps.log?.debug(`telegram: setMessageReaction failed (ch=${channel} msg=${id}): ${(err as Error).message}`)
    }
  }

  /**
   * Download a Telegram file by its `file_id` (carried in Attachment.sourceUrl):
   * getFile → file_path → GET https://api.telegram.org/file/bot<token>/<path>, up
   * to `maxBytes`. Returns null on any failure / over-cap (best-effort; a failed
   * attachment degrades to a resource_link, never breaks the prompt). Bytes stay
   * daemon-local (§9.2).
   */
  async downloadFile(fileId: string, maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES): Promise<Buffer | null> {
    try {
      const file = await this.bot.api.getFile(fileId)
      if (!file.file_path) {
        this.deps.log?.debug(`telegram: getFile ${fileId} returned no file_path`)
        return null
      }
      if (Number.isFinite(file.file_size) && (file.file_size as number) > maxBytes) {
        this.deps.log?.debug(`telegram: file ${fileId} skipped — ${file.file_size} bytes > cap ${maxBytes}`)
        return null
      }
      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) {
        this.deps.log?.debug(`telegram: downloadFile ${fileId} → HTTP ${res.status}`)
        return null
      }
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) {
        this.deps.log?.debug(`telegram: downloadFile ${fileId} skipped — ${declared} bytes > cap ${maxBytes}`)
        return null
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > maxBytes) {
        this.deps.log?.debug(`telegram: downloadFile ${fileId} discarded — ${buf.byteLength} bytes > cap ${maxBytes}`)
        return null
      }
      return buf
    } catch (err) {
      this.deps.log?.debug(`telegram: downloadFile ${fileId} failed: ${(err as Error).message}`)
      return null
    }
  }

  // ── MCP MessageGateway: read helpers backing the injected channel tools ──

  async getChannelInfo(channel: string): Promise<{ id: string; name?: string; isIm?: boolean; isPrivate?: boolean }> {
    const c = await this.bot.api.getChat(channel)
    const privateName = [c.first_name, c.last_name].filter(Boolean).join(' ')
    return {
      id: String(c.id ?? channel),
      name: (c.title ?? c.username ?? privateName) || undefined,
      isIm: c.type === 'private',
      // A group/supergroup without a public @username is effectively private.
      isPrivate: c.type === 'group' || c.type === 'supergroup' ? !c.username : c.type !== 'channel'
    }
  }

  /**
   * Members of a chat. Telegram bots cannot enumerate the full member list — only
   * administrators (groups/supergroups). Returns the admins, best-effort ([] on
   * failure or for private chats).
   */
  async listMembers(channel: string): Promise<{ id: string; name?: string; isBot?: boolean }[]> {
    try {
      const admins = await this.bot.api.getChatAdministrators(channel)
      return admins.slice(0, MEMBER_CAP).map((m) => ({
        id: String(m.user.id),
        name: m.user.username ?? ([m.user.first_name, m.user.last_name].filter(Boolean).join(' ') || undefined),
        isBot: m.user.is_bot
      }))
    } catch (err) {
      this.deps.log?.debug(`telegram: getChatAdministrators failed (ch=${channel}): ${(err as Error).message}`)
      return []
    }
  }

  /** A bot cannot enumerate the chats it belongs to — always []. */
  async listChannels(): Promise<{ id: string; name?: string; isPrivate?: boolean }[]> {
    return []
  }

  /**
   * Leave a group, supergroup or channel (`leaveChat`). Needs no extra rights, and
   * throws Telegram's own refusal for the caller to relay.
   *
   * Telegram tells nobody the bot left — there is no self-event, and `listChannels`
   * above can never enumerate what remains — so unlike Slack the caller MUST retract
   * the row explicitly afterwards; nothing else will.
   */
  async leaveChannel(channel: string): Promise<void> {
    await this.bot.api.leaveChat(channel)
    this.deps.log?.debug(`telegram: left chat ${channel}`)
  }

  /**
   * Telegram has no standalone "get user" endpoint (getChatMember needs a chat
   * context, which this gateway signature lacks), so this degrades to echoing the
   * id. Names are resolved via listMembers / inbound messages instead.
   */
  async getUserProfile(user: string): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean }> {
    return { id: user }
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }
}
