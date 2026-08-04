import type { NormalizedPlatformMessage, PlatformAttachment, QuotedMessage } from '@agentconnect.md/protocol'
import { attachmentMention } from './attachment-mention.js'

/**
 * Minimal plain-object Telegram Bot API views used by pure normalization. The
 * daemon adapts grammY messages into these shapes; no grammY types or I/O cross
 * this package boundary.
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
  type: string
  /** UTF-16 code units, matching JavaScript string indexing. */
  offset: number
  length: number
  user?: TelegramUser
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

export interface TelegramReplyToMessage {
  message_id: number
  from?: TelegramUser
  text?: string
  caption?: string
  photo?: TelegramPhotoSize[]
  document?: TelegramDocument
}

export interface TelegramTextQuote {
  text: string
  is_manual?: boolean
}

export interface TelegramMessage {
  message_id: number
  message_thread_id?: number
  is_topic_message?: boolean
  from?: TelegramUser
  chat: TelegramChat
  date?: number
  reply_to_message?: TelegramReplyToMessage
  quote?: TelegramTextQuote
  text?: string
  caption?: string
  entities?: TelegramMessageEntity[]
  caption_entities?: TelegramMessageEntity[]
  photo?: TelegramPhotoSize[]
  document?: TelegramDocument
  /** Membership service records are metadata, never user-authored agent turns. */
  new_chat_members?: TelegramUser[]
  left_chat_member?: TelegramUser
}

export function isTelegramMembershipServiceMessage(message: TelegramMessage): boolean {
  return message.new_chat_members !== undefined || message.left_chat_member !== undefined
}

/** Telegram documents carry an opaque file_id resolved later by the daemon. */
export function toTelegramDocumentAttachment(document: TelegramDocument | null | undefined): PlatformAttachment | null {
  if (!document || typeof document !== 'object' || !document.file_id) return null
  return {
    id: document.file_id,
    name: document.file_name ?? document.file_id,
    mimeType: document.mime_type ?? 'application/octet-stream',
    ...(typeof document.file_size === 'number' ? { size: document.file_size } : {}),
    sourceUrl: document.file_id
  }
}

/** Pick the largest Telegram photo rendition and retain its opaque file_id. */
export function toTelegramPhotoAttachment(sizes: TelegramPhotoSize[] | null | undefined): PlatformAttachment | null {
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

const MAX_QUOTED_TEXT_CHARS = 1000

function quotedSenderLabel(sender: TelegramUser | undefined): string | undefined {
  if (!sender) return undefined
  return sender.username ? `@${sender.username}` : String(sender.id)
}

function telegramSenderName(sender: TelegramUser | undefined): string | undefined {
  if (!sender) return undefined
  if (sender.username) return `@${sender.username}`
  return [sender.first_name, sender.last_name].filter(Boolean).join(' ') || undefined
}

export function quotedFromTelegramReply(message: TelegramMessage): QuotedMessage | undefined {
  const source = message.reply_to_message
  if (!source) return undefined

  const quoteText = message.quote?.text?.trim() ?? ''
  const manual = message.quote?.is_manual === true ? quoteText : ''
  const full = (source.text ?? source.caption ?? '').trim()
  const serverExcerpt = manual || full ? '' : quoteText
  const attachments: PlatformAttachment[] = []
  const photo = toTelegramPhotoAttachment(source.photo)
  if (photo) attachments.push(photo)
  const document = toTelegramDocumentAttachment(source.document)
  if (document) attachments.push(document)

  const partial = manual || serverExcerpt
  const mention = partial ? '' : attachmentMention(attachments)
  const body = [partial || full, mention].filter(Boolean).join(' ')
  if (!body) return undefined

  const truncated = body.length > MAX_QUOTED_TEXT_CHARS
  const sender = quotedSenderLabel(source.from)
  return {
    messageId: String(source.message_id),
    ...(sender !== undefined ? { sender } : {}),
    text: truncated ? `${body.slice(0, MAX_QUOTED_TEXT_CHARS)}…` : body,
    ...(manual ? { selection: true } : {}),
    ...(manual || serverExcerpt || truncated ? { excerpt: true } : {})
  }
}

/**
 * Raw Telegram message_thread_id. Forum topics and non-forum reply roots share
 * the same provider field and are split by normalizeTelegramMessage.
 */
export function telegramThread(message: TelegramMessage): string | undefined {
  return message.message_thread_id != null ? String(message.message_thread_id) : undefined
}

function extractTelegramMentions(text: string, entities: TelegramMessageEntity[]): string[] {
  const mentions = new Set<string>()
  for (const entity of entities) {
    if (entity.type === 'mention') {
      const handle = text.slice(entity.offset, entity.offset + entity.length).replace(/^@/, '')
      if (handle) mentions.add(handle)
    } else if (entity.type === 'text_mention' && entity.user?.id != null) {
      mentions.add(String(entity.user.id))
    }
  }
  return [...mentions]
}

export function normalizeTelegramMessage(
  message: TelegramMessage,
  context: { traceId: string }
): NormalizedPlatformMessage {
  const text = message.text ?? message.caption ?? ''
  const entities = (message.text ? message.entities : message.caption_entities) ?? []
  const attachments: PlatformAttachment[] = []
  const photo = toTelegramPhotoAttachment(message.photo)
  if (photo) attachments.push(photo)
  const document = toTelegramDocumentAttachment(message.document)
  if (document) attachments.push(document)

  const threadId = telegramThread(message)
  const isForumTopic = message.is_topic_message === true
  const replyTo = message.reply_to_message?.message_id != null ? String(message.reply_to_message.message_id) : undefined
  const quoted = quotedFromTelegramReply(message)
  const senderName = telegramSenderName(message.from)

  return {
    msgId: `telegram:${message.chat.id}:${message.message_id}`,
    // Telegram message ids are per-chat sequences with no embedded time — the
    // platform's send time is the only chronological coordinate.
    ...(message.date !== undefined ? { platformTimeMs: message.date * 1000 } : {}),
    traceId: context.traceId,
    source: 'user',
    platform: 'telegram',
    channel: String(message.chat.id),
    // §6.5 dual-shape: generic coordinates alongside the deprecated named fields.
    // §6.5 emission flip: generic coordinates only — the Telegram-named twins retired.
    ...(isForumTopic && threadId !== undefined ? { topicId: threadId } : {}),
    ...(!isForumTopic && threadId !== undefined ? { threadRoot: threadId } : {}),
    ...(replyTo !== undefined ? { replyTo } : {}),
    ...(quoted !== undefined ? { quoted } : {}),
    sender: {
      id: message.from ? String(message.from.id) : 'unknown',
      isBot: Boolean(message.from?.is_bot),
      ...(senderName ? { name: senderName } : {})
    },
    text,
    mentionedBots: extractTelegramMentions(text, entities),
    ...(attachments.length ? { attachments } : {}),
    isDm: message.chat.type === 'private'
  }
}
