import type { NormalizedPlatformMessage, PlatformAttachment } from '@agentconnect.md/protocol'

/**
 * A file shared alongside a message. Platform ingresses carry metadata + a
 * fetch URL and download the bytes daemon-locally with the provider token.
 * Webchat may instead arrive with bounded inline bytes from the relay content
 * plane. Both forms become ACP image/resource blocks at prompt assembly; the
 * daemon also retains bounded webchat images for authorized transcript replay.
 */
export interface Attachment extends Omit<PlatformAttachment, 'sourceUrl'> {
  /** Stable source id (Slack file.id). */
  id: string
  /** Display name / title. */
  name: string
  /** e.g. 'image/png', 'application/pdf'. */
  mimeType: string
  /** Bytes, when the platform reports it. */
  size?: number
  /** Auth-gated provider URL/key, absent for an inline webchat upload. */
  sourceUrl?: string
  /** Already-bounded bytes from webchat, absent for provider-backed attachments. */
  inlineData?: Buffer
}

export interface NormalizedMessage extends Omit<
  NormalizedPlatformMessage,
  'source' | 'platform' | 'attachments' | 'trigger'
> {
  /**
   * A displayable, ordering-safe transcript timestamp when `msgId` itself is not
   * time-based (hook deliveries use `<hookId>:<deliveryKey>`). A suffix after
   * the timestamp keeps same-millisecond deliveries distinct; consumers parse
   * only the timestamp before the separator.
   */
  transcriptTs?: string
  /** The canonical webchat post id minted beside `transcriptTs` (same origin,
   *  merged-conversation-view.md §6) — persisted on the transcript row so
   *  cross-daemon copies share an explicit identity. */
  transcriptPostId?: string
  source: 'user' | 'cron' | 'agent' | 'hook'
  // S1a open reader (integration-plugin-architecture.md §6.2): the wire reads
  // platform as an open string, so the runtime model matches. Writers still
  // produce only the legacy ids; unknown ids are handled fail-closed where the
  // value is consumed (coordsDecision, persistence narrowing), never by type.
  platform: string
  /**
   * Opaque identity of the physical platform bot/connection that received this
   * message. Platform channel ids are only unique within one bot installation
   * (Telegram DMs in particular reuse the user's numeric id across bots), so the
   * daemon uses this scope for private transcript and session lookup boundaries.
   * It is internal metadata: user-facing channel/thread coordinates stay unchanged.
   */
  transportScope?: string
  /** Ingress-derived title applied only when this message creates a logical
   *  session. A later runtime title remains authoritative and replaces it. */
  initialSessionTitle?: string
  /** Stable automation/source identity recorded as the session trigger when it
   *  differs from the message author. GitHub hook messages, for example, are
   *  authored by the event actor while still being triggered by `hook:<id>`. */
  sessionTriggerId?: string
  attachments?: Attachment[]
  /** Trusted activation cause when known. In particular, `mention` means the router
   *  matched a raw platform token against this integration's own bound bot identity. */
  trigger?: 'mention' | 'dm' | 'keyword' | 'auto' | 'cron' | 'hook'
}

/**
 * Promote the pure cross-transport message into the daemon's richer runtime
 * model. Keeping this assignment type-checked makes a shared schema change fail
 * here instead of relying on a relay payload assertion at the dispatch site.
 */
export function fromPlatformMessage(message: NormalizedPlatformMessage, transportScope?: string): NormalizedMessage {
  return {
    ...message,
    ...(transportScope !== undefined ? { transportScope } : {})
  }
}

type MessageIdentityFields = Pick<NormalizedMessage, 'msgId' | 'platform' | 'traceId' | 'transportScope'>

/** Stable daemon-local delivery identity. Platform ids are only unique within
 * one physical bot; webchat instead needs its per-turn trace id. */
export function stableMessageId(msg: MessageIdentityFields): string {
  const sourceId = msg.platform === 'webchat' ? msg.traceId : msg.msgId
  return msg.transportScope ? `${msg.transportScope}\u001f${sourceId}` : sourceId
}

/** Stable operation fence shared by evaluation and memory lifecycle events. */
export function stableTurnId(agentId: string, msg: MessageIdentityFields): string {
  return `${agentId}:${stableMessageId(msg)}`
}

/**
 * The session-thread key for a message this daemon just posted at a channel ROOT — the outbound
 * mirror of inbound thread canonicalization, and the ONE place that conversion lives. A post
 * whose key does not match what the next inbound reply resolves to opens a session that reply
 * can never reach, so this has to follow each platform's own conversation model:
 *
 * - Slack, and Feishu group chats, thread off a message: the post's own ts IS the segment.
 * - Telegram groups have no native threads, so a reply resolves to `tg:<root message id>`. The
 *   `tg:` prefix also keeps reply roots out of the numeric forum-TOPIC namespace. (A root post
 *   into a forum lands in General, whose messages carry no `is_topic_message`, so replies there
 *   resolve through the same `tg:` ladder rather than to a topic id.)
 * - Discord conversations are the CHANNEL — every inbound message there keys the channel id, so
 *   a post cannot open a thread of its own.
 * - A DM is one continuous conversation, keyed `dm` on Telegram and by the chat on Feishu. A post
 *   into one joins it; it never starts a second.
 *
 * Whether the target is a DM is not derivable from the id, so callers pass what the platform
 * reports (`isIm` from `getChannelInfo`), defaulting to a non-DM conversation.
 */
export function threadKeyForPost(platform: string, channel: string, ts: string, isDm = false): string {
  if (platform === 'discord') return channel
  if (platform === 'telegram') return isDm ? 'dm' : /^\d+$/.test(ts) ? `tg:${ts}` : ts
  if (platform === 'feishu' && isDm) return channel
  return ts
}
