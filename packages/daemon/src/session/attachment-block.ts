import type { ContentBlock } from '@agentclientprotocol/sdk/unstable'
import {
  SessionImageAttachment as SessionImageAttachmentSchema,
  type SessionImageAttachment,
  type UploadedFileReference,
  TRANSCRIPT_IMAGE_MAX_COUNT,
  WEBCHAT_IMAGE_MAX_BYTES
} from '@agentconnect.md/protocol'
import type { Attachment } from '../messages/normalized.js'
import { prepareSharedImagePreview } from '../images/index.js'

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
  /** A presigned GET for a console upload in the Source Cache bucket; undefined when it is gone or unverifiable. */
  transferUrl?: (att: Attachment) => Promise<{ url: string; expiresAt: number } | undefined>
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
  if (isImage && att.unavailableText) return { type: 'text', text: att.unavailableText }
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
    description: att.readerToolName
      ? `You cannot fetch this provider URL directly — call the ${att.readerToolName} tool with this uri (mimeType: ${att.mimeType}) to access it; a non-image binary is saved into uploads/ in your workspace.`
      : `Slack file. You cannot fetch this URL directly — call the readSlackFile tool with this uri (mimeType: ${att.mimeType}) to view its contents (a non-image binary is saved into uploads/ in your workspace).`,
    ...(typeof att.size === 'number' ? { size: att.size } : {})
  }
}

/** Download + convert every attachment, skipping nothing (failed/over-cap
 *  downloads degrade to resource_link rather than being dropped). A file whose
 *  declared size already exceeds maxBytes is never fetched. */
export async function buildAttachmentBlocks(attachments: Attachment[], deps: AttachmentDeps): Promise<ContentBlock[]> {
  const cap = deps.maxBytes ?? Infinity
  const blocks = await Promise.all(
    attachments.map(async (att) => {
      if (att.transfer) {
        const link = transferBlock(att, await deps.transferUrl?.(att).catch(() => undefined))
        const preview = att.transcriptThumbnail
        return preview && deps.supports('image')
          ? [link, { type: 'image' as const, data: preview.data.toString('base64'), mimeType: preview.mimeType }]
          : [link]
      }
      const overCap = typeof att.size === 'number' && att.size > cap
      const readThroughTool = !att.mimeType.startsWith('image/') && att.readerToolName
      const bytes = overCap || readThroughTool ? null : (att.inlineData ?? (await deps.download(att).catch(() => null)))
      return [attachmentToBlock(att, bytes, deps.supports)]
    })
  )
  const identifiers = attachments
    .filter((att) => att.sourceUrl && !att.transfer)
    .map((att) => `Attached file: ${att.name}; fileId=${att.id}`)
  return [...blocks.flat(), ...(identifiers.length ? [{ type: 'text' as const, text: identifiers.join('\n') }] : [])]
}

// Keep native upload identifiers and integrity metadata with the receiving message.
export function transcriptUploads(attachments: Attachment[] | undefined): UploadedFileReference[] {
  return (attachments ?? []).flatMap((file) =>
    file.transfer && file.size !== undefined
      ? [{ ...file.transfer, name: file.name, mimeType: file.mimeType, size: file.size }]
      : []
  )
}

