import type { Attachment, NormalizedMessage } from '../messages/normalized.js'
import { sniffImageMimeType } from '../session/attachment-block.js'
import { DecisionProviderError } from './provider.js'

export const DECISION_IMAGE_MAX_COUNT = 8
export const DECISION_IMAGE_MAX_BYTES = 4 * 1024 * 1024
export const DECISION_IMAGES_MAX_BYTES = 8 * 1024 * 1024

export interface DecisionImageInput {
  attachments: readonly Attachment[]
  integrationId?: string
  messageId: string
}
export interface DecisionImage {
  name: string
  mimeType: string
  data: string
  bytes: number
}
export type DecisionImageDownload = (
  agentId: string,
  integrationId: string | undefined,
  attachment: Attachment,
  maxBytes: number,
  signal: AbortSignal
) => Promise<Buffer | null>

function candidate(attachment: Attachment): boolean {
  return attachment.mimeType.startsWith('image/') || attachment.mimeType === 'application/octet-stream'
}

// Keep image bytes and provider read coordinates on the daemon, outside the frozen text state and control frames.
export function decisionImageInput(
  msg: NormalizedMessage,
  integrationId?: string
): { imageInput?: DecisionImageInput } {
  const attachments = msg.attachments?.filter(candidate)
  return attachments?.length ? { imageInput: { attachments, integrationId, messageId: msg.msgId } } : {}
}

function inlineBytes(raw: unknown): Buffer | undefined {
  if (Buffer.isBuffer(raw)) return raw
  // A durable gate/router delivery restores Buffer.toJSON() rather than a live Buffer.
  if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'Buffer' && 'data' in raw) {
    const data = raw.data
    if (
      Array.isArray(data) &&
      data.length <= DECISION_IMAGE_MAX_BYTES &&
      data.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
    )
      return Buffer.from(data)
  }
  if (raw !== undefined) throw new DecisionProviderError('unsupported_input')
  return undefined
}

async function downloadBeforeAbort(start: () => Promise<Buffer | null>, signal: AbortSignal): Promise<Buffer | null> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return start()
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

// A failed image remains unavailable; a caption is never silently substituted for its pixels.
export async function resolveDecisionImages(
  agentId: string,
  input: DecisionImageInput,
  signal: AbortSignal,
  download?: DecisionImageDownload
): Promise<DecisionImage[]> {
  const attachments = input.attachments.filter(candidate)
  if (attachments.length > DECISION_IMAGE_MAX_COUNT) throw new DecisionProviderError('unsupported_input')
  const images: DecisionImage[] = []
  let total = 0
  for (const attachment of attachments) {
    signal.throwIfAborted()
    const maxBytes = Math.min(DECISION_IMAGE_MAX_BYTES, DECISION_IMAGES_MAX_BYTES - total)
    if (maxBytes <= 0 || (attachment.size !== undefined && attachment.size > maxBytes))
      throw new DecisionProviderError('unsupported_input')
    let bytes = inlineBytes(attachment.inlineData)
    if (!bytes && attachment.sourceUrl && download) {
      bytes =
        (await downloadBeforeAbort(
          () => download(agentId, input.integrationId, attachment, maxBytes, signal),
          signal
        )) ?? undefined
    }
    signal.throwIfAborted()
    if (!bytes || bytes.length === 0 || bytes.length > maxBytes) throw new DecisionProviderError('unsupported_input')
    const signature = bytes.subarray(0, 6).toString('ascii')
    const mimeType =
      sniffImageMimeType(bytes) ?? (signature === 'GIF87a' || signature === 'GIF89a' ? 'image/gif' : undefined)
    if (!mimeType) {
      if (attachment.mimeType === 'application/octet-stream') continue
      throw new DecisionProviderError('unsupported_input')
    }
    if (attachment.name.length > 1024) throw new DecisionProviderError('unsupported_input')
    attachment.inlineData = bytes
    attachment.mimeType = mimeType
    total += bytes.length
    images.push({ name: attachment.name, mimeType, data: bytes.toString('base64'), bytes: bytes.length })
  }
  return images
}

export function decisionImageParts(
  images: readonly DecisionImage[],
  messageId: string,
  redact = false
): Record<string, unknown>[] {
  return images.flatMap((image) => [
    {
      type: 'input_text',
      text: JSON.stringify({
        currentMessageImage: { messageId, name: image.name, mimeType: image.mimeType, bytes: image.bytes }
      })
    },
    {
      type: 'input_image',
      image_url: redact ? '[image bytes omitted]' : `data:${image.mimeType};base64,${image.data}`,
      detail: 'auto'
    }
  ])
}
