import type { NormalizedPlatformMessage, PlatformAttachment } from './normalized-message.js'
import { extractSlackMessageText } from './slack-message-text.js'

/** The subset of a Slack file element carried through normalization. */
export interface SlackFile {
  id?: string
  name?: string | null
  title?: string | null
  mimetype?: string
  filetype?: string
  size?: number
  url_private?: string
  url_private_download?: string
  mode?: string
}

/**
 * Plain-object Slack event view accepted by both Socket Mode and HTTP Events
 * API ingress. Membership and other non-message events may omit chat fields.
 */
export interface SlackMessageLike {
  type: string
  subtype?: string
  channel?: string
  channel_type?: string
  thread_ts?: string
  ts?: string
  user?: string
  bot_id?: string
  app_id?: string
  bot_profile?: { app_id?: string }
  hidden?: boolean
  message?: unknown
  text?: string
  files?: SlackFile[]
  blocks?: unknown[]
  attachments?: unknown[]
}

/** A Slack chat event whose identity fields have already been validated. */
export type SlackMessage = SlackMessageLike & { channel: string; ts: string }

const MENTION_RE = /<@([A-Z0-9]+)>/g

/** Map provider file metadata to a fetchable attachment, dropping malformed or
 * tombstoned files that have no stable id and provider URL. */
export function toSlackAttachment(file: SlackFile | null | undefined): PlatformAttachment | null {
  if (!file || typeof file !== 'object') return null
  const sourceUrl = file.url_private_download ?? file.url_private
  if (!file.id || !sourceUrl) return null
  return {
    id: file.id,
    name: file.name ?? file.title ?? file.id,
    mimeType: file.mimetype ?? 'application/octet-stream',
    ...(typeof file.size === 'number' ? { size: file.size } : {}),
    sourceUrl
  }
}

export function normalizeSlackMessage(message: SlackMessage, context: { traceId: string }): NormalizedPlatformMessage
export function normalizeSlackMessage(
  message: SlackMessageLike,
  context?: { traceId?: string }
): NormalizedPlatformMessage | null
export function normalizeSlackMessage(
  message: SlackMessageLike,
  context: { traceId?: string } = {}
): NormalizedPlatformMessage | null {
  if (typeof message.channel !== 'string' || typeof message.ts !== 'string') return null

  const text = extractSlackMessageText(message)
  const mentionedBots = [...text.matchAll(MENTION_RE)].map((match) => match[1]!)
  const attachments = (message.files ?? [])
    .map(toSlackAttachment)
    .filter((attachment): attachment is PlatformAttachment => attachment !== null)
  const appId = message.app_id ?? message.bot_profile?.app_id
  const msgId = `slack:${message.channel}:${message.ts}`

  return {
    msgId,
    traceId: context.traceId ?? msgId,
    source: 'user',
    platform: 'slack',
    channel: message.channel,
    thread: message.thread_ts ?? message.ts,
    sender: {
      id: message.user ?? message.bot_id ?? 'unknown',
      isBot: Boolean(message.bot_id || appId),
      ...(appId ? { appId } : {})
    },
    text,
    mentionedBots,
    ...(attachments.length ? { attachments } : {}),
    isDm: message.channel_type === 'im',
    // `app_mention` payloads omit channel_type. Do not guess from the channel
    // prefix because Slack uses "G…" for both mpims and legacy private channels.
    ...(message.channel_type === 'mpim' ? { isGroupDm: true } : {})
  }
}

/** Slack's platform-defined sender for system notifications. */
const SLACK_SYSTEM_USER_ID = 'USLACK'

/** System notifications are not user turns and must never enter agent routing. */
export function isSlackSystemMessage(message: { user?: unknown }): boolean {
  return message.user === SLACK_SYSTEM_USER_ID
}
