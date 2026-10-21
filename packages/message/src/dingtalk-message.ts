import { DINGTALK_PLATFORM } from '@agentconnect.md/protocol'
import type { NormalizedPlatformMessage, PlatformAttachment, QuotedMessage } from '@agentconnect.md/protocol'
import { attachmentMention } from './attachment-mention.js'
import { safeAttachmentName, mimeTypeFromFileName } from './file-name.js'

/** The media fields a `picture`, `file` or `richText` body (or a quoted one) carries. */
export interface DingTalkMessageContent {
  text?: string
  downloadCode?: string
  pictureDownloadCode?: string
  fileName?: string
  fileId?: string
  spaceId?: string
  richText?: { text?: string; type?: string; downloadCode?: string; pictureDownloadCode?: string }[]
}

/** The message a quote reply names: `content` is `{ text }` for text and the media fields otherwise. */
export interface DingTalkRepliedMessage {
  createdAt?: number
  senderId?: string
  msgType?: string
  msgId?: string
  content?: DingTalkMessageContent
}

/** A robot message from the Stream topic `/v1.0/im/bot/messages/get` (dingtalk-integration.md §4.1). */
export interface DingTalkRobotMessage {
  msgId?: string
  createAt?: number
  conversationId?: string
  conversationType?: string
  conversationTitle?: string
  senderStaffId?: string
  senderId?: string
  senderUnionId?: string
  senderNick?: string
  senderCorpId?: string
  chatbotCorpId?: string
  chatbotUserId?: string
  robotCode?: string
  isInAtList?: boolean
  atUsers?: { dingtalkId?: string; staffId?: string }[]
  isAdmin?: boolean
  openThreadId?: string
  msgtype?: string
  text?: { content?: string; isReplyMsg?: boolean; repliedMsg?: DingTalkRepliedMessage }
  content?: DingTalkMessageContent
  originalProcessQueryKey?: string
  originalMsgId?: string
  sessionWebhook?: string
  sessionWebhookExpiredTime?: number
}

/** The receiving robot's verified identity; it is never taken from the payload. */
export interface DingTalkNormalizeContext {
  /** The internal app's Client ID, which DingTalk sends as `robotCode`. */
  robotCode: string
  traceId: string
}

interface DingTalkFile {
  downloadCode: string
  fileName?: string
  image: boolean
}

const MAX_QUOTED_TEXT_CHARS = 1000

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

// A DM is keyed by its member's staff id, the address a robot DM send takes.
export function dingTalkDmChannel(staffId: string): string {
  return `dm:${staffId}`
}

// The text and downloadable media of a non-text body; null for a type this normalizer does not serve.
function mediaOf(msgtype: string | undefined, content: DingTalkMessageContent | undefined) {
  const files: DingTalkFile[] = []
  const add = (code: unknown, image: boolean, fileName?: unknown) => {
    const downloadCode = str(code)
    if (downloadCode) files.push({ downloadCode, image, ...(str(fileName) ? { fileName: str(fileName) } : {}) })
  }
  if (msgtype === 'picture') add(content?.downloadCode, true)
  else if (msgtype === 'file') add(content?.downloadCode, false, content?.fileName)
  else if (msgtype === 'richText') {
    const items = Array.isArray(content?.richText) ? content.richText : []
    const text = items.map((item) => str(item?.text) ?? '').join('')
    for (const item of items) if (item && !str(item.text)) add(item.downloadCode, true)
    return { text, files }
  } else return null
  return { text: '', files }
}

function toAttachment(file: DingTalkFile, id: string, index: number): PlatformAttachment {
  const name = safeAttachmentName(file.fileName)
  return {
    id,
    name: name ?? (file.image ? `image-${index + 1}.jpg` : `attachment-${index + 1}`),
    mimeType: file.image ? 'image/jpeg' : mimeTypeFromFileName(name),
    // An opaque download code, exchanged for a short-lived URL with the robot code, like Telegram's file_id.
    sourceUrl: file.downloadCode
  }
}

