import {
  Bucket,
  BucketCredentialsSchema,
  ByteQuantity,
  checkSessionDuration,
  DurationSeconds,
  Endpoint,
  parseEnvDocument,
  Prefix,
  Region,
  S3_SINGLE_PUT_MAX_BYTES,
  withSessionDuration
} from '@agentconnect.md/object-store'
import { z } from 'zod'

// Console file transfer configuration (source-cache-file-transfer.md §7): the bucket the control plane signs URLs for.

export const FILE_TRANSFER_ENV = 'AC_FILE_TRANSFER'

const Limits = z
  .strictObject({
    // The per-file cap, how long a download link (the browser's or the agent's) stays valid, and how long a PUT does.
    maxBytes: ByteQuantity.default(512 * 1024 ** 2),
    urlSeconds: DurationSeconds.default(1800),
    putUrlSeconds: DurationSeconds.default(900)
  })
  .prefault({})

export const FileTransferConfigSchema = z
  .strictObject({
    version: z.literal(1),
    // The origin sandbox pods reach the bucket at; the AWS regional endpoint when omitted.
    endpoint: Endpoint.optional(),
    // The origin browsers and machines outside the cluster reach it at, when it differs from `endpoint`.
    publicEndpoint: Endpoint.optional(),
    region: Region,
    bucket: Bucket,
    prefix: Prefix,
    forcePathStyle: z.boolean().default(false),
    credentials: BucketCredentialsSchema,
    limits: Limits
  })
  .superRefine((config, ctx) => {
    const { limits } = config
    if (limits.urlSeconds < 60 || limits.urlSeconds > 12 * 3600) {
      ctx.addIssue({ code: 'custom', path: ['limits', 'urlSeconds'], message: 'must be between 1m and 12h' })
    }
    if (limits.putUrlSeconds < 60 || limits.putUrlSeconds > 3600) {
      ctx.addIssue({ code: 'custom', path: ['limits', 'putUrlSeconds'], message: 'must be between 1m and 1h' })
    }
    if (limits.maxBytes > S3_SINGLE_PUT_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', path: ['limits', 'maxBytes'], message: 'must not exceed 5Gi' })
    }
    checkSessionDuration(config.credentials, longestUrl(limits), ['limits', 'urlSeconds'], ctx)
  })
  .transform((config) => ({
    ...config,
    credentials: withSessionDuration(config.credentials, longestUrl(config.limits))
  }))

function longestUrl(limits: { urlSeconds: number; putUrlSeconds: number }): number {
  return Math.max(limits.urlSeconds, limits.putUrlSeconds)
}

export type FileTransferConfig = z.output<typeof FileTransferConfigSchema>

/** Parse the control plane's transfer document; undefined when unset, a thrown error (never echoing values) when invalid. */
export function loadFileTransferConfig(env: NodeJS.ProcessEnv): FileTransferConfig | undefined {
  return parseEnvDocument(env, FILE_TRANSFER_ENV, FileTransferConfigSchema)
}
