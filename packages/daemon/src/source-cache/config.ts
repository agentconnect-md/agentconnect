import { z } from 'zod'

// Source Cache configuration (source-cache.md §12): one JSON document a pool member reads under --k8s only.

export const SOURCE_CACHE_ENV = 'AC_SOURCE_CACHE'

const KIB = 1024
const GIB = KIB * KIB * KIB
/** The S3 single-PUT ceiling; a bundle above it cannot be one presigned upload. */
export const S3_SINGLE_PUT_MAX_BYTES = 5 * GIB
/** Grace a URL lifetime needs on top of itself: the reservation margin and the credential refresh margin. */
export const SOURCE_CACHE_GRACE_SECONDS = 300

const BINARY_UNITS: Record<string, number> = { '': 1, Ki: KIB, Mi: KIB ** 2, Gi: KIB ** 3, Ti: KIB ** 4 }
const DURATION_UNITS: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 }

const ByteQuantity = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const match = typeof value === 'number' ? null : /^(\d{1,16})(Ki|Mi|Gi|Ti)?$/.exec(value.trim())
  const bytes = typeof value === 'number' ? value : match ? Number(match[1]) * BINARY_UNITS[match[2] ?? '']! : NaN
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    ctx.addIssue({ code: 'custom', message: 'must be a positive byte count or a binary quantity such as 2Gi' })
    return z.NEVER
  }
  return bytes
})

const DurationSeconds = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const match = typeof value === 'number' ? null : /^(\d{1,9})(s|m|h|d)?$/.exec(value.trim())
  const seconds = typeof value === 'number' ? value : match ? Number(match[1]) * DURATION_UNITS[match[2] ?? '']! : NaN
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    ctx.addIssue({ code: 'custom', message: 'must be a positive number of seconds or a duration such as 15m' })
    return z.NEVER
  }
  return seconds
})

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const PREFIX_SEGMENT_RE = /^[A-Za-z0-9._-]+$/
const KEY_NAME_RE = /^[A-Za-z0-9._-]{1,253}$/

const Endpoint = z.string().transform((value, ctx) => {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be an absolute https:// URL' })
    return z.NEVER
  }
  // The shim admits only --bundle-uri=https://…, so a plain-http store would make every GET a silent miss.
  if (url.protocol !== 'https:') ctx.addIssue({ code: 'custom', message: 'must use https://' })
  if (url.username || url.password) ctx.addIssue({ code: 'custom', message: 'must not carry credentials' })
  if (url.pathname !== '/' || url.search || url.hash || trimmed.includes('?') || trimmed.includes('#')) {
    ctx.addIssue({ code: 'custom', message: 'must be an origin with no path, query or fragment' })
  }
  return url.origin
})

const Bucket = z
  .string()
  .refine((b) => BUCKET_RE.test(b) && !b.includes('..') && !b.includes('.-') && !b.includes('-.') && !IPV4_RE.test(b), {
    message: 'must be a valid S3 bucket name (3-63 lower-case letters, digits, dots or hyphens, not an IP address)'
  })

const Prefix = z
  .string()
  .default('')
  .refine(
    (prefix) => {
      if (prefix === '') return true
      const segments = prefix.split('/')
      return (
        prefix.length <= 256 &&
        segments.every((s) => PREFIX_SEGMENT_RE.test(s) && s !== '.' && s !== '..') &&
        segments[0] !== 'snapshots'
      )
    },
    {
      message: "must be '/'-separated [A-Za-z0-9._-] segments with no leading or trailing '/' and not under snapshots/"
    }
  )

const Region = z.string().regex(/^[a-z0-9-]{1,32}$/, { message: 'must be a region name such as us-east-1' })

const StaticCredentials = z.strictObject({
  source: z.literal('static'),
  dir: z.string().startsWith('/', { message: 'must be an absolute directory' }),
  accessKeyIdKey: z.string().regex(KEY_NAME_RE, { message: 'must name a Secret key' }),
  secretAccessKeyKey: z.string().regex(KEY_NAME_RE, { message: 'must name a Secret key' }),
  sessionTokenKey: z.string().regex(KEY_NAME_RE, { message: 'must name a Secret key' }).optional()
})

