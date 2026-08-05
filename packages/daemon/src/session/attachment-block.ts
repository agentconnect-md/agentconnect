import type { ContentBlock } from '@agentclientprotocol/sdk'
import {
  SessionImageAttachment as SessionImageAttachmentSchema,
  WEBCHAT_IMAGE_MAX_BYTES,
  type SessionImageAttachment
} from '@agentconnect.md/protocol'
import type { Attachment } from '../messages/normalized.js'

export { attachmentMention } from '@agentconnect.md/message'

/** Capability + byte-fetch surface the block builder needs (satisfied by the
 *  AcpHost + the owning SlackConnection at dispatch time). */
export interface AttachmentDeps {
  /** Download the attachment bytes daemon-locally; null on failure. */
  download: (att: Attachment) => Promise<Buffer | null>
  /** Whether the agent advertised a gated prompt content-block kind at initialize. */
  supports: (kind: 'image' | 'audio' | 'embeddedContext') => boolean
  /** Inline cap (bytes); files whose known size exceeds it are never downloaded —
   *  they degrade to a resource_link pointer. Bounds RSS + the ACP prompt frame. */
  maxBytes?: number
}

/**
 * Turn one Slack attachment into the richest ACP content block the agent can
 * accept (§9.2):
 *  - image/* + promptCapabilities.image  → an inline `image` block (base64).
 *  - downloaded + promptCapabilities.embeddedContext → an embedded `resource`
 *    (text bytes for text/*, else a base64 blob).
 *  - otherwise → a baseline `resource_link` pointer (always supported), which is
 *    also the fallback when the download failed or the agent opted out.
 */
export function attachmentToBlock(
  att: Attachment,
  bytes: Buffer | null,
  supports: AttachmentDeps['supports']
): ContentBlock {
  const isImage = att.mimeType.startsWith('image/')
  if (bytes && isImage && supports('image')) {
    // Keep downloaded images self-contained. Some ACP adapters prefer `uri`
    // over `data`, breaking auth-gated URLs despite having bytes. Remove via #52.
    return { type: 'image', data: bytes.toString('base64'), mimeType: att.mimeType }
  }
  if (bytes && supports('embeddedContext')) {
    const uri = att.sourceUrl ?? `attachment://webchat/${encodeURIComponent(att.id)}`
    if (att.mimeType.startsWith('text/')) {
      return {
        type: 'resource',
        resource: { text: bytes.toString('utf8'), uri, mimeType: att.mimeType }
      }
    }
    return {
      type: 'resource',
      resource: { blob: bytes.toString('base64'), uri, mimeType: att.mimeType }
    }
  }
  if (!att.sourceUrl) {
    return {
      type: 'text',
      text: `[attached image: ${att.name} (${att.mimeType}); image input is unavailable for this agent]`
    }
  }
  // Baseline: a pointer the agent can't fetch directly (the URL is auth-gated) —
  // point it at the readSlackFile tool, which downloads via the bot token.
  return {
    type: 'resource_link',
    name: att.name,
    uri: att.sourceUrl,
    mimeType: att.mimeType,
    description: `Slack file. You cannot fetch this URL directly — call the readSlackFile tool with this uri (mimeType: ${att.mimeType}) to view its contents.`,
    ...(typeof att.size === 'number' ? { size: att.size } : {})
  }
}

/** Download + convert every attachment, skipping nothing (failed/over-cap
 *  downloads degrade to resource_link rather than being dropped). A file whose
 *  declared size already exceeds maxBytes is never fetched. */
export async function buildAttachmentBlocks(attachments: Attachment[], deps: AttachmentDeps): Promise<ContentBlock[]> {
  const cap = deps.maxBytes ?? Infinity
  return Promise.all(
    attachments.map(async (att) => {
      const overCap = typeof att.size === 'number' && att.size > cap
      const bytes = overCap ? null : (att.inlineData ?? (await deps.download(att).catch(() => null)))
      return attachmentToBlock(att, bytes, deps.supports)
    })
  )
}

/**
 * Fetch the bytes of the first inline-able image so its transcript row can carry
 * it for console replay. Webchat images arrive inline already; a platform
 * attachment (Slack/Telegram/Discord/Feishu) is only an auth-gated URL, so
 * without this the console can render nothing but the `[attached: …]` label.
 * The bytes are memoized onto the attachment, so `buildAttachmentBlocks` reuses
 * them and the turn still downloads the file exactly once.
 *
 * ponytail: one image, capped at the daemon→CP history-frame ceiling
 * (WEBCHAT_IMAGE_MAX_BYTES). A bigger image (or a second one) keeps the label;
 * showing those needs chunked/off-frame image reads, not a bigger cap.
 */
export async function hydrateTranscriptImage(
  attachments: Attachment[] | undefined,
  download: (att: Attachment) => Promise<Buffer | null>
): Promise<void> {
  const image = attachments?.find((att) => att.mimeType.startsWith('image/'))
  if (!image || image.inlineData) return
  if (typeof image.size === 'number' && image.size > WEBCHAT_IMAGE_MAX_BYTES) return
  const bytes = await download(image).catch(() => null)
  if (bytes && bytes.byteLength <= WEBCHAT_IMAGE_MAX_BYTES) image.inlineData = bytes
}

/** Keep a validated bounded inline image beside its daemon-local transcript row. */
export function transcriptImageAttachments(attachments: Attachment[] | undefined): SessionImageAttachment[] {
  return (attachments ?? [])
    .flatMap((attachment) => {
      if (!attachment.inlineData) return []
      const parsed = SessionImageAttachmentSchema.safeParse({
        name: attachment.name,
        mimeType: attachment.mimeType,
        data: attachment.inlineData.toString('base64')
      })
      return parsed.success ? [parsed.data] : []
    })
    .slice(0, 1)
}
