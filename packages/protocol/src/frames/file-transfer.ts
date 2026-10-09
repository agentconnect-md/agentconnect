import { z } from 'zod'

// File transfer through the deployment's bucket (source-cache-file-transfer.md): the CP signs, bytes never ride a WS.

/** Daemon moves bytes on CP-signed URLs: it answers `workspace/upload` and asks `transfer/sign` and `transfer/get`. */
export const FILE_TRANSFER_FEATURE = 'file-transfer-v2'

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

/** C→D REQ: snapshot one workspace file and PUT it to the URL `transfer/sign` returns for this `ticket`. */
export const WorkspaceUploadReq = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  path: z.string().min(1).max(4096),
  /** The size and mtime the CP keyed the object by; a file that no longer matches is refused as `stale`. */
  revision: z.object({ size: z.number().int().positive(), mtime: z.string().min(1).max(64) }),
  maxBytes: z.number().int().positive(),
  /** Names this one upload to `transfer/sign`; the CP signs nothing else for it. */
  ticket: z.string().uuid()
})
export type WorkspaceUploadReq = z.infer<typeof WorkspaceUploadReq>

/** D→C REP: what the daemon snapshotted and sent. */
export const WorkspaceUploadOk = z.object({
  bytes: z.number().int().positive(),
  sha256: TransferSha256
})
export type WorkspaceUploadOk = z.infer<typeof WorkspaceUploadOk>

/** Where the requester reaches the bucket: a sandbox pod in the cluster, or anything else over the public origin. */
export const TransferNetwork = z.enum(['cluster', 'public'])
export type TransferNetwork = z.infer<typeof TransferNetwork>

/** D→C REQ: presign the PUT for a `workspace/upload` snapshot of exactly these bytes. */
export const TransferSignReq = z.object({
  ticket: z.string().uuid(),
  bytes: z.number().int().positive(),
  sha256: TransferSha256,
  network: TransferNetwork
})
export type TransferSignReq = z.infer<typeof TransferSignReq>

/** C→D REP: the presigned PUT and the exact headers it signed. */
export const TransferSignOk = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string())
})
export type TransferSignOk = z.infer<typeof TransferSignOk>

/** D→C REQ: presign the agent's GET for a file the console uploaded with one of its turns. */
export const TransferGetReq = z.object({
  agentId: z.string().min(1),
  uploadId: z.string().uuid(),
  size: z.number().int().positive(),
  sha256: TransferSha256,
  network: TransferNetwork
})
export type TransferGetReq = z.infer<typeof TransferGetReq>

/** C→D REP: the GET, or no `url` when the bucket does not hold exactly those bytes. */
export const TransferGetOk = z.object({
  url: z.string().url().optional(),
  expiresAt: z.number().int().optional()
})
export type TransferGetOk = z.infer<typeof TransferGetOk>

/** A file the browser uploaded through a `TransferUploadGrant`; metadata only, the bytes are in the bucket. */
export const WebchatFileAttachment = z.object({
  uploadId: z.string().uuid(),
  name: TransferFileName,
  mimeType: TransferMimeType,
  size: z.number().int().positive(),
  sha256: TransferSha256
})
export type WebchatFileAttachment = z.infer<typeof WebchatFileAttachment>