// Normalize one robot message: a DM or a group mention, the only traffic DingTalk delivers; null when it cannot be served.
export function normalizeDingTalkMessage(
  payload: DingTalkRobotMessage,
  context: DingTalkNormalizeContext
): NormalizedPlatformMessage | null {
  const isDm = payload.conversationType === '1'
  const isGroup = payload.conversationType === '2'
  const conversationId = str(payload.conversationId)
  const messageId = str(payload.msgId)
  const staffId = str(payload.senderStaffId)
  const senderId = staffId ?? str(payload.senderId)
  if ((!isDm && !isGroup) || !conversationId || !messageId || !senderId) return null
  if (payload.robotCode !== context.robotCode) return null
  if (str(payload.chatbotUserId) && payload.senderId === payload.chatbotUserId) return null
  // A robot DM send addresses a staff id, so a DM without one cannot be answered; a group id never reads as a DM key.
  if ((isDm && !staffId) || (isGroup && conversationId.startsWith('dm:'))) return null

  const body =
    payload.msgtype === 'text'
      ? { text: str(payload.text?.content) ?? '', files: [] }
      : mediaOf(payload.msgtype, payload.content)
  if (!body) return null

  const replied = payload.text?.isReplyMsg === true ? payload.text.repliedMsg : undefined
  const quotedMedia = replied ? mediaOf(replied.msgType, replied.content) : null
  // A quote of a type mediaOf does not serve still yields its download code, as a quoted file does.
  const quotedCode = str(replied?.content?.downloadCode)
  const quotedFiles: DingTalkFile[] =
    quotedMedia?.files ??
    (quotedCode ? [{ downloadCode: quotedCode, fileName: str(replied?.content?.fileName), image: false }] : [])
  // The bot's own message comes back by the process query key its send returned, the id recorded for it.
  const replyTo = replied ? (str(payload.originalProcessQueryKey) ?? str(replied.msgId)) : undefined

  const attachments: PlatformAttachment[] = []
  const quotedAttachments: PlatformAttachment[] = []
  const sources = [
    ...body.files.map((file, index) => ({ file, id: `${messageId}:${index}`, quote: false })),
    ...quotedFiles.map((file, index) => ({
      file,
      id: `${str(replied?.msgId) ?? messageId}:quote:${index}`,
      quote: true
    }))
  ]
  for (const { file, id, quote } of sources) {
    if (attachments.some((item) => item.sourceUrl === file.downloadCode)) continue
    const attachment = toAttachment(file, id, attachments.length)
    attachments.push(attachment)
    if (quote) quotedAttachments.push(attachment)
  }

  const quoteBody = [str(replied?.content?.text) ?? quotedMedia?.text ?? '', attachmentMention(quotedAttachments)]
    .filter(Boolean)
    .join('\n')
  const truncated = quoteBody.length > MAX_QUOTED_TEXT_CHARS
  const quoted: QuotedMessage | undefined = quoteBody
    ? {
        ...(replyTo ? { messageId: replyTo } : {}),
        text: truncated ? `${quoteBody.slice(0, MAX_QUOTED_TEXT_CHARS)}…` : quoteBody,
        ...(truncated ? { excerpt: true } : {})
      }
    : undefined

  // A group mention arrives with the robot removed and its leading space left behind.
  const text = isGroup ? body.text.trim() : body.text
  if (!text.trim() && !attachments.length && !quoted) return null
  const senderName = str(payload.senderNick)?.trim()
  const createAt = payload.createAt
  return {
    msgId: `${DINGTALK_PLATFORM}:${conversationId}:${messageId}`,
    traceId: context.traceId,
    source: 'user',
    platform: DINGTALK_PLATFORM,
    channel: isDm ? dingTalkDmChannel(staffId!) : conversationId,
    sender: { id: senderId, isBot: false, ...(senderName ? { name: senderName } : {}) },
    text,
    ...(attachments.length ? { attachments } : {}),
    mentionedBots: isGroup && payload.isInAtList === true ? [context.robotCode] : [],
    isDm,
    ...(replyTo ? { replyTo } : {}),
    ...(quoted ? { quoted } : {}),
    // DingTalk message ids carry no time, so the send time is the only chronological coordinate.
    ...(typeof createAt === 'number' && Number.isSafeInteger(createAt) && createAt > 0
      ? { platformTimeMs: createAt }
      : {})
  }
}
