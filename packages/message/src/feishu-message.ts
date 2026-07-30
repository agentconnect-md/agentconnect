import type { NormalizedPlatformMessage, PlatformAttachment } from './normalized-message.js'

/**
 * Minimal plain-object view of a Lark `im.message.receive_v1` event. Both the
 * daemon-owned long connection and relay-owned HTTP callback adapt into this
 * shape before normalizing, so the two ingress transports stay identical.
 */
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
    root_id?: string
    mentions?: FeishuMention[]
  }
}

export interface FeishuMention {
  key?: string
  id?: { open_id?: string }
  name?: string
}

export interface FeishuAttachmentLike {
  fileKey: string
  type: 'image' | 'file'
  name?: string
  mimeType?: string
  size?: number
}

export interface FeishuMessageLike {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group' | string
  messageType: string
  content: string
  rootId?: string
  senderOpenId: string
  senderIsBot?: boolean
  mentions?: FeishuMention[]
  attachments?: FeishuAttachmentLike[]
}

const DOWNLOAD_KEY_SEP = ':'

export function toFeishuAttachment(
  attachment: FeishuAttachmentLike | null | undefined,
  messageId: string
): PlatformAttachment | null {
  if (!attachment || typeof attachment !== 'object' || !attachment.fileKey || !messageId) return null
  if (attachment.type !== 'image' && attachment.type !== 'file') return null
  return {
    id: attachment.fileKey,
    name: attachment.name ?? attachment.fileKey,
    mimeType: attachment.mimeType ?? 'application/octet-stream',
    ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
    sourceUrl: [messageId, attachment.type, attachment.fileKey].join(DOWNLOAD_KEY_SEP)
  }
}

export function humanizeFeishuText(text: string, mentions?: FeishuMention[]): string {
  if (!text || !mentions?.length) return text
  let out = text
  const ordered = [...mentions].sort((a, b) => (b?.key?.length ?? 0) - (a?.key?.length ?? 0))
  for (const mention of ordered) {
    if (!mention?.key) continue
    const label = mention.name ?? mention.id?.open_id
    if (label) out = out.split(mention.key).join(`@${label}`)
  }
  return out
}

function flattenPost(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  const obj = parsed as Record<string, unknown>
  let node: Record<string, unknown> | undefined
  if (Array.isArray(obj.content)) node = obj
  else {
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).content)) {
        node = value as Record<string, unknown>
        break
      }
    }
  }
  if (!node) return ''
  const title = typeof node.title === 'string' ? node.title : ''
  const body = (node.content as unknown[])
    .map((line) => {
      if (!Array.isArray(line)) return ''
      return line
        .map((segment) => {
          if (!segment || typeof segment !== 'object') return ''
          const item = segment as Record<string, unknown>
          if (item.tag === 'at') {
            const name = (item.user_name ?? item.user_id) as string | undefined
            return name ? `@${name}` : ''
          }
          return typeof item.text === 'string' ? item.text : ''
        })
        .join('')
    })
    .join('\n')
  return [title, body].filter(Boolean).join('\n')
}

function extractText(messageType: string, content: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return ''
  }
  if (messageType === 'text') {
    const text = (parsed as Record<string, unknown>)?.text
    return typeof text === 'string' ? text : ''
  }
  return messageType === 'post' ? flattenPost(parsed) : ''
}

export function deriveFeishuAttachments(messageType: string, content: string): FeishuAttachmentLike[] {
  try {
    const parsed = JSON.parse(content || '{}') as Record<string, unknown>
    if (messageType === 'image' && typeof parsed.image_key === 'string') {
      return [{ fileKey: parsed.image_key, type: 'image' }]
    }
    if ((messageType === 'file' || messageType === 'media') && typeof parsed.file_key === 'string') {
      return [
        {
          fileKey: parsed.file_key,
          type: 'file',
          ...(typeof parsed.file_name === 'string' ? { name: parsed.file_name } : {})
        }
      ]
    }
  } catch {
    // Malformed provider content has no usable attachment metadata.
  }
  return []
}

export function feishuEventToMessageLike(event: FeishuRawEvent): FeishuMessageLike {
  const message = event.message ?? {}
  const senderType = event.sender?.sender_type
  return {
    messageId: message.message_id ?? '',
    chatId: message.chat_id ?? '',
    chatType: message.chat_type ?? 'group',
    messageType: message.message_type ?? 'text',
    content: message.content ?? '',
    ...(message.root_id ? { rootId: message.root_id } : {}),
    senderOpenId: event.sender?.sender_id?.open_id ?? '',
    senderIsBot: senderType != null && senderType !== 'user',
    mentions: (message.mentions ?? []).map((mention) => ({
      ...(mention.key ? { key: mention.key } : {}),
      ...(mention.id ? { id: mention.id } : {}),
      ...(mention.name ? { name: mention.name } : {})
    })),
    attachments: deriveFeishuAttachments(message.message_type ?? 'text', message.content ?? '')
  }
}

export function normalizeFeishuMessage(
  message: FeishuMessageLike,
  context: { traceId: string }
): NormalizedPlatformMessage {
  const attachments = (message.attachments ?? [])
    .map((attachment) => toFeishuAttachment(attachment, message.messageId))
    .filter((attachment): attachment is PlatformAttachment => attachment !== null)
  const isDm = message.chatType === 'p2p'
  return {
    msgId: `feishu:${message.chatId}:${message.messageId}`,
    traceId: context.traceId,
    source: 'user',
    platform: 'feishu',
    channel: message.chatId,
    thread: isDm ? message.chatId : (message.rootId ?? message.messageId),
    sender: { id: message.senderOpenId, isBot: message.senderIsBot ?? false },
    text: humanizeFeishuText(extractText(message.messageType, message.content), message.mentions),
    mentionedBots: (message.mentions ?? [])
      .map((mention) => mention?.id?.open_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ...(attachments.length ? { attachments } : {}),
    isDm
  }
}
