import type { Attachment, NormalizedMessage } from '../messages/normalized.js'

/**
 * Discord inbound normalization. Mirrors telegram/normalize.ts: a pure function
 * over a minimal, plain-object view of a message so it is unit-testable without a
 * live discord.js `Message`. `discord/connection.ts` adapts the real gateway
 * `Message` into `DiscordMessageLike` before calling in.
 *
 * Channel/thread model: Discord threads are first-class channel objects, so the
 * concrete channel a message arrived in (`channelId` — the thread's own id when in a
 * thread) IS the conversation. We set `thread = channelId` too, so a session keys on
 * `(channel, channel)` — stable across every turn in that channel/thread (session
 * continuity) and enough for thread-affinity routing of un-mentioned follow-ups.
 * (Contrast Telegram, where a forum topic / reply chain maps to `thread`.)
 *
 * A top-level guild message (not a DM, not already in a thread) is flagged
 * `discordTopLevel`: the daemon opens a thread off it and re-keys the turn into that
 * thread channel (Slack-parity — the reply + chrome live in a thread, not the channel).
 *
 * ATTACHMENTS: unlike Telegram's opaque `file_id`, Discord always ships a public
 * CDN url on the attachment — so `sourceUrl` is that url and the connection's
 * downloadFile is a plain bounded fetch (no auth, no getFile two-step).
 *
 * MENTIONS: `mentionedBots` carries the raw numeric user ids of every mentioned
 * user (`<@id>` / `<@!id>`), so the daemon can match the bot's own user id for
 * routing (Discord routes on user id, where Telegram routes on @username).
 */

export interface DiscordAttachmentLike {
  id: string
  name?: string | null
  contentType?: string | null
  size?: number
  url: string // Discord CDN url — public (no auth), but expiring
}

export interface DiscordMessageLike {
  id: string
  channelId: string
  content: string
  authorId: string
  authorIsBot: boolean
  /** False ⇒ a DM (no guild). */
  inGuild: boolean
  /** True when `channelId` is itself a thread channel (a message posted inside a
   *  thread). Top-level channel messages are false; DMs are false. */
  isThread: boolean
  /** Ids of every user mentioned (`<@id>` / `<@!id>`). */
  mentionUserIds: string[]
  /** Display name per mentioned user id, from the gateway message's own mention cache
   *  — so the humanized text (and the session title derived from it) reads "@alice"
   *  rather than the raw snowflake. Ids missing here stay as `@id`. */
  mentionUserNames?: Record<string, string>
  /** Enclosing channel id when `channelId` is a thread (null/absent otherwise). */
  parentChannelId?: string | null
  attachments: DiscordAttachmentLike[]
}

/** Map a Discord attachment to a NormalizedMessage Attachment. Discord always
 *  reports a public CDN url + id, so the only tolerance needed is a missing name. */
export function toAttachment(a: DiscordAttachmentLike | null | undefined): Attachment | null {
  if (!a || typeof a !== 'object' || !a.id || !a.url) return null
  return {
    id: a.id,
    name: a.name ?? a.id,
    mimeType: a.contentType ?? 'application/octet-stream',
    ...(typeof a.size === 'number' ? { size: a.size } : {}),
    sourceUrl: a.url
  }
}

/**
 * Humanize Discord's inline entity tokens so the agent sees readable text rather
 * than raw markup — the analog of the leading '@' / entity handling Telegram does
 * via message entities. Pure: user mentions resolve through the caller-supplied
 * `userNames` (the gateway message's own mention cache), and anything unresolved is
 * left as a compact `@id` / `#id` / `:name:` form:
 *   `<@id>` / `<@!id>`     → `@alice`   (user mention; `@id` when the name is unknown)
 *   `<@&roleid>`           → `@&roleid` (role mention)
 *   `<#chanid>`            → `#chanid`  (channel mention)
 *   `<a?:name:id>`         → `:name:`   (custom / animated emoji)
 *   `<t:unix(:style)?>`    → ISO-8601   (Discord timestamp)
 */
export function humanizeDiscordText(text: string, userNames?: Record<string, string>): string {
  return text
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (_m, unix: string) => {
      const d = new Date(Number(unix) * 1000)
      return Number.isFinite(d.getTime()) ? d.toISOString() : _m
    })
    .replace(/<@!?(\d+)>/g, (_m, id: string) => `@${userNames?.[id] ?? id}`)
    .replace(/<@&(\d+)>/g, '@&$1')
    .replace(/<#(\d+)>/g, '#$1')
}

/** Normalize a Discord gateway message into the platform-agnostic contract. */
export function normalizeDiscordMessage(msg: DiscordMessageLike, ctx: { traceId: string }): NormalizedMessage {
  const attachments = msg.attachments.map(toAttachment).filter((a): a is Attachment => a !== null)
  const isDm = !msg.inGuild
  return {
    msgId: `discord:${msg.channelId}:${msg.id}`,
    traceId: ctx.traceId,
    source: 'user',
    platform: 'discord',
    channel: msg.channelId,
    // Discord channel (incl. a thread channel) == conversation == session (see header).
    thread: msg.channelId,
    sender: { id: msg.authorId, isBot: msg.authorIsBot },
    text: humanizeDiscordText(msg.content, msg.mentionUserNames),
    mentionedBots: msg.mentionUserIds,
    ...(attachments.length ? { attachments } : {}),
    isDm,
    // The enclosing channel of a thread message: the reachable CHANNEL this
    // conversation belongs to, where the session keys on the thread (see header).
    // Channel-scoped routing/gating and channel discovery both key on it.
    ...(msg.isThread && msg.parentChannelId ? { parentChannel: msg.parentChannelId } : {}),
    // Top-level guild message → the daemon opens a thread off it and re-keys the turn.
    ...(!isDm && !msg.isThread ? { discordTopLevel: true } : {})
  }
}
