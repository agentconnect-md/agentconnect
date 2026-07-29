import type { Attachment, NormalizedMessage } from '../messages/normalized.js'
import { extractSlackMessageText } from '@agentconnect.md/protocol'

/** The subset of a Slack file element we carry through normalization (§9.2). */
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

export interface SlackMessageEvent {
  type: string
  subtype?: string
  channel: string
  channel_type?: string
  thread_ts?: string
  ts: string
  user?: string
  bot_id?: string
  app_id?: string
  bot_profile?: { app_id?: string }
  hidden?: boolean
  /** Structural update wrappers (`message_changed` / `message_replied`) carry the
   *  actual message here instead of being a user-authored chat event themselves. */
  message?: unknown
  text?: string
  files?: SlackFile[]
  blocks?: unknown[]
  attachments?: unknown[]
}

const MENTION_RE = /<@([A-Z0-9]+)>/g

/** Map a Slack file element to a NormalizedMessage Attachment, dropping any
 *  without a usable id + fetch URL (e.g. external/tombstoned files). Tolerates a
 *  malformed (null / non-object) element off the wire without throwing. */
export function toAttachment(f: SlackFile | null | undefined): Attachment | null {
  if (!f || typeof f !== 'object') return null
  const sourceUrl = f.url_private_download ?? f.url_private
  if (!f.id || !sourceUrl) return null
  return {
    id: f.id,
    name: f.name ?? f.title ?? f.id,
    mimeType: f.mimetype ?? 'application/octet-stream',
    ...(typeof f.size === 'number' ? { size: f.size } : {}),
    sourceUrl
  }
}

export function normalizeSlackEvent(event: SlackMessageEvent, ctx: { traceId: string }): NormalizedMessage {
  const text = extractSlackMessageText(event)
  const mentionedBots = [...text.matchAll(MENTION_RE)].map((m) => m[1]!)
  const attachments = (event.files ?? []).map(toAttachment).filter((a): a is Attachment => a !== null)
  const appId = event.app_id ?? event.bot_profile?.app_id
  return {
    msgId: `slack:${event.channel}:${event.ts}`,
    traceId: ctx.traceId,
    source: 'user',
    platform: 'slack',
    channel: event.channel,
    thread: event.thread_ts ?? event.ts,
    sender: {
      id: event.user ?? event.bot_id ?? 'unknown',
      isBot: Boolean(event.bot_id || appId),
      ...(appId ? { appId } : {})
    },
    text,
    mentionedBots,
    ...(attachments.length ? { attachments } : {}),
    isDm: event.channel_type === 'im',
    // A group DM is mention-gated like a channel, so this only classifies the
    // conversation — it never makes the message addressed. `app_mention` payloads
    // omit channel_type, so an unflagged mpim mention is classified later from the
    // conversation lookup rather than guessed from the id (Slack "G…" ids are
    // shared with legacy private channels).
    ...(event.channel_type === 'mpim' ? { isGroupDm: true } : {})
  }
}
