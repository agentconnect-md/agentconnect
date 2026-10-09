import { addressFor, amzDate, presign, type CredentialsProvider } from '@agentconnect.md/object-store'
import { SOURCE_CACHE_GRACE_SECONDS, sourceCacheEndpoint, type SourceCacheConfig } from './config.js'
import { parseSourceCacheObjectKey, type SourceCacheObjectKey } from './keys.js'

// Presigned Source Cache URLs (source-cache.md §6 item 4, §9): GET signs host only; PUT signs length, checksum and tag as headers.

export const PENDING_TAGGING = 'ac-cache=pending'

export interface PresignedRequest {
  method: 'GET' | 'PUT'
  url: string
  /** The exact headers the requester must send (host excluded). */
  headers: Record<string, string>
  /** Epoch ms after which the store refuses the URL. */
  expiresAt: number
}

export interface PresignPutInput {
  contentLength: number
  /** Base64 of the 32-byte SHA-256 of the body. */
  checksumSha256: string
}

export interface SourceCachePresigner {
  presignGet(key: SourceCacheObjectKey): Promise<PresignedRequest>
  presignPut(key: SourceCacheObjectKey, input: PresignPutInput): Promise<PresignedRequest>
}

export type SourceCachePresignerConfig = Pick<
  SourceCacheConfig,
  'endpoint' | 'region' | 'bucket' | 'prefix' | 'forcePathStyle'
> & {
  limits: Pick<SourceCacheConfig['limits'], 'getUrlSeconds' | 'putUrlSeconds' | 'maxBundleBytes'>
}

export interface PresignerOptions {
  config: SourceCachePresignerConfig
  credentials: CredentialsProvider
  now?: () => number
  /** Test seam: an endpoint the config schema would refuse (a plain-http fixture). */
  endpointOverride?: string
}

const CHECKSUM_RE = /^[A-Za-z0-9+/]{43}=$/

export function createPresigner(opts: PresignerOptions): SourceCachePresigner {
  const { config, credentials } = opts
  const now = opts.now ?? Date.now
  const address = addressFor(opts.endpointOverride ?? sourceCacheEndpoint(config), config.bucket, config.forcePathStyle)
  const objectPath = (key: SourceCacheObjectKey): string => {
    // Pointers are store rows, never objects (§4), so only a bundle key is ever signed.
    if (parseSourceCacheObjectKey(key)?.kind !== 'bundle') throw new Error('Source Cache key must be a src/ bundle key')
    return `${address.basePath}${config.prefix ? `${config.prefix}/` : ''}${key}`
  }

  const sign = async (
    method: 'GET' | 'PUT',
    key: SourceCacheObjectKey,
    lifetimeSeconds: number,
    headers: Record<string, string>
  ): Promise<PresignedRequest> => {
    const path = objectPath(key)
    // A URL dies with its session token, so ask for credentials that outlive it.
    const creds = await credentials.get((lifetimeSeconds + SOURCE_CACHE_GRACE_SECONDS) * 1000)
    const signedAt = now()
    const { url } = presign({
      method,
      protocol: address.protocol,
      host: address.host,
      path,
      headers,
      credentials: creds,
      region: config.region,
      datetime: amzDate(signedAt),
      expiresSeconds: lifetimeSeconds
    })
    return {
      method,
      url,
      headers: { ...headers },
      expiresAt: Math.floor(signedAt / 1000) * 1000 + lifetimeSeconds * 1000
    }
  }

  return {
    presignGet: (key) => sign('GET', key, config.limits.getUrlSeconds, {}),
    presignPut: async (key, input) => {
      const { contentLength, checksumSha256 } = input
      if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > config.limits.maxBundleBytes) {
        throw new Error('Source Cache upload length must be 1 byte to the bundle cap')
      }
      if (!CHECKSUM_RE.test(checksumSha256) || Buffer.from(checksumSha256, 'base64').length !== 32) {
        throw new Error('Source Cache upload checksum must be a base64 SHA-256')
      }
      return sign('PUT', key, config.limits.putUrlSeconds, {
        'content-length': String(contentLength),
        'x-amz-checksum-sha256': checksumSha256,
        'x-amz-tagging': PENDING_TAGGING
      })
    }
  }
}

export { addressFor }
export { redactPresignedUrl } from './bundle-retry.js'
