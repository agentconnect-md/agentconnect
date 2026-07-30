import type { PlatformAttachment } from '@agentconnect.md/protocol'

type AttachmentSummary = Pick<PlatformAttachment, 'name' | 'mimeType'>

/** One-line human summary used when a platform reply quotes attached media. */
export function attachmentMention(attachments: readonly AttachmentSummary[] | undefined): string {
  if (!attachments?.length) return ''
  const list = attachments.map((attachment) => `${attachment.name} (${attachment.mimeType})`).join(', ')
  return `[attached: ${list}]`
}
