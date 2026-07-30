import { z } from 'zod'

/**
 * Provider-backed attachment metadata shared by direct daemon ingress and
 * relay HTTP ingress. The relay never downloads or forwards the bytes; the
 * daemon fetches them directly from the provider using its assigned token.
 */
export const PlatformAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().optional(),
  sourceUrl: z.string()
})
export type PlatformAttachment = z.infer<typeof PlatformAttachmentSchema>

/**
 * The transport-neutral platform message produced by pure normalizers.
 *
 * This is deliberately narrower than the daemon's runtime message: daemon-only
 * transcript, session, and inline-content fields are added after ingress. It is
 * also the exact payload carried by relay `rd/msg` IM frames.
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
    appId: z.string().optional()
  }),
  text: z.string(),
  mentionedBots: z.array(z.string()),
  attachments: z.array(PlatformAttachmentSchema).optional(),
  isDm: z.boolean(),
  /** Slack `mpim`: classification only; a group DM remains mention-gated. */
  isGroupDm: z.boolean().optional(),
  replyTo: z.string().optional(),
  telegramTopicId: z.string().optional(),
  telegramThreadRoot: z.string().optional(),
  discordTopLevel: z.boolean().optional(),
  trigger: z.enum(['mention', 'dm', 'keyword', 'auto', 'cron']).optional(),
  headless: z.boolean().optional()
})
export type NormalizedPlatformMessage = z.infer<typeof NormalizedPlatformMessageSchema>
