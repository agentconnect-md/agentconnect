import { createHash } from 'node:crypto'
import {
  addressFor,
  amzDate,
  bucketEndpoint,
  presign,
  SOURCE_CACHE_GRACE_SECONDS,
  type CredentialsProvider,
  type SourceCacheObjectClient
} from '@agentconnect.md/object-store'
import type { ComputerScreenshotContentType } from '@agentconnect.md/protocol'
import type { ComputerScreenshotsConfig } from './config.js'

// Screenshot objects (computer-use.md §9): the control plane signs every URL and checks every object; bytes go straight to the bucket.

/** A key under `computer-screenshots/`, built only here. */
export type ScreenshotObjectKey = string & { readonly __screenshotObjectKey: true }

const ORG_RE = /^[A-Za-z0-9_-]{1,64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SESSION_SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const KEY_RE =
  /^computer-screenshots\/[A-Za-z0-9_-]{1,64}\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{1,128}\/\d{13}-[0-9a-f]{64}\.(?:png|jpg|webp)$/

const EXTENSIONS: Record<ComputerScreenshotContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
}

// A session id that is not a safe path segment is named by its digest instead.
function sessionSegment(sessionId: string): string {
  return SESSION_SEGMENT_RE.test(sessionId)
    ? sessionId
    : `h-${createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 40)}`
}

/** `computer-screenshots/<org>/<computer>/<session>/<takenAtMs>-<sha256>.<ext>`. */
export function screenshotObjectKey(input: {
  orgId: string
  computerId: string
  sessionId: string
  takenAt: Date
  sha256: string
  contentType: ComputerScreenshotContentType
}): ScreenshotObjectKey {
  if (!ORG_RE.test(input.orgId)) throw new Error('org must be 1-64 characters of [A-Za-z0-9_-]')
  if (!UUID_RE.test(input.computerId)) throw new Error('computer id must be a lower-case UUID')
  if (!SHA256_HEX_RE.test(input.sha256)) throw new Error('sha256 must be lower-case hex')
  const ms = String(Math.max(0, Math.min(input.takenAt.getTime(), 9_999_999_999_999))).padStart(13, '0')
  return `computer-screenshots/${input.orgId}/${input.computerId}/${sessionSegment(input.sessionId)}/${ms}-${input.sha256}.${EXTENSIONS[input.contentType]}` as ScreenshotObjectKey
}

export function isScreenshotObjectKey(key: unknown): key is ScreenshotObjectKey {
  return typeof key === 'string' && KEY_RE.test(key)
}

/** The checksum header S3 verifies on the PUT: the hex digest as base64. */
export function sha256HexToBase64(sha256: string): string {
  return Buffer.from(sha256, 'hex').toString('base64')
}

export interface SignedScreenshotUrl {
  url: string
  headers: Record<string, string>
  expiresAt: number
}

export interface ScreenshotBucketDeps {
  config: ComputerScreenshotsConfig
  credentials: CredentialsProvider
  objects: Pick<SourceCacheObjectClient<ScreenshotObjectKey>, 'head' | 'delete'>
  now?: () => number
  /** Test seam: a plain-http fixture the config schema would refuse. */
  endpointOverride?: string
}

export interface ScreenshotBucket {
  readonly maxBytes: number
  /** Presign the desktop's PUT of exactly these bytes. */
  signPut(input: {
    key: ScreenshotObjectKey
    bytes: number
    sha256: string
    contentType: ComputerScreenshotContentType
  }): Promise<SignedScreenshotUrl>
  /** Presign a console read, shown inline. */
  signGet(input: { key: ScreenshotObjectKey; contentType: ComputerScreenshotContentType }): Promise<SignedScreenshotUrl>
  /** Whether the bucket holds exactly these bytes under the key. */
  holds(input: { key: ScreenshotObjectKey; bytes: number; sha256: string }): Promise<boolean>
  delete(key: ScreenshotObjectKey): Promise<void>
}

export function createScreenshotBucket(deps: ScreenshotBucketDeps): ScreenshotBucket {
  const { config, credentials, objects } = deps
  const now = deps.now ?? Date.now
  // Desktops and browsers are outside the cluster, so every URL uses the public origin.
  const address = addressFor(
    deps.endpointOverride ?? config.publicEndpoint ?? bucketEndpoint(config),
    config.bucket,
    config.forcePathStyle
  )

  const sign = async (input: {
    method: 'GET' | 'PUT'
    key: ScreenshotObjectKey
    lifetimeSeconds: number
    headers?: Record<string, string>
    query?: Record<string, string>
  }): Promise<SignedScreenshotUrl> => {
    if (!isScreenshotObjectKey(input.key)) throw new Error('not a screenshot key')
    const creds = await credentials.get((input.lifetimeSeconds + SOURCE_CACHE_GRACE_SECONDS) * 1000)
    const signedAt = now()
    const headers = input.headers ?? {}
    const { url } = presign({
      method: input.method,
      protocol: address.protocol,
      host: address.host,
      path: `${address.basePath}${config.prefix ? `${config.prefix}/` : ''}${input.key}`,
      headers,
      ...(input.query ? { query: input.query } : {}),
      credentials: creds,
      region: config.region,
      datetime: amzDate(signedAt),
      expiresSeconds: input.lifetimeSeconds
    })
    return {
      url,
      headers: { ...headers },
      expiresAt: Math.floor(signedAt / 1000) * 1000 + input.lifetimeSeconds * 1000
    }
  }

  return {
    maxBytes: config.limits.maxBytes,
    async signPut({ key, bytes, sha256, contentType }) {
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > config.limits.maxBytes) {
        throw new Error(`a screenshot must be 1 byte to ${config.limits.maxBytes} bytes`)
      }
      return await sign({
        method: 'PUT',
        key,
        lifetimeSeconds: config.limits.putUrlSeconds,
        headers: {
          'content-length': String(bytes),
          'content-type': contentType,
          'x-amz-checksum-sha256': sha256HexToBase64(sha256)
        }
      })
    },
    async signGet({ key, contentType }) {
      return await sign({
        method: 'GET',
        key,
        lifetimeSeconds: config.limits.getUrlSeconds,
        query: { 'response-content-type': contentType, 'response-cache-control': 'private, max-age=300' }
      })
    },
    async holds({ key, bytes, sha256 }) {
      const head = await objects.head(key)
      // The PUT signed the checksum, so a matching one proves these bytes; a store that omits it is trusted on length alone.
      if (!head.exists || head.contentLength !== bytes) return false
      return head.checksumSha256 === undefined || head.checksumSha256 === sha256HexToBase64(sha256)
    },
    delete: (key) => objects.delete(key)
  }
}
