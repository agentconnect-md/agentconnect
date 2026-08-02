import { z } from 'zod'

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
  platform: z.enum(['slack', 'telegram', 'webchat', 'discord', 'feishu']),
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
  /** Telegram forum topic id, which may be used as `message_thread_id` on send. */
  telegramTopicId: z.string().optional(),
  /** Telegram non-forum reply-thread root, continued with reply parameters. */
  telegramThreadRoot: z.string().optional(),
  /** Discord top-level guild message that the daemon should move into a thread. */
  discordTopLevel: z.boolean().optional(),
  /** Enclosing Discord channel when `channel` is itself a thread channel. */
  parentChannel: z.string().optional(),
  trigger: z.enum(['mention', 'dm', 'keyword', 'auto', 'cron']).optional(),
  headless: z.boolean().optional()
})
export type NormalizedPlatformMessage = z.infer<typeof NormalizedPlatformMessageSchema>
