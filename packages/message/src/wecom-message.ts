import { WECOM_PLATFORM } from '@agentconnect.md/protocol'
import type { NormalizedPlatformMessage, PlatformAttachment, QuotedMessage } from '@agentconnect.md/protocol'
import { attachmentMention } from './attachment-mention.js'
import { leadingMentions } from './command-text.js'

/** An encrypted media object: a download URL valid for five minutes and its own AES-256-CBC key. */
export interface WeComMediaContent {
  url?: string
  aeskey?: string
}

/** One item of a `mixed` body: text or an image. */
export interface WeComMixedItem {
  msgtype?: string
  text?: { content?: string }
  image?: WeComMediaContent
}

/** The bodies a message or its quote may carry, one per `msgtype`. */
export interface WeComMessageContent {
  msgtype?: string
  text?: { content?: string }
  image?: WeComMediaContent
  mixed?: { msg_item?: WeComMixedItem[] }
  voice?: { content?: string }
  file?: WeComMediaContent
  video?: WeComMediaContent
}

/** The `body` of an `aibot_msg_callback` frame on a smart bot's long connection (official doc, path 101463 and 100719). */
export interface WeComInboundMessage extends WeComMessageContent {
  msgid?: string
  aibotid?: string
  chatid?: string
  chattype?: string
  from?: { userid?: string }
  create_time?: number
  response_url?: string
  quote?: WeComMessageContent
  compat_info?: { source?: string }
}

/** The receiving bot's verified identity; it is never taken from the payload. */
export interface WeComNormalizeContext {
  /** The smart bot's BotID, which WeCom sends as `aibotid`. */
  botId: string
  /** The bot's display name as a group mention spells it, when known; it marks the leading mention for command parsing. */
  botName?: string
  traceId: string
}

/** The download material for one attachment, held by the connection and never put in the normalized message. */
export interface WeComMediaRef {
  /** The opaque reference the attachment's `sourceUrl` carries. */
  ref: string
  url: string
  aesKey: string
  kind: WeComMediaKind
}

export interface WeComNormalized {
  message: NormalizedPlatformMessage
  media: WeComMediaRef[]
}

type WeComMediaKind = 'image' | 'file' | 'video'

/** The attachment reference grammar; not a URL, so a read tool can only resolve what the connection received. */
export const WECOM_MEDIA_REF_PREFIX = 'wecom-media:'

const MAX_QUOTED_TEXT_CHARS = 1000
const UNAVAILABLE_NOTICE = '[WeCom attachment unavailable: it arrived without a download URL or key.]'
// The doc's examples carry seconds (1700000000); a larger value is not seconds, so it is not read as a time.
const MAX_CREATE_TIME_SECONDS = 1e11

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

// A direct chat carries no chat id, so it is keyed by its member's userid.
export function weComDmChannel(userId: string): string {
  return `dm:${userId}`
}

interface MediaItem {
  kind: WeComMediaKind
  media: WeComMediaContent | undefined
}

// The text and media of one body; null for a type this normalizer does not serve.
function contentOf(content: WeComMessageContent): { text: string; media: MediaItem[] } | null {
  switch (content.msgtype) {
    case 'text':
      return { text: str(content.text?.content) ?? '', media: [] }
    // WeCom's own transcription stands in for the audio, which never arrives.
    case 'voice':
      return { text: str(content.voice?.content) ?? '', media: [] }
    case 'image':
      return { text: '', media: [{ kind: 'image', media: content.image }] }
    case 'file':
      return { text: '', media: [{ kind: 'file', media: content.file }] }
    case 'video':
      return { text: '', media: [{ kind: 'video', media: content.video }] }
    case 'mixed': {
      const items = Array.isArray(content.mixed?.msg_item) ? content.mixed.msg_item : []
      const texts: string[] = []
      const media: MediaItem[] = []
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const text = item.msgtype === 'text' ? str(item.text?.content) : undefined
        if (text) texts.push(text)
        if (item.msgtype === 'image') media.push({ kind: 'image', media: item.image })
      }
      // The doc does not say how a client separates a mixed body's text runs; a newline keeps them apart.
      return { text: texts.join('\n'), media }
    }
    default:
      return null
  }
}

// An HTTPS download URL; anything else is not fetched.
function downloadUrl(value: unknown): string | undefined {
  const url = str(value)
  return url && /^https:\/\/[^\s/@]+\/\S*$/i.test(url) ? url : undefined
}

function attachmentName(kind: WeComMediaKind, index: number): { name: string; mimeType: string } {
  // WeCom names neither a file nor an image format, so the daemon learns the real type when it downloads.
  if (kind === 'image') return { name: `image-${index + 1}.jpg`, mimeType: 'image/jpeg' }
  if (kind === 'video') return { name: `video-${index + 1}.mp4`, mimeType: 'video/mp4' }
  return { name: `attachment-${index + 1}`, mimeType: 'application/octet-stream' }
}

