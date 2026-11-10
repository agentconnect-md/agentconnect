import { WECHAT_PLATFORM } from '@agentconnect.md/protocol'
import type { NormalizedPlatformMessage, PlatformAttachment, QuotedMessage } from '@agentconnect.md/protocol'
import { safeAttachmentName, mimeTypeFromFileName } from './file-name.js'

/** A CDN reference to an encrypted media object (wechat-integration.md §4.6). */
export interface WeChatCdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

/** One item of an iLink message's `item_list`: 1 text, 2 image, 3 voice, 4 file, 5 video. */
export interface WeChatMessageItem {
  type?: number
  msg_id?: string
  text_item?: { text?: string }
  image_item?: { media?: WeChatCdnMedia; thumb_media?: WeChatCdnMedia; aeskey?: string; url?: string }
  voice_item?: { media?: WeChatCdnMedia; text?: string; playtime?: number }
  file_item?: { media?: WeChatCdnMedia; file_name?: string; len?: string }
  video_item?: { media?: WeChatCdnMedia; thumb_media?: WeChatCdnMedia }
  ref_msg?: {
    title?: string
    message_item?: WeChatMessageItem
    svr_id?: string | number
    partial_text?: WeChatPartialQuote
  }
}

/** A quote of part of a message: the selection's edges, which occurrence of each, and the selection's MD5. */
export interface WeChatPartialQuote {
  start?: string
  end?: string
  startindex?: number
  endindex?: number
  quotemd5?: string
}

/** A quote that names its message by id only, which the connection resolves from its own record (§4.3). */
export interface WeChatQuoteRef {
  messageId: string
  partial?: WeChatPartialQuote
}

/** One message from `getupdates` (wechat-integration.md §4.1); `message_id` must arrive as a string, it exceeds 2^53. */
export interface WeChatInboundMessage {
  seq?: number
  message_id?: string | number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  session_id?: string
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: WeChatMessageItem[]
  context_token?: string
}

/** The receiving bot's verified binding; it is never taken from the payload. */
export interface WeChatNormalizeContext {
  /** The bot's `ilink_bot_id`. */
  botId: string
  /** The WeChat user the QR login bound, the bot's only admitted sender. */
  boundUserId: string
  traceId: string
}

/** The download material for one attachment, held by the connection and never put in the normalized message. */
export interface WeChatMediaRef {
  /** The opaque reference the attachment's `sourceUrl` carries. */
  ref: string
  encryptQueryParam?: string
  fullUrl?: string
  /** base64 of 16 raw bytes or of 32 hex characters, as the CDN reference carries it. */
  aesKey?: string
  /** An image's raw hex key, which takes precedence over `aesKey`. */
  aesKeyHex?: string
  image: boolean
}

export interface WeChatNormalized {
  message: NormalizedPlatformMessage
  media: WeChatMediaRef[]
  /** Set when the quote carries no content of its own, so the caller must look its text up. */
  quoteRef?: WeChatQuoteRef
  /** This message's iLink id and the text a later quote of it should show. */
  record: { messageId: string; text: string }
}

const MAX_QUOTED_TEXT_CHARS = 1000
const USER_MESSAGE = 1
const ITEM_TEXT = 1
const ITEM_IMAGE = 2
const ITEM_VOICE = 3
const ITEM_FILE = 4
const ITEM_VIDEO = 5

/** The attachment reference grammar; not a URL, so a read tool can only resolve what the connection received. */
export const WECHAT_MEDIA_REF_PREFIX = 'wechat-media:'

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

// A message id is a decimal int64; a JSON number has already lost precision unless it is still a safe integer.
function messageIdOf(value: unknown): string | undefined {
  if (typeof value === 'string') return /^\d+$/.test(value) ? value : undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
}

// A bot has one counterpart, so its one conversation is keyed by that user.
export function weChatDmChannel(userId: string): string {
  return `dm:${userId}`
}

function itemText(item: WeChatMessageItem | undefined): string {
  if (!item) return ''
  if (item.type === ITEM_TEXT) return str(item.text_item?.text) ?? ''
  // WeChat's own transcription stands in for the SILK audio, which v1 does not decode (§4.6).
  if (item.type === ITEM_VOICE) return str(item.voice_item?.text) ?? ''
  return ''
}

function mediaOf(item: WeChatMessageItem): { media?: WeChatCdnMedia; name?: string; image: boolean } | undefined {
  if (item.type === ITEM_IMAGE) return { media: item.image_item?.media, image: true }
  if (item.type === ITEM_FILE)
    return { media: item.file_item?.media, name: str(item.file_item?.file_name), image: false }
  if (item.type === ITEM_VIDEO) return { media: item.video_item?.media, image: false }
  return undefined
}

