import { z } from 'zod'

// File transfer through the Source Cache bucket (source-cache-file-transfer.md): presigned URLs only, bytes never on a WS.

/** Daemon presigns transfer URLs: it has a Source Cache, so `transfer/upload` and `workspace/transfer` answer. */
export const FILE_TRANSFER_FEATURE = 'file-transfer-v1'

/** At most this many uploaded files ride one webchat turn. */
export const WEBCHAT_FILES_MAX = 4

/** The console downloads text at or under this size through the CP's slice proxy; larger text and any binary use a transfer. */
export const WORKSPACE_TRANSFER_TEXT_THRESHOLD_BYTES = 1024 * 1024

/** Base64 of a 32-byte SHA-256, the form S3's `x-amz-checksum-sha256` takes. */
export const TransferSha256 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, { message: 'must be a base64 SHA-256' })

export const TransferFileName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\u0000-\u001f\u007f/\\]+$/, 'file name must not contain control characters or path separators')

export const TransferMimeType = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/, 'must be a type/subtype MIME type')

/** C→D REQ: reserve an upload slot for one file the console is about to send to `agentId`. */
export const TransferUploadReq = z.object({
  agentId: z.string().min(1),
  name: TransferFileName,
  mimeType: TransferMimeType,
  size: z.number().int().positive(),
  sha256: TransferSha256
})
export type TransferUploadReq = z.infer<typeof TransferUploadReq>

/** D→C REP: a presigned PUT the browser sends the bytes to, with exactly these headers. */
export const TransferUploadGrant = z.object({
  uploadId: z.string().uuid(),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.number().int()
})
export type TransferUploadGrant = z.infer<typeof TransferUploadGrant>

/** C→D REQ: make one workspace file downloadable from the bucket, uploading it there first when absent. */
export const WorkspaceTransferReq = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  path: z.string().min(1).max(4096)
})
export type WorkspaceTransferReq = z.infer<typeof WorkspaceTransferReq>

/** D→C REP: a presigned GET that downloads the file as an attachment. */
export const WorkspaceTransferGrant = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string().url(),
  expiresAt: z.number().int(),
  /** True when the bucket already held this revision and nothing was uploaded. */
  cached: z.boolean()
})
export type WorkspaceTransferGrant = z.infer<typeof WorkspaceTransferGrant>

/** A file the browser uploaded through a `TransferUploadGrant`; metadata only, the bytes are in the bucket. */
export const WebchatFileAttachment = z.object({
  uploadId: z.string().uuid(),
  name: TransferFileName,
  mimeType: TransferMimeType,
  size: z.number().int().positive(),
  sha256: TransferSha256
})
export type WebchatFileAttachment = z.infer<typeof WebchatFileAttachment>
