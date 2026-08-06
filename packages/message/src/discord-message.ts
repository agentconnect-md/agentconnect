import type { NormalizedPlatformMessage, PlatformAttachment } from '@agentconnect.md/protocol'

/**
 * Minimal plain-object Discord view accepted by pure normalization. The daemon
 * adapts discord.js gateway messages and slash commands into this shape.
 */
// Discord snowflakes embed their creation time in the top 42 bits (ms since
// the Discord epoch, 2015-01-01). BigInt: snowflakes exceed Number's safe
// integer range.
const DISCORD_EPOCH_MS = 1_420_070_400_000n
function snowflakeTimeMs(id: string): number | undefined {
  if (!/^\d{16,20}$/.test(id)) return undefined
  const ms = Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS)
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined
}

export interface DiscordAttachmentLike {
  id: string
  name?: string | null
  contentType?: string | null
  size?: number
  url: string
}

export interface DiscordMessageLike {
  id: string
  channelId: string
  /** Canonical Discord client URL for this message (or conversation for a
   *  slash-command interaction that has no message object yet). */
  url?: string
  content: string
  authorId: string
  authorIsBot: boolean
  authorAvatarUrl?: string
  /** False when the message is a DM with no guild. */
  inGuild: boolean
  /** True when `channelId` is itself a Discord thread channel. */
  isThread: boolean
  mentionUserIds: string[]
  mentionUserNames?: Record<string, string>
  /** Enclosing channel id when `channelId` is a thread. */
  parentChannelId?: string | null
  attachments: DiscordAttachmentLike[]
}

/** Map public Discord CDN metadata into the shared attachment contract. */
export function toDiscordAttachment(attachment: DiscordAttachmentLike | null | undefined): PlatformAttachment | null {
  if (!attachment || typeof attachment !== 'object' || !attachment.id || !attachment.url) return null
  return {
    id: attachment.id,
    name: attachment.name ?? attachment.id,
    mimeType: attachment.contentType ?? 'application/octet-stream',
    ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
    sourceUrl: attachment.url
  }
}

/**
 * Humanize Discord inline entities without depending on discord.js:
 * user/role/channel mentions become readable labels, custom emoji become
 * `:name:`, and Discord timestamps become ISO-8601.
 */
export function humanizeDiscordText(text: string, userNames?: Record<string, string>): string {
  return text
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (token, unix: string) => {
      const timestamp = new Date(Number(unix) * 1000)
      return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : token
    })
    .replace(/<@!?(\d+)>/g, (_token, id: string) => `@${userNames?.[id] ?? id}`)
    .replace(/<@&(\d+)>/g, '@&$1')
    .replace(/<#(\d+)>/g, '#$1')
}

export function normalizeDiscordMessage(
  message: DiscordMessageLike,
  context: { traceId: string }
): NormalizedPlatformMessage {
  const attachments = message.attachments
    .map(toDiscordAttachment)
    .filter((attachment): attachment is PlatformAttachment => attachment !== null)
  const isDm = !message.inGuild
  // Discord models a thread as a channel of its own. The normalized contract does
  // not: `channel` is the configurable enclosing conversation (Slack parity), while
  // `thread` is the concrete thread within it. DMs and top-level guild messages have
  // no separate enclosing id, so their channel remains the provider channel id.
  const channel = message.isThread && message.parentChannelId ? message.parentChannelId : message.channelId

  return {
    msgId: `discord:${message.channelId}:${message.id}`,
    ...(snowflakeTimeMs(message.id) !== undefined ? { platformTimeMs: snowflakeTimeMs(message.id) } : {}),
    traceId: context.traceId,
    source: 'user',
    platform: 'discord',
    channel,
    ...(message.url ? { threadUrl: message.url } : {}),
    // For an in-thread message `message.channelId` is the Discord thread channel id.
    // For a top-level message/DM this temporarily equals `channel`; successful
    // top-level promotion replaces it with the newly-created thread id.
    thread: message.channelId,
    sender: {
      id: message.authorId,
      isBot: message.authorIsBot,
      ...(message.authorAvatarUrl ? { avatarUrl: message.authorAvatarUrl } : {})
    },
    text: humanizeDiscordText(message.content, message.mentionUserNames),
    mentionedBots: message.mentionUserIds,
    ...(attachments.length ? { attachments } : {}),
    isDm,
    // §6.5 emission flip: the generic coordinate only — `discordTopLevel` retired.
    ...(!isDm && !message.isThread ? { promoteToThread: true } : {})
  }
}
