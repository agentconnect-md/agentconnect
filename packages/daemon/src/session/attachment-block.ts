import type { ContentBlock } from '@agentclientprotocol/sdk'
import {
  SessionImageAttachment as SessionImageAttachmentSchema,
  type SessionImageAttachment,
  WEBCHAT_IMAGE_MAX_BYTES
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

/** The transcript-renderable formats, identified from their magic bytes. A declared
 *  MIME type is not enough to decide: Feishu's `im.message.receive_v1` image event
 *  carries only an `image_key`, so normalization types it `application/octet-stream`
 *  (feishu-message.ts). Sniffing also corrects a provider that declares the wrong
 *  format — the console renders these bytes directly, so the label has to be true. */
export function sniffImageMimeType(bytes: Buffer): SessionImageAttachment['mimeType'] | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const riff = bytes.subarray(0, 12)
  if (
    riff.length === 12 &&
    riff.subarray(0, 4).toString('latin1') === 'RIFF' &&
    riff.subarray(8).toString('latin1') === 'WEBP'
  )
    return 'image/webp'
  return undefined
}

/**
 * Fetch the bytes of the first candidate image so its transcript row can carry it
 * for console replay. Webchat images arrive inline already; a platform attachment
 * (Slack/Telegram/Discord/Feishu) is only an auth-gated URL, so without this the
 * console can render nothing but the `[attached: …]` label. A provider that
 * declares no usable type is settled by the bytes, and the corrected `mimeType`
 * rides along so the mention, the transcript row and the ACP block all agree.
 *
 * The bytes are memoized onto the attachment, so `buildAttachmentBlocks` reuses
 * them: one download serves the transcript and the prompt. `maxBytes` is the
 * caller's prompt cap, mirroring `buildAttachmentBlocks`, so an over-cap file is
 * skipped identically here; the tighter transcript ceiling is enforced by the
 * `SessionImageAttachment` schema in `transcriptImageAttachments`.
 *
 * The console history frame's budget (`WEBCHAT_IMAGE_MAX_BYTES`) is far tighter
 * than `maxBytes` above, so a full-res download routinely clears the prompt cap
 * but not the transcript one. When that happens — or the full download was
 * never attempted because the declared size already exceeded `maxBytes` — a
 * provider-supplied smaller rendition (`thumbnailUrl`: Slack `thumb_*`, a
 * smaller Telegram `PhotoSize`, a resized Discord `proxy_url`) is fetched
 * separately and kept in `transcriptThumbnail`, never in `inlineData`, so the
 * agent's own prompt block always sees the full-resolution bytes.
 *
 * ponytail: one image per message. A second one keeps the label; showing more
 * needs chunked/off-frame image reads, not a bigger cap.
 */
export async function hydrateTranscriptImage(
  attachments: Attachment[] | undefined,
  deps: Pick<AttachmentDeps, 'download' | 'maxBytes'>
): Promise<void> {
  const image = attachments?.find(
    (att) => att.mimeType.startsWith('image/') || att.mimeType === 'application/octet-stream'
  )
  if (!image || image.inlineData) return
  const cap = deps.maxBytes ?? Infinity
  if (!(typeof image.size === 'number' && image.size > cap)) {
    const bytes = await deps.download(image).catch(() => null)
    if (bytes && bytes.byteLength <= cap) {
      image.inlineData = bytes
      const sniffed = sniffImageMimeType(bytes)
      if (sniffed) image.mimeType = sniffed
    }
  }
  if (image.thumbnailUrl && (!image.inlineData || image.inlineData.byteLength > WEBCHAT_IMAGE_MAX_BYTES)) {
    const thumbBytes = await deps.download({ ...image, sourceUrl: image.thumbnailUrl }).catch(() => null)
    const sniffed = thumbBytes ? sniffImageMimeType(thumbBytes) : undefined
    if (thumbBytes && sniffed && thumbBytes.byteLength <= WEBCHAT_IMAGE_MAX_BYTES) {
      image.transcriptThumbnail = { data: thumbBytes, mimeType: sniffed }
    }
  }
}

/** Keep a validated bounded inline image beside its daemon-local transcript row.
 *  Prefers a fetched `transcriptThumbnail` over the full-res `inlineData` — the
 *  former exists only because the latter didn't fit the transcript's budget. */
export function transcriptImageAttachments(attachments: Attachment[] | undefined): SessionImageAttachment[] {
  return (attachments ?? [])
    .flatMap((attachment) => {
      const image = attachment.transcriptThumbnail
        ? { mimeType: attachment.transcriptThumbnail.mimeType, data: attachment.transcriptThumbnail.data }
        : attachment.inlineData
          ? { mimeType: attachment.mimeType, data: attachment.inlineData }
          : undefined
      if (!image) return []
      const parsed = SessionImageAttachmentSchema.safeParse({
        name: attachment.name,
        mimeType: image.mimeType,
        data: image.data.toString('base64')
      })
      return parsed.success ? [parsed.data] : []
    })
    .slice(0, 1)
}
