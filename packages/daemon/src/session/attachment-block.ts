import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { Attachment } from '../messages/normalized.js'

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
    return { type: 'image', data: bytes.toString('base64'), mimeType: att.mimeType, uri: att.sourceUrl }
  }
  if (bytes && supports('embeddedContext')) {
    if (att.mimeType.startsWith('text/')) {
      return {
        type: 'resource',
        resource: { text: bytes.toString('utf8'), uri: att.sourceUrl, mimeType: att.mimeType }
      }
    }
    return {
      type: 'resource',
      resource: { blob: bytes.toString('base64'), uri: att.sourceUrl, mimeType: att.mimeType }
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
      const bytes = overCap ? null : await deps.download(att).catch(() => null)
      return attachmentToBlock(att, bytes, deps.supports)
    })
  )
}

/** One-line human summary of attachments for the transcript text (so §8.5
 *  catch-up replay at least notes a file was shared, since bytes aren't stored). */
export function attachmentMention(attachments: Attachment[] | undefined): string {
  if (!attachments?.length) return ''
  const list = attachments.map((a) => `${a.name} (${a.mimeType})`).join(', ')
  return `[attached: ${list}]`
}
