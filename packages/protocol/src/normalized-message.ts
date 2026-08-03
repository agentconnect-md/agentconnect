import { z } from 'zod'
import { Platform } from './frames/route.js'

/**
 * Provider-backed attachment metadata shared by direct daemon ingress and relay
 * HTTP ingress. The relay never downloads or forwards the bytes; the daemon
 * fetches them directly from the provider using its assigned token.
 */
export const PlatformAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().optional(),
  sourceUrl: z.string()
})
export type PlatformAttachment = z.infer<typeof PlatformAttachmentSchema>

export const QuotedMessageSchema = z.object({
  messageId: z.string().optional(),
  sender: z.string().optional(),
  text: z.string(),
  selection: z.boolean().optional(),
  excerpt: z.boolean().optional()
})
export type QuotedMessage = z.infer<typeof QuotedMessageSchema>

/**
 * The transport-neutral platform message contract used by pure normalizers.
 *
 * This is deliberately narrower than the daemon's runtime message: daemon-only
 * transcript, session, and inline-content fields are added after ingress. It is
 * the exact payload carried by relay `rd/msg` IM frames.
 */
export const NormalizedPlatformMessageSchema = z.object({
  msgId: z.string(),
  traceId: z.string(),
  source: z.enum(['user', 'cron', 'agent']),
  // S1a open reader (frames/route.ts Platform policy): writers emit only known
  // ids; an unknown id decodes and is handled fail-closed downstream.
  platform: Platform,
  channel: z.string(),
  thread: z.string().optional(),
  sender: z.object({
    id: z.string(),
    isBot: z.boolean(),
    appId: z.string().optional(),
    /** Public provider-hosted profile image. Auth-gated file URLs must not be exposed here. */
    avatarUrl: z.string().url().optional()
  }),
  text: z.string(),
  mentionedBots: z.array(z.string()),
  attachments: z.array(PlatformAttachmentSchema).optional(),
  isDm: z.boolean(),
  /** Slack `mpim`: classification only; a group DM remains mention-gated. */
  isGroupDm: z.boolean().optional(),
  /** Provider id of the message this one replies to. */
  replyTo: z.string().optional(),
  /** Provider-supplied quoted reply content, already bounded and humanized. */
  quoted: QuotedMessageSchema.optional(),
  // ── §6.5 generic thread coordinates (integration-plugin-architecture.md) ──
  // The platform-agnostic model core session-keying consumes. Dual-shape window:
  // normalizers emit these ALONGSIDE the named per-platform fields below and
  // readers prefer them; the named fields stop being emitted once the fleet
  // reads the generic ones. (`thread` above stays the CANONICAL post-ingress
  // coordinate these feed; the design's `threadId` is named `threadRoot` here
  // because `thread` already occupies that slot.)
  /** Platform topic/forum container the message lives in (Telegram forum topic id). */
  topicId: z.string().optional(),
  /** Platform reply-chain root when threads are reply-derived rather than native. */
  threadRoot: z.string().optional(),
  /** Top-level post the daemon should promote into a real thread before dispatch. */
  promoteToThread: z.boolean().optional(),
  /** Opaque per-adapter extension bag, namespaced by platformId
   *  (`adapterExt.telegram`, …). Never read by core; round-tripped back to the
   *  platform adapter at render time (S2 renderer seam). */
  adapterExt: z.record(z.string(), z.unknown()).optional(),
  /** DEPRECATED (§6.5): read `topicId`. Telegram forum topic id, may be used as `message_thread_id` on send. */
  telegramTopicId: z.string().optional(),
  /** DEPRECATED (§6.5): read `threadRoot`. Telegram non-forum reply-thread root. */
  telegramThreadRoot: z.string().optional(),
  /** DEPRECATED (§6.5): read `promoteToThread`. Discord top-level guild message to move into a thread. */
  discordTopLevel: z.boolean().optional(),
  /** Enclosing container channel when `channel` is itself a thread channel (Discord
   *  threads). GENERIC and core-read (bind-rule admission spans thread→parent), so it
   *  is part of the coordinate model, not adapterExt (D2: pre-dispatch core read). */
  parentChannel: z.string().optional(),
  trigger: z.enum(['mention', 'dm', 'keyword', 'auto', 'cron']).optional(),
  /** Provider-reported send time (epoch ms). Set when the platform's message id
   *  is not itself chronological (Telegram sequence ids, Feishu om_ ids) or the
   *  time is embedded in it (Discord snowflakes, decoded at normalization).
   *  The daemon stamps it onto the transcript row's normalized event-time axis
   *  so cross-source merges order correctly (merged-conversation-view.md §6). */
  platformTimeMs: z.number().int().positive().optional(),
  headless: z.boolean().optional()
})
export type NormalizedPlatformMessage = z.infer<typeof NormalizedPlatformMessageSchema>
