import { createHash } from 'node:crypto'
import { SOURCE_CACHE_GRACE_SECONDS, sourceCacheEndpoint, type SourceCacheConfig } from './config.js'
import type { CredentialsProvider } from './credentials.js'
import { parseSourceCacheObjectKey, type SourceCacheObjectKey } from './keys.js'
import { addressFor } from './presigner.js'
import { amzDate, canonicalQuery, canonicalUri, sha256Hex, signHeaders } from './sigv4.js'

// Header-signed object requests the member makes itself (source-cache.md §9 step 5): HEAD verify and retag.

export type SourceCacheLifecycleTag = 'ac-cache=live' | 'ac-cache=unreferenced'

export type SourceCacheObjectHead =
  { exists: false } | { exists: true; contentLength: number; checksumSha256?: string; etag?: string }

export interface SourceCacheObjectClient {
  head(key: SourceCacheObjectKey): Promise<SourceCacheObjectHead>
  putTagging(key: SourceCacheObjectKey, tagging: SourceCacheLifecycleTag): Promise<void>
}

export class SourceCacheObjectError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    operation: string
  ) {
    super(`Source Cache ${operation} failed: HTTP ${status}${code ? ` ${code}` : ''}`)
    this.name = 'SourceCacheObjectError'
  }
}

export interface ObjectClientOptions {
  config: Pick<SourceCacheConfig, 'endpoint' | 'region' | 'bucket' | 'prefix' | 'forcePathStyle'>
  credentials: CredentialsProvider
  fetch?: typeof fetch
  now?: () => number
  /** Test seam: an endpoint the config schema would refuse (a plain-http fixture). */
  endpointOverride?: string
}

const EMPTY_PAYLOAD_SHA256 = sha256Hex('')
const REQUEST_TIMEOUT_MS = 30_000

function tagParts(tagging: SourceCacheLifecycleTag): [string, string] {
  const [key, value] = tagging.split('=')
  return [key!, value!]
}

function taggingXml(tagging: SourceCacheLifecycleTag): string {
  const [key, value] = tagParts(tagging)
  return `<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet><Tag><Key>${key}</Key><Value>${value}</Value></Tag></TagSet></Tagging>`
}

async function errorCode(res: Response): Promise<string | undefined> {
  const body = await res.text().catch(() => '')
  return /<Code>([A-Za-z0-9.]{1,64})<\/Code>/.exec(body.slice(0, 4096))?.[1]
}

export function createObjectClient(opts: ObjectClientOptions): SourceCacheObjectClient {
  const { config, credentials } = opts
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const address = addressFor(opts.endpointOverride ?? sourceCacheEndpoint(config), config.bucket, config.forcePathStyle)
  const objectPath = (key: SourceCacheObjectKey): string => {
    if (parseSourceCacheObjectKey(key)?.kind !== 'bundle') throw new Error('Source Cache key must be a src/ bundle key')
    return `${address.basePath}${config.prefix ? `${config.prefix}/` : ''}${key}`
  }

  const send = async (input: {
    method: 'HEAD' | 'PUT'
    key: SourceCacheObjectKey
    query?: Record<string, string>
    headers: Record<string, string>
    body?: string
  }): Promise<Response> => {
    const path = objectPath(input.key)
    const creds = await credentials.get(SOURCE_CACHE_GRACE_SECONDS * 1000)
    const payloadHash = input.body === undefined ? EMPTY_PAYLOAD_SHA256 : sha256Hex(input.body)
    const headers = { ...input.headers, 'x-amz-date': amzDate(now()), 'x-amz-content-sha256': payloadHash }
    const signed = signHeaders({
      method: input.method,
      protocol: address.protocol,
      host: address.host,
      path,
      ...(input.query ? { query: input.query } : {}),
      headers,
      credentials: creds,
      region: config.region,
      datetime: headers['x-amz-date'],
      payloadHash
    })
    const query = input.query ? `?${canonicalQuery(input.query)}` : ''
    return await doFetch(`${address.protocol}//${address.host}${canonicalUri(path)}${query}`, {
      method: input.method,
      headers: {
        ...headers,
        ...(creds.sessionToken ? { 'x-amz-security-token': creds.sessionToken } : {}),
        authorization: signed.authorization
      },
      ...(input.body === undefined ? {} : { body: input.body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  }

  return {
    async head(key) {
      const res = await send({ method: 'HEAD', key, headers: { 'x-amz-checksum-mode': 'ENABLED' } })
      if (res.status === 404) return { exists: false }
      if (res.status !== 200) throw new SourceCacheObjectError(res.status, undefined, 'HEAD')
      const length = Number(res.headers.get('content-length'))
      if (!Number.isSafeInteger(length) || length < 0) throw new SourceCacheObjectError(res.status, 'NoLength', 'HEAD')
      const checksum = res.headers.get('x-amz-checksum-sha256') ?? undefined
      const etag = res.headers.get('etag') ?? undefined
      return {
        exists: true,
        contentLength: length,
        ...(checksum ? { checksumSha256: checksum } : {}),
        ...(etag ? { etag } : {})
      }
    },
    async putTagging(key, tagging) {
      const body = taggingXml(tagging)
      const res = await send({
        method: 'PUT',
        key,
        query: { tagging: '' },
        headers: {
          'content-type': 'application/xml',
          'content-md5': createHash('md5').update(body).digest('base64')
        },
        body
      })
      if (res.status < 200 || res.status >= 300)
        throw new SourceCacheObjectError(res.status, await errorCode(res), 'retag')
      await res.body?.cancel().catch(() => undefined)
    }
  }
}
