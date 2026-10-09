import { z } from 'zod'

// Field schemas shared by every bucket document: the daemon's Source Cache and the control plane's file transfer.

const KIB = 1024
const GIB = KIB * KIB * KIB
/** The S3 single-PUT ceiling; an object above it cannot be one presigned upload. */
export const S3_SINGLE_PUT_MAX_BYTES = 5 * GIB
/** Grace a URL lifetime needs on top of itself: the reservation margin and the credential refresh margin. */
export const SOURCE_CACHE_GRACE_SECONDS = 300
/** The longest STS session AssumeRoleWithWebIdentity grants. */
export const STS_MAX_SESSION_SECONDS = 43_200

const BINARY_UNITS: Record<string, number> = { '': 1, Ki: KIB, Mi: KIB ** 2, Gi: KIB ** 3, Ti: KIB ** 4 }
const DURATION_UNITS: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 }

export const ByteQuantity = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const match = typeof value === 'number' ? null : /^(\d{1,16})(Ki|Mi|Gi|Ti)?$/.exec(value.trim())
  const bytes = typeof value === 'number' ? value : match ? Number(match[1]) * BINARY_UNITS[match[2] ?? '']! : NaN
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    ctx.addIssue({ code: 'custom', message: 'must be a positive byte count or a binary quantity such as 2Gi' })
    return z.NEVER
  }
  return bytes
})

export const DurationSeconds = z.union([z.number(), z.string()]).transform((value, ctx) => {
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

export const Endpoint = z.string().transform((value, ctx) => {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be an absolute https:// URL' })
    return z.NEVER
  }
  // The shim admits only --bundle-uri=https://…, and a console page cannot reach a plain-http store either.
  if (url.protocol !== 'https:') ctx.addIssue({ code: 'custom', message: 'must use https://' })
  if (url.username || url.password) ctx.addIssue({ code: 'custom', message: 'must not carry credentials' })
  if (url.pathname !== '/' || url.search || url.hash || trimmed.includes('?') || trimmed.includes('#')) {
    ctx.addIssue({ code: 'custom', message: 'must be an origin with no path, query or fragment' })
  }
  return url.origin
})

export const Bucket = z
  .string()
  .refine((b) => BUCKET_RE.test(b) && !b.includes('..') && !b.includes('.-') && !b.includes('-.') && !IPV4_RE.test(b), {
    message: 'must be a valid S3 bucket name (3-63 lower-case letters, digits, dots or hyphens, not an IP address)'
  })

export const Prefix = z
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

export const Region = z.string().regex(/^[a-z0-9-]{1,32}$/, { message: 'must be a region name such as us-east-1' })

export const StaticCredentials = z.strictObject({
  source: z.literal('static'),
  dir: z.string().startsWith('/', { message: 'must be an absolute directory' }),
  accessKeyIdKey: z.string().regex(KEY_NAME_RE, { message: 'must name a Secret key' }),
  secretAccessKeyKey: z.string().regex(KEY_NAME_RE, { message: 'must name a Secret key' }),
  sessionTokenKey: z.string().regex(KEY_NAME_RE, { message: 'must name a Secret key' }).optional()
})

export const WebIdentityCredentials = z.strictObject({
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
  // Omitted ⇒ derived from the longest URL the document signs; the role's MaxSessionDuration must allow it.
  durationSeconds: z.number().int().min(900).max(STS_MAX_SESSION_SECONDS).optional()
})

export const BucketCredentialsSchema = z.discriminatedUnion('source', [StaticCredentials, WebIdentityCredentials])

/** A credential source after defaulting: a web identity always names its session length. */
export type BucketCredentialsConfig =
  z.output<typeof StaticCredentials> | (z.output<typeof WebIdentityCredentials> & { durationSeconds: number })

/** The shortest STS session that outlives a URL of `longestUrlSeconds` by the grace, plus a minute of slack. */
export function sessionSecondsFor(longestUrlSeconds: number): number {
  return longestUrlSeconds + SOURCE_CACHE_GRACE_SECONDS + 60
}

/** Fill a web identity's session length from the longest URL it signs, at least an hour. */
export function withSessionDuration(
  credentials: z.output<typeof BucketCredentialsSchema>,
  longestUrlSeconds: number
): BucketCredentialsConfig {
  if (credentials.source !== 'webIdentity') return credentials
  const durationSeconds = credentials.durationSeconds ?? Math.max(3600, sessionSecondsFor(longestUrlSeconds))
  return { ...credentials, durationSeconds }
}

/** Refuse a web identity session that cannot outlive the longest URL the document signs. */
export function checkSessionDuration(
  credentials: z.output<typeof BucketCredentialsSchema>,
  longestUrlSeconds: number,
  urlPath: Array<string | number>,
  ctx: z.RefinementCtx
): void {
  if (credentials.source !== 'webIdentity') return
  const needed = sessionSecondsFor(longestUrlSeconds)
  if (needed > STS_MAX_SESSION_SECONDS) {
    ctx.addIssue({
      code: 'custom',
      path: urlPath,
      message: 'with STS credentials, every URL lifetime plus 6m must fit the 12h session maximum'
    })
  } else if (credentials.durationSeconds !== undefined && credentials.durationSeconds < needed) {
    ctx.addIssue({
      code: 'custom',
      path: ['credentials', 'durationSeconds'],
      message: 'must outlive the longest URL lifetime plus 6m'
    })
  }
}

/** Parse one JSON document from an env variable: undefined when unset, a thrown error (never echoing values) when invalid. */
export function parseEnvDocument<T extends z.ZodType>(
  env: NodeJS.ProcessEnv,
  name: string,
  schema: T
): z.output<T> | undefined {
  const raw = env[name]?.trim()
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${name} must be valid JSON`)
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issueMessage(issue)}`)
      .join('; ')
    throw new Error(`${name} is invalid: ${detail}`)
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

/** Where a bucket lives: the fields every signed request needs. */
export interface BucketLocation {
  endpoint?: string | undefined
  region: string
  bucket: string
  prefix: string
  forcePathStyle: boolean
}

/** The effective S3 origin: the configured endpoint, or the AWS regional one. */
export function bucketEndpoint(config: Pick<BucketLocation, 'endpoint' | 'region'>): string {
  return config.endpoint ?? `https://s3.${config.region}.amazonaws.com`
}
