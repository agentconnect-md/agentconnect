import type { NormalizedPlatformMessage, PlatformAttachment, SessionImageAttachment } from '@agentconnect.md/protocol'

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
  /** Bytes fetched from `thumbnailUrl` for transcript preview only, set when the
   *  full download (`inlineData`) doesn't fit the console history budget. Kept
   *  apart from `inlineData` so the ACP prompt block never receives it. */
  transcriptThumbnail?: { data: Buffer; mimeType: SessionImageAttachment['mimeType'] }
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
  source: 'user' | 'cron' | 'agent' | 'hook' | 'system'
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
  /**
   * This delivery is a child session's REPORT into its parent (`sendMessage
   * {sessionId}` — replyToSession's local branch, the relay's lineage-reply
   * branch, and the #800 inferred reply). Set only by the daemon at those
   * construction sites, never from ingress. A report resumes the parent
   * SESSION-ONLY (#966): it is injected into the parent's transcript and
   * turn, but is never committed as a live conversation post — the #926
   * agent-wake inbound rendering skips it, so a webchat conversation's roster
   * does not see private night/task reports as room posts.
   */
  parentReport?: boolean
  /**
   * This delivery CONTINUES a session the control plane authorized, synthesized on that
   * session's own stored coordinates (webchat-cross-integration-continuation.md §9). Set only
   * by the daemon's continuation construction site, never from ingress. The source gate reads
   * it as "not a new audience": a hook session's audience cannot be re-derived without the
   * webhook delivery's trusted metadata, so the row keeps the binding it already carries.
   */
  adoptedSession?: boolean
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

/** The outbound thread-key strategy moved to `platforms/thread-keys.ts` (§7.4) —
 * one registered arm per platform, beside the inbound canonicalization it must
 * agree with. */