/** A quote as the agent reads it, bounded to 1,000 characters; WeCom names no quoted message id. */
function weComQuote(text: string): QuotedMessage {
  const truncated = text.length > MAX_QUOTED_TEXT_CHARS
  return {
    text: truncated ? `${text.slice(0, MAX_QUOTED_TEXT_CHARS)}…` : text,
    ...(truncated ? { excerpt: true } : {})
  }
}

// Normalize one `aibot_msg_callback` body: a direct chat or a group mention, the only traffic WeCom delivers; null when it cannot be served.
export function normalizeWeComMessage(
  payload: WeComInboundMessage,
  context: WeComNormalizeContext
): WeComNormalized | null {
  const isDm = payload.chattype === 'single'
  const isGroup = payload.chattype === 'group'
  const messageId = str(payload.msgid)
  const userId = str(payload.from?.userid)
  const chatId = str(payload.chatid)
  if ((!isDm && !isGroup) || !messageId || !userId) return null
  if (payload.aibotid !== context.botId) return null
  // An assistant or channel invocation is not a person's message; this integration does not serve it.
  if (payload.compat_info !== undefined) return null
  // A group is keyed by its chat id, which never reads as a direct chat key.
  if (isGroup && (!chatId || chatId.startsWith('dm:'))) return null

  const body = contentOf(payload)
  if (!body) return null
  const quote = payload.quote && typeof payload.quote === 'object' ? payload.quote : undefined
  const quoteBody = quote ? contentOf(quote) : null

  const attachments: PlatformAttachment[] = []
  const quotedAttachments: PlatformAttachment[] = []
  const media: WeComMediaRef[] = []
  let unavailable = false
  let quoteUnavailable = false
  const sources = [
    ...body.media.map((item) => ({ item, quote: false })),
    ...(quoteBody?.media ?? []).map((item) => ({ item, quote: true }))
  ]
  for (const { item, quote: quoted } of sources) {
    const url = downloadUrl(item.media?.url)
    const aesKey = str(item.media?.aeskey)
    // A long-connection download is decrypted with its own key, so a URL without one cannot be read.
    if (!url || !aesKey) {
      if (quoted) quoteUnavailable = true
      else unavailable = true
      continue
    }
    if (media.some((ref) => ref.url === url)) continue
    const index = attachments.length
    const ref = `${WECOM_MEDIA_REF_PREFIX}${messageId}:${index}`
    const attachment: PlatformAttachment = {
      id: quoted ? `${messageId}:quote:${index}` : `${messageId}:${index}`,
      ...attachmentName(item.kind, index),
      sourceUrl: ref
    }
    attachments.push(attachment)
    if (quoted) quotedAttachments.push(attachment)
    media.push({ ref, url, aesKey, kind: item.kind })
  }

  const quoteText = [
    quoteBody?.text ?? '',
    attachmentMention(quotedAttachments),
    quoteUnavailable ? UNAVAILABLE_NOTICE : ''
  ]
    .filter(Boolean)
    .join('\n')
  const quoted = quoteText ? weComQuote(quoteText) : undefined
  // A group mention arrives with the bot's own `@name` left in the text, so it stays as the person wrote it.
  const text = [body.text, ...(unavailable ? [UNAVAILABLE_NOTICE] : [])].filter(Boolean).join('\n')
  if (!text.trim() && !attachments.length && !quoted) return null
  const leading =
    isGroup && context.botName ? leadingMentions(text, [{ id: context.botId, text: `@${context.botName}` }]) : undefined
  const createTime = payload.create_time
  return {
    message: {
      msgId: `${WECOM_PLATFORM}:${context.botId}:${messageId}`,
      traceId: context.traceId,
      source: 'user',
      platform: WECOM_PLATFORM,
      channel: isDm ? weComDmChannel(userId) : chatId!,
      // WeCom sends only a userid, encrypted unless the bot's creator is a super administrator.
      sender: { id: userId, isBot: false },
      text,
      ...(attachments.length ? { attachments } : {}),
      mentionedBots: isGroup ? [context.botId] : [],
      ...(leading ? { leadingMentions: leading } : {}),
      isDm,
      ...(quoted ? { quoted } : {}),
      ...(typeof createTime === 'number' &&
      Number.isSafeInteger(createTime) &&
      createTime > 0 &&
      createTime < MAX_CREATE_TIME_SECONDS
        ? { platformTimeMs: createTime * 1000 }
        : {})
    },
    media
  }
}