const WebIdentityCredentials = z.strictObject({
  source: z.literal('webIdentity'),
  roleArn: z
    .string()
    .regex(/^arn:[a-z0-9-]+:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/, { message: 'must be an IAM role ARN' })
    .optional(),
  tokenFile: z.string().startsWith('/', { message: 'must be an absolute path' }).optional(),
  stsEndpoint: Endpoint.optional(),
  sessionName: z
    .string()
    .regex(/^[\w+=,.@-]{2,64}$/, { message: 'must be 2-64 characters of [A-Za-z0-9_+=,.@-]' })
    .optional(),
  durationSeconds: z.number().int().min(900).max(43_200).default(3600)
})

const Limits = z
  .strictObject({
    maxBundleBytes: ByteQuantity.default(2 * GIB),
    orgQuotaBytes: ByteQuantity.default(20 * GIB),
    pendingReservationSeconds: DurationSeconds.default(3600),
    unreadPointerDays: z.number().int().min(1).max(365).default(30),
    getUrlSeconds: DurationSeconds.default(300),
    putUrlSeconds: DurationSeconds.default(900),
    // Console file transfers: the per-file cap, and how long a download link (the browser's or the agent's) stays valid.
    transferMaxBytes: ByteQuantity.default(512 * KIB * KIB),
    transferUrlSeconds: DurationSeconds.default(1800)
  })
  .prefault({})

export const SourceCacheConfigSchema = z
  .strictObject({
    version: z.literal(1),
    endpoint: Endpoint.optional(),
    // The origin browsers reach the bucket at for file transfers, when it differs from the in-cluster `endpoint`.
    publicEndpoint: Endpoint.optional(),
    region: Region,
    bucket: Bucket,
    prefix: Prefix,
    forcePathStyle: z.boolean().default(false),
    credentials: z.discriminatedUnion('source', [StaticCredentials, WebIdentityCredentials]),
    limits: Limits
  })
  .superRefine((config, ctx) => {
    const { limits } = config
    for (const name of ['getUrlSeconds', 'putUrlSeconds'] as const) {
      if (limits[name] < 60 || limits[name] > 3600) {
        ctx.addIssue({ code: 'custom', path: ['limits', name], message: 'must be between 1m and 1h' })
      }
    }
    if (limits.transferUrlSeconds < 60 || limits.transferUrlSeconds > 12 * 3600) {
      ctx.addIssue({ code: 'custom', path: ['limits', 'transferUrlSeconds'], message: 'must be between 1m and 12h' })
    }
    if (limits.transferMaxBytes > S3_SINGLE_PUT_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', path: ['limits', 'transferMaxBytes'], message: 'must not exceed 5Gi' })
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
    const credentials = config.credentials
    if (
      credentials.source === 'webIdentity' &&
      credentials.durationSeconds <=
        Math.max(limits.getUrlSeconds, limits.putUrlSeconds, limits.transferUrlSeconds) + SOURCE_CACHE_GRACE_SECONDS
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['credentials', 'durationSeconds'],
        message: 'must outlive the longest URL lifetime plus 5m'
      })
    }
  })

export type SourceCacheConfig = z.output<typeof SourceCacheConfigSchema>
export type SourceCacheCredentialsConfig = SourceCacheConfig['credentials']
export type SourceCacheLimits = SourceCacheConfig['limits']

/** Parse the member's Source Cache document; undefined when unset, a thrown error (never echoing values) when invalid. */
export function loadSourceCacheConfig(env: NodeJS.ProcessEnv): SourceCacheConfig | undefined {
  const raw = env[SOURCE_CACHE_ENV]?.trim()
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${SOURCE_CACHE_ENV} must be valid JSON`)
  }
  const result = SourceCacheConfigSchema.safeParse(parsed)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issueMessage(issue)}`)
      .join('; ')
    throw new Error(`${SOURCE_CACHE_ENV} is invalid: ${detail}`)
  }
  return result.data
}

/** Zod's own messages for a few codes quote the input, so those are restated without it. */
function issueMessage(issue: z.core.$ZodIssue): string {
  if (issue.code === 'unrecognized_keys') return `unknown key(s) ${issue.keys.join(', ')}`
  if (issue.code === 'invalid_value') return 'has an unsupported value'
  if (issue.code === 'invalid_union') return 'has an unsupported shape'
  return issue.message
}

/** The effective S3 origin: the configured endpoint, or the AWS regional one. */
export function sourceCacheEndpoint(config: Pick<SourceCacheConfig, 'endpoint' | 'region'>): string {
  return config.endpoint ?? `https://s3.${config.region}.amazonaws.com`
}
