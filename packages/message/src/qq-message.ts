import type { NormalizedPlatformMessage, PlatformAttachment } from '@agentconnect.md/protocol'

interface QQUrl {
  protocol: string
  username: string
  password: string
  port: string
  hostname: string
  href: string
}

interface QQUrlConstructor {
  new (input: string): QQUrl
}

export interface QQAttachment {
  content_type: string
  url: string
  filename?: string
  size?: number
  voice_wav_url?: string
}

export interface QQMessageEvent {
  rawEventType: string
  kind: string
  senderId: string
  senderName?: string
  senderIsBot?: boolean
  groupOpenid?: string
  content: string
  messageId: string
  attachments?: QQAttachment[]
  msgIdx?: string
  refMsgIdx?: string
  msgElements?: { msg_idx?: string; content?: string; attachments?: QQAttachment[] }[]
}

export interface QQQuotedMessage {
  messageId?: string
  sender?: string
  content?: string
  attachments?: QQAttachment[]
  excerpt?: boolean
}

const QQ_USER_ID_PREFIX = 'qq:user:'

export function QQUserId(appId: string, openId: string): string {
  return `${QQ_USER_ID_PREFIX}${appId}:${openId}`
}

export function parseQQUserId(id: string): { appId: string; openId: string } | undefined {
  if (!id.startsWith(QQ_USER_ID_PREFIX)) return undefined
  const value = id.slice(QQ_USER_ID_PREFIX.length)
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) return undefined
  return { appId: value.slice(0, separator), openId: value.slice(separator + 1) }
}

export function QQAvatarUrl(appId: string, openId: string): string {
  return `https://q.qlogo.cn/qqapp/${encodeURIComponent(appId)}/${encodeURIComponent(openId)}/640`
}

export function QQAttachmentUrl(value: string): string | undefined {
  try {
    const URLConstructor = (globalThis as typeof globalThis & { URL?: QQUrlConstructor }).URL
    if (!URLConstructor) return undefined
    const url = new URLConstructor(value.startsWith('//') ? `https:${value}` : value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return undefined
    if (
      !['qpic.cn', 'qq.com', 'qq.com.cn'].some(
        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
      )
    )
      return undefined
    url.protocol = 'https:'
    return url.href
  } catch {
    return undefined
  }
}

function qqAttachmentMimeType(contentType: string, filename?: string, wav = false): string {
  const value = contentType.toLowerCase().split(';')[0]!.trim().replace('image/jpg', 'image/jpeg')
  if (value === 'voice') return wav ? 'audio/wav' : 'application/octet-stream'
  if (value !== 'file') return value || 'application/octet-stream'
  const ext = filename?.split('.').pop()?.toLowerCase()
  const byExtension: Record<string, string> = {
    pdf: 'application/pdf',
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4'
  }
  return (ext && byExtension[ext]) || 'application/octet-stream'
}

// Admit DMs and explicit group mentions before core routing; ambient messages must never activate through affinity.
export function normalizeQQMessage(
  appId: string,
  message: QQMessageEvent,
  traceId: string,
  reference?: QQQuotedMessage
): NormalizedPlatformMessage | null {
  const isDm = message.rawEventType === 'C2C_MESSAGE_CREATE' && message.kind === 'c2c'
  const isGroup = message.rawEventType === 'GROUP_AT_MESSAGE_CREATE' && message.kind === 'group'
  if (
    (!isDm && !isGroup) ||
    (isGroup && !message.groupOpenid) ||
    message.senderIsBot ||
    !message.senderId ||
    !message.messageId
  )
    return null
  const attachments: PlatformAttachment[] = []
  let unsupported = false
  const element = message.refMsgIdx
    ? (message.msgElements?.find((item) => item.msg_idx === message.refMsgIdx) ?? message.msgElements?.[0])
    : undefined
  const quotedAttachments = element?.attachments ?? reference?.attachments ?? []
  const sources = [
    ...(message.attachments ?? []).map((attachment, index) => ({ attachment, id: `${message.messageId}:${index}` })),
    ...quotedAttachments.map((attachment, index) => ({ attachment, id: `${message.refMsgIdx}:quote:${index}` }))
  ]
  for (const { attachment, id } of sources) {
    const voiceUrl =
      attachment.content_type.toLowerCase().trim() === 'voice'
        ? QQAttachmentUrl(attachment.voice_wav_url ?? '')
        : undefined
    const mimeType = qqAttachmentMimeType(attachment.content_type, attachment.filename, Boolean(voiceUrl))
    const sourceUrl = voiceUrl ?? QQAttachmentUrl(attachment.url)
    if (!sourceUrl) {
      unsupported = true
      continue
    }
    const name = attachment.filename?.replace(/[\\/\x00-\x1f\x7f()]/g, '_').slice(0, 160)
    if (attachments.some((item) => item.sourceUrl === sourceUrl)) continue
    attachments.push({
      id,
      name:
        name ||
        (mimeType.startsWith('image/')
          ? `image-${attachments.length + 1}.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice(6)}`
          : `attachment-${attachments.length + 1}`),
      mimeType,
      sourceUrl,
      ...(Number.isFinite(attachment.size) && attachment.size! >= 0 ? { size: attachment.size } : {})
    })
  }
  const text = [
    isGroup
      ? message.content.replace(/<@!?([^>]+)>/g, (marker, id: string) => (id === appId ? '' : marker)).trim()
      : message.content,
    ...(unsupported ? ['[QQ attachment unavailable: its download URL is invalid or unsupported.]'] : [])
  ]
    .filter(Boolean)
    .join('\n')
  const quoteText = [
    element?.content ?? reference?.content ?? '',
    ...quotedAttachments.map((item) => `[Attachment: ${item.filename ?? item.content_type}]`)
  ]
    .filter(Boolean)
    .join('\n')
  const replyTo = message.refMsgIdx ? (reference?.messageId ?? `ref:${message.refMsgIdx}`) : undefined
  if (!text.trim() && !attachments.length && !quoteText) return null
  const senderName = message.senderName?.trim()
  return {
    platform: 'qq',
    source: 'user',
    traceId,
    msgId: isDm
      ? `qq:${appId}:${message.senderId}:${message.messageId}`
      : `qq:${appId}:group:${message.groupOpenid}:${message.messageId}`,
    channel: isDm ? `dm:${message.senderId}` : `group:${message.groupOpenid}`,
    thread: isDm ? 'dm' : 'group',
    sender: {
      id: QQUserId(appId, message.senderId),
      isBot: false,
      ...(senderName ? { name: senderName } : {}),
      avatarUrl: QQAvatarUrl(appId, message.senderId)
    },
    text,
    ...(attachments.length ? { attachments } : {}),
    mentionedBots: isDm ? [] : [appId],
    isDm,
    ...(replyTo ? { replyTo } : {}),
    ...(replyTo && quoteText
      ? {
          quoted: {
            messageId: replyTo,
            ...(reference?.sender ? { sender: reference.sender } : {}),
            text: quoteText.slice(0, 1000),
            ...(quoteText.length > 1000 || reference?.excerpt ? { excerpt: true } : {})
          }
        }
      : {}),
    adapterExt: { qq: { replyId: message.messageId } }
  }
}
