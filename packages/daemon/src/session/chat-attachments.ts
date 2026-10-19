import { z } from 'zod'
import {
  SessionImageAttachment,
  TransferFileName,
  TransferGetReq,
  TransferMimeType,
  TransferSha256,
  WEBCHAT_FILES_MAX,
  type TransferGetOk,
  type TransferNetwork
} from '@agentconnect.md/protocol'
import type { Attachment } from '../messages/normalized.js'

// Share the existing file-transfer field constraints; neither a URL nor a workspace path is accepted.
export const ChatUploadReference = z
  .object({
    uploadId: z.string().uuid(),
    name: TransferFileName,
    mimeType: TransferMimeType,
    size: z.number().int().positive(),
    sha256: TransferSha256
  })
  .strict()
export type ChatUploadReference = z.infer<typeof ChatUploadReference>

export const ChatAttachmentsInput = z
  .object({
    images: z.array(SessionImageAttachment).max(1).optional(),
    files: z.array(ChatUploadReference).max(WEBCHAT_FILES_MAX).optional()
  })
  .strict()

// Normalize validated references only; signed URLs are resolved at execution and never enter durable ingress.
export function decodeChatAttachments(turnId: string, input: unknown): Attachment[] {
  const parsed = ChatAttachmentsInput.parse(input)
  return [
    ...(parsed.images ?? []).map((image, index): Attachment => {
      const inlineData = Buffer.from(image.data, 'base64')
      return {
        id: `webchat:${turnId}:${index}`,
        name: image.name,
        mimeType: image.mimeType,
        size: inlineData.byteLength,
        inlineData
      }
    }),
    ...(parsed.files ?? []).map((file): Attachment => ({
      id: `webchat:${turnId}:file:${file.uploadId}`,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      transfer: { uploadId: file.uploadId, sha256: file.sha256 }
    }))
  ]
}

export interface ChatUploadAuthority {
  // Both are daemon-owned values, never fields supplied by a client extension.
  agentId: string
  network: TransferNetwork
  // This callback supplies the owning organization to the existing CP RPC.
  transferGet?: (request: TransferGetReq) => Promise<TransferGetOk>
}

// CP checks agent placement, derives the org/agent object key, and verifies the uploaded size and checksum.
export async function resolveChatUploadUrl(
  attachment: Attachment,
  authority: ChatUploadAuthority
): Promise<{ url: string; expiresAt: number } | undefined> {
  if (!authority.transferGet || !attachment.transfer || attachment.size === undefined) return undefined
  const request = TransferGetReq.parse({
    agentId: authority.agentId,
    size: attachment.size,
    uploadId: attachment.transfer.uploadId,
    sha256: attachment.transfer.sha256,
    network: authority.network
  })
  const got = await authority.transferGet(request)
  return got.url && got.expiresAt !== undefined ? { url: got.url, expiresAt: got.expiresAt } : undefined
}
