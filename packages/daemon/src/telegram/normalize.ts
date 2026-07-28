import type { Attachment, NormalizedMessage } from '../messages/normalized.js'

/**
 * The subset of the Telegram Bot API `Message` we read during normalization. Kept
 * self-contained (like slack/normalize.ts's SlackMessageEvent) so the normalizer
 * is pure and unit-testable without grammY; the connection casts grammY's
 * `ctx.message` into this shape.
 *
 * ATTACHMENTS: Telegram never ships a fetchable URL inline — a shared file is an
 * opaque `file_id` that must be resolved via getFile → download (see
 * TelegramConnection.downloadFile). We therefore carry the `file_id` in
 * `Attachment.sourceUrl`; the owning connection does the two-step fetch.
 */
export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
}

export interface TelegramMessageEntity {
  type: string // 'mention' | 'text_mention' | 'bot_command' | …
  offset: number // UTF-16 code units (matches JS string indexing)
  length: number
  user?: TelegramUser // present for 'text_mention'
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id?: string
  file_size?: number
  width?: number
  height?: number
}

export interface TelegramDocument {
  file_id: string
  file_unique_id?: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramMessage {
  message_id: number
  message_thread_id?: number // forum-topic id (supergroups only)
  is_topic_message?: boolean
  from?: TelegramUser
  chat: TelegramChat
  date?: number
  reply_to_message?: { message_id: number }
  text?: string
  caption?: string // photos/documents carry their text here, not in `text`
  entities?: TelegramMessageEntity[]
  caption_entities?: TelegramMessageEntity[]
  photo?: TelegramPhotoSize[]
  document?: TelegramDocument
  /** Telegram membership service records. They are conversation metadata, not
   *  user-authored chat, and must never become an agent turn. */
  new_chat_members?: TelegramUser[]
  left_chat_member?: TelegramUser
}

/** Membership changes arrive through grammY's broad `message` listener but are
 * Telegram service records rather than user-authored messages. */
export function isTelegramMembershipServiceMessage(msg: TelegramMessage): boolean {
  return msg.new_chat_members !== undefined || msg.left_chat_member !== undefined
}

/**
 * Map a Telegram document to a NormalizedMessage Attachment. The `file_id` goes in
 * `sourceUrl` for the connection's getFile→download two-step. Null when there's no
 * usable file_id.
 */
export function documentToAttachment(d: TelegramDocument | null | undefined): Attachment | null {
  if (!d || typeof d !== 'object' || !d.file_id) return null
  return {
    id: d.file_id,
    name: d.file_name ?? d.file_id,
    mimeType: d.mime_type ?? 'application/octet-stream',
    ...(typeof d.file_size === 'number' ? { size: d.file_size } : {}),
    sourceUrl: d.file_id
  }
}

/**
 * Map a Telegram photo (an array of sizes, ascending) to an Attachment, choosing
 * the largest rendition. Null when the array is empty / malformed.
 */
export function photoToAttachment(sizes: TelegramPhotoSize[] | null | undefined): Attachment | null {
  if (!Array.isArray(sizes) || sizes.length === 0) return null
  const largest = sizes[sizes.length - 1]!
  if (!largest.file_id) return null
  return {
    id: largest.file_id,
    name: `${largest.file_unique_id ?? 'photo'}.jpg`,
    mimeType: 'image/jpeg',
    ...(typeof largest.file_size === 'number' ? { size: largest.file_size } : {}),
    sourceUrl: largest.file_id
  }
}

/**
 * The raw Telegram `message_thread_id` of a message, or undefined. This id means one of
 * two DIFFERENT things depending on `is_topic_message`:
 *   - in a forum supergroup (is_topic_message) it's the forum TOPIC id, and
 *   - in a plain supergroup it's the REPLY-THREAD ROOT (Telegram auto-threads replies).
 * Normalize splits these into `telegramTopicId` vs `telegramThreadRoot` because only the
 * forum-topic id may be sent back as `message_thread_id` when posting — a plain reply
 * thread is continued with `reply_parameters`, not `message_thread_id`.
 */
export function telegramThread(msg: TelegramMessage): string | undefined {
  return msg.message_thread_id != null ? String(msg.message_thread_id) : undefined
}

/** Distinct bot/user handles mentioned in a message — @usernames (without the '@')
 *  from `mention` entities, plus numeric ids from `text_mention` entities. The
 *  daemon matches the bot's own @username (Telegram) against this set for routing. */
function extractMentions(text: string, entities: TelegramMessageEntity[]): string[] {
  const out = new Set<string>()
  for (const e of entities) {
    if (e.type === 'mention') {
      // The entity span includes the leading '@'.
      const raw = text.slice(e.offset, e.offset + e.length)
      const handle = raw.replace(/^@/, '')
      if (handle) out.add(handle)
    } else if (e.type === 'text_mention' && e.user?.id != null) {
      out.add(String(e.user.id))
    }
  }
  return [...out]
}

/** Normalize a Telegram Bot API message into the platform-agnostic contract. */
export function normalizeTelegramMessage(msg: TelegramMessage, ctx: { traceId: string }): NormalizedMessage {
  const text = msg.text ?? msg.caption ?? ''
  const entities = (msg.text ? msg.entities : msg.caption_entities) ?? []
  const mentionedBots = extractMentions(text, entities)

  const attachments: Attachment[] = []
  const photo = photoToAttachment(msg.photo)
  if (photo) attachments.push(photo)
  const doc = documentToAttachment(msg.document)
  if (doc) attachments.push(doc)

  // Surface the raw threading signals; `thread` itself is left for the daemon to set
  // (canonicalizeTelegramThread) — normalize no longer owns Telegram threading. A forum
  // topic id and a plain-supergroup reply-thread root are BOTH `message_thread_id` but
  // must be kept apart (only the topic id is postable as `message_thread_id`).
  const threadId = telegramThread(msg)
  const isForumTopic = msg.is_topic_message === true
  const replyTo = msg.reply_to_message?.message_id != null ? String(msg.reply_to_message.message_id) : undefined

  return {
    msgId: `telegram:${msg.chat.id}:${msg.message_id}`,
    traceId: ctx.traceId,
    source: 'user',
    platform: 'telegram',
    channel: String(msg.chat.id),
    ...(isForumTopic && threadId !== undefined ? { telegramTopicId: threadId } : {}),
    ...(!isForumTopic && threadId !== undefined ? { telegramThreadRoot: threadId } : {}),
    ...(replyTo !== undefined ? { replyTo } : {}),
    sender: { id: msg.from ? String(msg.from.id) : 'unknown', isBot: Boolean(msg.from?.is_bot) },
    text,
    mentionedBots,
    ...(attachments.length ? { attachments } : {}),
    isDm: msg.chat.type === 'private'
  }
}
