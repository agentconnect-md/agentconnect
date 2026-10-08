import { z } from 'zod'
import { isValidBranchRef } from '../workspace/git-command-policy.js'

// The `bundle` capability's wire shapes (source-cache.md §9, §13); no field ever carries a filesystem path.

export const SOURCE_CACHE_BUNDLE_FEATURE = 'source-cache-bundle-v1' as const
/** The only tag a presigned PUT may carry; the store enforces it because it is signed. */
export const BUNDLE_PENDING_TAGGING = 'ac-cache=pending'
/** The exact header set a write-back upload sends, besides host. */
export const BUNDLE_UPLOAD_HEADERS = ['content-length', 'x-amz-checksum-sha256', 'x-amz-tagging'] as const
/** The S3 single-PUT ceiling. */
export const MAX_BUNDLE_BYTES = 5 * 1024 ** 3

const Handle = z.uuid()
const Commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, { message: 'must be a full object id' })
const Sha256 = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, { message: 'must be a base64 SHA-256' })
  .refine((value) => Buffer.from(value, 'base64').length === 32, { message: 'must be a base64 SHA-256' })
const TimeoutMs = z
  .number()
  .int()
  .positive()
  .max(60 * 60_000)

export const BundleCreateRequestSchema = z.strictObject({
  op: z.literal('create'),
  /** The checkout, in the pod's coordinates; fenced to the workspace root by realpath. */
  cwd: z.string().min(1).max(4096),
  ref: z.string().refine(isValidBranchRef, { message: 'must be a full refs/heads/* name' }),
  /** The origin commit the daemon read; the shim bundles only while the ref still names it. */
  commit: Commit,
  shape: z.enum(['blobless', 'full']),
  maxBytes: z.number().int().positive().max(MAX_BUNDLE_BYTES),
  timeoutMs: TimeoutMs.optional()
})

export const BundleUploadRequestSchema = z.strictObject({
  op: z.literal('upload'),
  handle: Handle,
  /** A presigned PUT; never logged and never on a command line. */
  url: z.string().min(1).max(8192),
  headers: z.record(z.string().max(64), z.string().max(256)),
  timeoutMs: TimeoutMs.optional()
})

export const BundleDiscardRequestSchema = z.strictObject({ op: z.literal('discard'), handle: Handle })

export const BundleRequestSchema = z.discriminatedUnion('op', [
  BundleCreateRequestSchema,
  BundleUploadRequestSchema,
  BundleDiscardRequestSchema
])

export const BundleCreateResultSchema = z.strictObject({
  handle: Handle,
  bytes: z.number().int().positive().max(MAX_BUNDLE_BYTES),
  sha256: Sha256
})
export const BundleUploadResultSchema = z.strictObject({ bytes: z.number().int().positive(), sha256: Sha256 })
export const BundleDiscardResultSchema = z.strictObject({ discarded: z.boolean() })

export type BundleCreateRequest = z.infer<typeof BundleCreateRequestSchema>
export type BundleUploadRequest = z.infer<typeof BundleUploadRequestSchema>
export type BundleDiscardRequest = z.infer<typeof BundleDiscardRequestSchema>
export type BundleRequest = z.infer<typeof BundleRequestSchema>
export type BundleCreateResult = z.infer<typeof BundleCreateResultSchema>
export type BundleUploadResult = z.infer<typeof BundleUploadResultSchema>
export type BundleDiscardResult = z.infer<typeof BundleDiscardResultSchema>
