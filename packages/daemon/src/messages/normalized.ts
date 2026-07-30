import type { NormalizedPlatformMessage, PlatformAttachment } from '@agentconnect.md/message'

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
  source: 'user' | 'cron' | 'agent' | 'hook'
  platform: 'slack' | 'telegram' | 'webchat' | 'discord' | 'feishu' | 'hook'
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
