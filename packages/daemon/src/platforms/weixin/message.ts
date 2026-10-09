import { randomUUID } from 'node:crypto'
import type { NormalizedPlatformMessage } from '@agentconnect.md/protocol'
import type { NormalizedChatEvent } from './vendor/sdk/protocol/chat-event.js'

const WEIXIN_USER_ID_PREFIX = 'weixin:user:'

export function WeixinUserId(accountId: string, peerId: string): string {
  return `${WEIXIN_USER_ID_PREFIX}${accountId}:${peerId}`
}

export function parseWeixinUserId(id: string): { accountId: string; peerId: string } | undefined {
  if (!id.startsWith(WEIXIN_USER_ID_PREFIX)) return undefined
  const value = id.slice(WEIXIN_USER_ID_PREFIX.length)
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) return undefined
  return { accountId: value.slice(0, separator), peerId: value.slice(separator + 1) }
}

// iLink is DM-only: every inbound event is one peer writing the bot. Group chat
// does not exist on this transport, so `chat.type` is asserted rather than branched.
export function normalizeWeixinEvent(accountId: string, event: NormalizedChatEvent): NormalizedPlatformMessage | null {
  const peerId = event.from.id
  if (!peerId) return null
  const messageId = event.id !== undefined && event.id !== null ? String(event.id) : `seq:${event.seq ?? randomUUID()}`
  const text = (event.text ?? event.caption ?? '').trim()
  const attachment = event.media
    ? [
        {
          id: `${messageId}:0`,
          name:
            event.media.kind === 'document' && event.media.fileName
              ? event.media.fileName.replace(/[\\/\x00-\x1f\x7f()]/g, '_').slice(0, 160)
              : `${event.media.kind}-1`,
          mimeType:
            event.media.kind === 'photo'
              ? 'image/jpeg'
              : event.media.kind === 'video'
                ? 'video/mp4'
                : event.media.kind === 'voice'
                  ? 'audio/silk'
                  : 'application/octet-stream',
          // Not an http(s) URL — `downloadFile` resolves this ref through the bot's
          // CDN decrypt path (`downloadRecentMedia`).
          sourceUrl: `ilink-media:${messageId}:0`
        }
      ]
    : []
  if (!text && !attachment.length) return null
  return {
    platform: 'weixin',
    source: 'user',
    traceId: messageId,
    msgId: `weixin:${accountId}:${peerId}:${messageId}`,
    channel: `dm:${peerId}`,
    thread: 'dm',
    sender: { id: WeixinUserId(accountId, peerId), isBot: false },
    text,
    ...(attachment.length ? { attachments: attachment } : {}),
    mentionedBots: [],
    isDm: true,
    adapterExt: {
      weixin: {
        peerId,
        ...(event.contextToken ? { contextToken: event.contextToken } : {}),
        mediaKind: event.media?.kind
      }
    }
  }
}
