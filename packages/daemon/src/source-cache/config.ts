import {
  Bucket,
  BucketCredentialsSchema,
  bucketEndpoint,
  ByteQuantity,
  checkSessionDuration,
  DurationSeconds,
  Endpoint,
  parseEnvDocument,
  Prefix,
  Region,
  S3_SINGLE_PUT_MAX_BYTES,
  SOURCE_CACHE_GRACE_SECONDS,
  withSessionDuration
} from '@agentconnect.md/object-store'
import { z } from 'zod'

// Source Cache configuration (source-cache.md §12): one JSON document a pool member reads under --k8s only.

export const SOURCE_CACHE_ENV = 'AC_SOURCE_CACHE'
export { S3_SINGLE_PUT_MAX_BYTES, SOURCE_CACHE_GRACE_SECONDS }

const GIB = 1024 ** 3

const Limits = z
  .strictObject({
    maxBundleBytes: ByteQuantity.default(2 * GIB),
    orgQuotaBytes: ByteQuantity.default(20 * GIB),
    pendingReservationSeconds: DurationSeconds.default(3600),
    unreadPointerDays: z.number().int().min(1).max(365).default(30),
    getUrlSeconds: DurationSeconds.default(300),
    putUrlSeconds: DurationSeconds.default(900)
  })
  .prefault({})

export const SourceCacheConfigSchema = z
  .strictObject({
    version: z.literal(1),
    endpoint: Endpoint.optional(),
    region: Region,
    bucket: Bucket,
    prefix: Prefix,
    forcePathStyle: z.boolean().default(false),
    credentials: BucketCredentialsSchema,
    limits: Limits
  })
  .superRefine((config, ctx) => {
    const { limits } = config
    for (const name of ['getUrlSeconds', 'putUrlSeconds'] as const) {
      if (limits[name] < 60 || limits[name] > 3600) {
        ctx.addIssue({ code: 'custom', path: ['limits', name], message: 'must be between 1m and 1h' })
      }
    }
    if (limits.pendingReservationSeconds < limits.putUrlSeconds + SOURCE_CACHE_GRACE_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['limits', 'pendingReservationSeconds'],
        message: 'must be at least the PUT URL lifetime plus 5m'
      })
    }
    if (limits.maxBundleBytes > Math.min(S3_SINGLE_PUT_MAX_BYTES, limits.orgQuotaBytes)) {
      ctx.addIssue({
        code: 'custom',
        path: ['limits', 'maxBundleBytes'],
        message: 'must not exceed the org quota or 5Gi'
      })
    }
    checkSessionDuration(config.credentials, longestUrl(limits), ['limits', 'putUrlSeconds'], ctx)
  })
  .transform((config) => ({
    ...config,
    credentials: withSessionDuration(config.credentials, longestUrl(config.limits))
  }))

function longestUrl(limits: { getUrlSeconds: number; putUrlSeconds: number }): number {
  return Math.max(limits.getUrlSeconds, limits.putUrlSeconds)
}

export type SourceCacheConfig = z.output<typeof SourceCacheConfigSchema>
export type SourceCacheCredentialsConfig = SourceCacheConfig['credentials']
export type SourceCacheLimits = SourceCacheConfig['limits']

/** Parse the member's Source Cache document; undefined when unset, a thrown error (never echoing values) when invalid. */
export function loadSourceCacheConfig(env: NodeJS.ProcessEnv): SourceCacheConfig | undefined {
  return parseEnvDocument(env, SOURCE_CACHE_ENV, SourceCacheConfigSchema)
}

/** The effective S3 origin: the configured endpoint, or the AWS regional one. */
export const sourceCacheEndpoint = bucketEndpoint