// Normalize one `getupdates` message from the bound user; null when it cannot be served (§4.1, §4.3).
export function normalizeWeChatMessage(
  payload: WeChatInboundMessage,
  context: WeChatNormalizeContext
): WeChatNormalized | null {
  const messageId = messageIdOf(payload.message_id)
  const from = str(payload.from_user_id)
  // Bot-authored messages, including tool-call progress items 11 and 12, are never admitted.
  if (!messageId || !from || payload.message_type !== USER_MESSAGE) return null
  if (from !== context.boundUserId) return null
  const items = Array.isArray(payload.item_list) ? payload.item_list : []

  const texts: string[] = []
  const attachments: PlatformAttachment[] = []
  const media: WeChatMediaRef[] = []
  let quoteText = ''
  let quoteId: string | undefined
  let quotePartial: WeChatPartialQuote | undefined
  let quoteSeen = false
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const text = itemText(item)
    if (text) texts.push(text)
    const ref = item.ref_msg
    if (ref && typeof ref === 'object' && !quoteSeen) {
      quoteSeen = true
      quoteText = [str(ref.title) ?? '', itemText(ref.message_item)].filter(Boolean).join('\n')
      quoteId = messageIdOf(ref.svr_id) ?? messageIdOf(ref.message_item?.msg_id)
      if (ref.partial_text && typeof ref.partial_text === 'object') quotePartial = ref.partial_text
    }
    const file = mediaOf(item)
    const cdn = file?.media
    const encryptQueryParam = str(cdn?.encrypt_query_param)
    const fullUrl = str(cdn?.full_url)
    if (!file || (!encryptQueryParam && !fullUrl)) continue
    const index = attachments.length
    const sourceUrl = `${WECHAT_MEDIA_REF_PREFIX}${messageId}:${index}`
    const name = safeAttachmentName(file.name)
    attachments.push({
      id: `${messageId}:${index}`,
      name:
        name ??
        (file.image
          ? `image-${index + 1}.jpg`
          : item.type === ITEM_VIDEO
            ? `video-${index + 1}.mp4`
            : `attachment-${index + 1}`),
      mimeType: file.image ? 'image/jpeg' : item.type === ITEM_VIDEO ? 'video/mp4' : mimeTypeFromFileName(name),
      sourceUrl
    })
    const aesKey = str(cdn?.aes_key)
    const aesKeyHex = file.image ? str(item.image_item?.aeskey) : undefined
    media.push({
      ref: sourceUrl,
      image: file.image,
      ...(encryptQueryParam ? { encryptQueryParam } : {}),
      ...(fullUrl ? { fullUrl } : {}),
      ...(aesKey ? { aesKey } : {}),
      ...(aesKeyHex ? { aesKeyHex } : {})
    })
  }

  const text = texts.join('\n')
  // A newer client may quote by server id alone; the caller then resolves it from its record (§4.3).
  const quoted = quoteText ? weChatQuote(quoteText, quoteId) : undefined
  const quoteRef: WeChatQuoteRef | undefined =
    !quoteText && quoteId ? { messageId: quoteId, ...(quotePartial ? { partial: quotePartial } : {}) } : undefined
  if (!text.trim() && !attachments.length) return null
  const recordText = text.trim() ? text : attachments.map((a) => `[attached: ${a.name}]`).join(' ')
  const createdAt = payload.create_time_ms
  return {
    message: {
      msgId: `${WECHAT_PLATFORM}:${context.botId}:${messageId}`,
      traceId: context.traceId,
      source: 'user',
      platform: WECHAT_PLATFORM,
      channel: weChatDmChannel(from),
      // WeChat sends no display name; the Console shows the bound member's own (§4.1).
      sender: { id: from, isBot: false },
      text,
      ...(attachments.length ? { attachments } : {}),
      mentionedBots: [],
      isDm: true,
      ...(quoted ? { quoted } : {}),
      ...(typeof createdAt === 'number' && Number.isSafeInteger(createdAt) && createdAt > 0
        ? { platformTimeMs: createdAt }
        : {})
    },
    media,
    ...(quoteRef ? { quoteRef } : {}),
    record: { messageId, text: recordText }
  }
}

/** A quote as the agent reads it, bounded to 1,000 characters; `selection` marks part of a message. */
export function weChatQuote(text: string, messageId?: string, selection = false): QuotedMessage {
  const truncated = text.length > MAX_QUOTED_TEXT_CHARS
  return {
    text: truncated ? `${text.slice(0, MAX_QUOTED_TEXT_CHARS)}…` : text,
    ...(messageId ? { messageId } : {}),
    ...(selection ? { selection: true } : {}),
    ...(truncated ? { excerpt: true } : {})
  }
}
