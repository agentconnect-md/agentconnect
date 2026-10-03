import { createHash } from 'node:crypto'
import { SOURCE_CACHE_GRACE_SECONDS, sourceCacheEndpoint, type SourceCacheConfig } from './config.js'
import type { CredentialsProvider } from './credentials.js'
import { parseSourceCacheObjectKey, type SourceCacheObjectKey } from './keys.js'
import { addressFor } from './presigner.js'
import { amzDate, canonicalQuery, canonicalUri, sha256Hex, signHeaders } from './sigv4.js'

// Header-signed requests the member makes itself (source-cache.md §9, §10): HEAD, retag, delete, and the lifecycle read.

export type SourceCacheLifecycleTag = 'ac-cache=live' | 'ac-cache=unreferenced'

export type SourceCacheObjectHead =
  { exists: false } | { exists: true; contentLength: number; checksumSha256?: string; etag?: string }

export interface SourceCacheObjectClient {
  head(key: SourceCacheObjectKey): Promise<SourceCacheObjectHead>
  putTagging(key: SourceCacheObjectKey, tagging: SourceCacheLifecycleTag): Promise<void>
  /** Delete a bundle object; an object already gone resolves too. */
  delete(key: SourceCacheObjectKey): Promise<void>
  /** The bucket's lifecycle configuration XML, or `none` when the bucket has none. */
  getBucketLifecycle(): Promise<SourceCacheBucketLifecycle>
}

export type SourceCacheBucketLifecycle = { kind: 'none' } | { kind: 'rules'; xml: string }

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
/** A lifecycle configuration holds at most 1,000 rules; anything past this is not one the daemon reads. */
const LIFECYCLE_MAX_BYTES = 256 * 1024

function tagParts(tagging: SourceCacheLifecycleTag): [string, string] {
  const [key, value] = tagging.split('=')
  return [key!, value!]
}

function taggingXml(tagging: SourceCacheLifecycleTag): string {
  const [key, value] = tagParts(tagging)
  return `<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet><Tag><Key>${key}</Key><Value>${value}</Value></Tag></TagSet></Tagging>`
}

async function boundedText(res: Response, maxBytes: number): Promise<string | undefined> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      // Not awaited: a cancel settles only once every branch of a teed body is cancelled.
      void reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
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
    method: 'HEAD' | 'PUT' | 'DELETE' | 'GET'
    /** A bundle key, or `bucket` for a bucket-level subresource such as `?lifecycle`. */
    key: SourceCacheObjectKey | 'bucket'
    query?: Record<string, string>
    headers: Record<string, string>
    body?: string
  }): Promise<Response> => {
    const path = input.key === 'bucket' ? address.basePath : objectPath(input.key)
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
    },
    async delete(key) {
      const res = await send({ method: 'DELETE', key, headers: {} })
      if (res.status === 200 || res.status === 204) return void (await res.body?.cancel().catch(() => undefined))
      const code = await errorCode(res)
      // S3 answers 204 for an absent key; a 404 counts as gone too, unless the bucket itself is missing.
      if (res.status === 404 && code !== 'NoSuchBucket') return
      throw new SourceCacheObjectError(res.status, code, 'DELETE')
    },
    async getBucketLifecycle() {
      const res = await send({ method: 'GET', key: 'bucket', query: { lifecycle: '' }, headers: {} })
      if (res.status === 200) {
        const xml = await boundedText(res, LIFECYCLE_MAX_BYTES)
        if (xml === undefined) throw new SourceCacheObjectError(res.status, 'TooLarge', 'lifecycle read')
        return { kind: 'rules', xml }
      }
      const code = await errorCode(res)
      if (res.status === 404 && code === 'NoSuchLifecycleConfiguration') return { kind: 'none' }
      throw new SourceCacheObjectError(res.status, code, 'lifecycle read')
    }
  }
}