/** POSIX single-quote a value for the sample command; a sanitized upload name may still hold a quote. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** A console upload reaches the agent as a download link it fetches into its own workspace. */
export function transferBlock(att: Attachment, link: { url: string; expiresAt: number } | undefined): ContentBlock {
  const label = `${att.name} (${att.mimeType}${typeof att.size === 'number' ? `, ${att.size} bytes` : ''})`
  if (!link) return { type: 'text', text: `[uploaded file: ${label} — the upload is no longer available]` }
  return {
    type: 'text',
    text: [
      `[uploaded file: ${label}; uploadId=${att.transfer?.uploadId}]`,
      `The user uploaded this file. It is not in your workspace yet; download it when you need it, for example:`,
      `mkdir -p uploads && curl -fsSL -o ${shellQuote(`uploads/${att.name}`)} ${shellQuote(link.url)}`,
      `The link expires at ${new Date(link.expiresAt).toISOString()}; do not repeat it in replies.`
    ].join('\n')
  }
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

/** An inbound attachment that may be an image: a declared `image/*`, or an untyped Feishu image event. */
function imageCandidate(att: Attachment): boolean {
  return !att.transfer && (att.mimeType.startsWith('image/') || att.mimeType === 'application/octet-stream')
}

/** Re-encodes image bytes to at most `maxBytes` for console replay; null when it cannot. */
export type TranscriptImageFit = (
  bytes: Buffer,
  name: string,
  maxBytes: number
) => Promise<{ data: Buffer; mimeType: SessionImageAttachment['mimeType'] } | null>

/** Shrink an image through the bounded shared-image preview pool, keeping only a format the transcript accepts. */
export const fitTranscriptImage: TranscriptImageFit = async (bytes, name, maxBytes) => {
  const prepared = await prepareSharedImagePreview({ bytes, name, maxPreviewBytes: maxBytes })
  if (!prepared.ok || prepared.preview.data.byteLength > maxBytes) return null
  const { mimeType, data } = prepared.preview
  return mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp' ? { data, mimeType } : null
}

/** Whether an image already has a transcript rendition within `share` bytes. */
function fitsShare(image: Attachment, share: number): boolean {
  if (image.transcriptThumbnail && image.transcriptThumbnail.data.byteLength <= share) return true
  return !!image.inlineData && image.inlineData.byteLength <= share && !!sniffImageMimeType(image.inlineData)
}

// Reuse full-resolution prompt bytes; for console replay use the platform thumbnail, else re-encode, where they exceed an equal share of the row budget.
export async function hydrateTranscriptImages(
  attachments: Attachment[] | undefined,
  deps: Pick<AttachmentDeps, 'download' | 'maxBytes'> & { fit?: TranscriptImageFit }
): Promise<void> {
  const images = (attachments ?? []).filter(imageCandidate).slice(0, TRANSCRIPT_IMAGE_MAX_COUNT)
  if (!images.length) return
  const cap = deps.maxBytes ?? Infinity
  // Each image is guaranteed at least this much when the row's budget is shared (see transcriptImageAttachments).
  const share = Math.floor(WEBCHAT_IMAGE_MAX_BYTES / images.length)
  await Promise.all(
    images.map(async (image) => {
      if (!image.inlineData && !(typeof image.size === 'number' && image.size > cap)) {
        const bytes = await deps.download(image).catch(() => null)
        if (bytes && bytes.byteLength <= cap) {
          image.inlineData = bytes
          const sniffed = sniffImageMimeType(bytes)
          if (sniffed) image.mimeType = sniffed
        }
      }
      if (image.thumbnailUrl && (!image.inlineData || image.inlineData.byteLength > share)) {
        const thumbBytes = await deps.download({ ...image, sourceUrl: image.thumbnailUrl }).catch(() => null)
        const sniffed = thumbBytes ? sniffImageMimeType(thumbBytes) : undefined
        if (thumbBytes && sniffed && thumbBytes.byteLength <= WEBCHAT_IMAGE_MAX_BYTES) {
          image.transcriptThumbnail = { data: thumbBytes, mimeType: sniffed }
        }
      }
      // A Slack PNG thumbnail can still be ~150 KB, so several images only all fit once re-encoded.
      if (!deps.fit || fitsShare(image, share)) return
      const source = image.inlineData ?? image.transcriptThumbnail?.data
      if (!source) return
      const fitted = await deps.fit(source, image.name, share).catch(() => null)
      if (fitted && fitted.data.byteLength <= share) image.transcriptThumbnail = fitted
    })
  )
}

/** The renditions a transcript row may keep of one attachment, a fetched thumbnail first since it exists only because the full bytes did not fit. */
function transcriptRenditions(attachment: Attachment): { bytes: number; image: SessionImageAttachment }[] {
  const candidates = [
    ...(attachment.transcriptThumbnail ? [attachment.transcriptThumbnail] : []),
    ...(attachment.inlineData ? [{ mimeType: attachment.mimeType, data: attachment.inlineData }] : [])
  ]
  return candidates.flatMap(({ mimeType, data }) => {
    if (data.byteLength > WEBCHAT_IMAGE_MAX_BYTES) return []
    const parsed = SessionImageAttachmentSchema.safeParse({
      name: attachment.name,
      mimeType,
      data: data.toString('base64')
    })
    return parsed.success ? [{ bytes: data.byteLength, image: parsed.data }] : []
  })
}

/** Keep up to TRANSCRIPT_IMAGE_MAX_COUNT bounded images beside the daemon-local row, sharing one image's byte budget; one that fits nowhere stays a marker label. */
export function transcriptImageAttachments(attachments: Attachment[] | undefined): SessionImageAttachment[] {
  const renditions = (attachments ?? []).map(transcriptRenditions).filter((options) => options.length > 0)
  const kept: SessionImageAttachment[] = []
  let remaining = WEBCHAT_IMAGE_MAX_BYTES
  for (const [index, options] of renditions.entries()) {
    const left = Math.min(TRANSCRIPT_IMAGE_MAX_COUNT - kept.length, renditions.length - index)
    if (left <= 0) break
    // An unused share rolls forward, so no image ever gets less than an equal split of the whole budget.
    const allowance = Math.floor(remaining / left)
    const pick = options.find((option) => option.bytes <= allowance)
    if (!pick) continue
    kept.push(pick.image)
    remaining -= pick.bytes
  }
  return kept
}
