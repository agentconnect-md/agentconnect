import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { beforeAll, describe, expect, inject, it } from 'vitest'
import type { CredentialsProvider } from '../src/source-cache/credentials.js'
import { bundleKey, newBundleId, type SourceCacheObjectKey } from '../src/source-cache/keys.js'
import { createPresigner, type SourceCachePresignerConfig } from '../src/source-cache/presigner.js'
import { amzDate, presign } from '../src/source-cache/sigv4.js'

// The P0 store-matrix facts (source-cache.md §14) re-proved through this presigner against MinIO.

const minio = inject('sourceCacheMinio')
const BUCKET = 'ac-source-cache'
const PREFIX = 'agentconnect'

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function send(url: string, method: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      )
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe.skipIf(!minio)('Source Cache presigned URLs on MinIO', () => {
  // The describe body still runs when skipped, so it needs a value to build against.
  const env = minio ?? {
    endpoint: 'http://127.0.0.1:9',
    accessKeyId: 'unused',
    secretAccessKey: 'unused',
    region: 'us-east-1'
  }
  const credentials: CredentialsProvider = {
    source: 'static',
    get: async () => ({ accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey })
  }
  const config: SourceCachePresignerConfig = {
    region: env.region,
    bucket: BUCKET,
    prefix: PREFIX,
    forcePathStyle: true,
    limits: { getUrlSeconds: 300, putUrlSeconds: 900, maxBundleBytes: 1024 * 1024 }
  }
  const signer = createPresigner({ config, credentials, endpointOverride: env.endpoint })
  const host = new URL(env.endpoint).host

  /** A header-free admin request signed by the low-level core, for steps the presigner does not offer. */
  function adminUrl(method: string, path: string, query?: Record<string, string>): string {
    return presign({
      method,
      protocol: 'http:',
      host,
      path,
      ...(query ? { query } : {}),
      credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
      region: env.region,
      datetime: amzDate(Date.now()),
      expiresSeconds: 60
    }).url
  }

  const objectPath = (key: SourceCacheObjectKey): string => `/${BUCKET}/${PREFIX}/${key}`
  const freshKey = (): SourceCacheObjectKey =>
    bundleKey({ org: 'org_1', class: 'cred', repo: 'github:42', id: newBundleId() })
  const sha = (body: Buffer): string => createHash('sha256').update(body).digest('base64')

  beforeAll(async () => {
    const created = await send(adminUrl('PUT', `/${BUCKET}`), 'PUT')
    expect(created.status).toBe(200)
  })

  it('accepts the exact signed PUT, stores the declared length and the pending tag, and serves it by GET', async () => {
    const key = freshKey()
    const body = randomBytes(4096)
    const put = await signer.presignPut(key, { contentLength: body.length, checksumSha256: sha(body) })
    const uploaded = await send(put.url, 'PUT', put.headers, body)
    expect(uploaded.status, uploaded.body).toBe(200)

    const head = await send(adminUrl('HEAD', objectPath(key)), 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(body.length))

    const tagging = await send(adminUrl('GET', objectPath(key), { tagging: '' }), 'GET')
    expect(tagging.status).toBe(200)
    const tags = [...tagging.body.matchAll(/<Tag><Key>([^<]*)<\/Key><Value>([^<]*)<\/Value><\/Tag>/g)].map(
      ([, k, v]) => `${k}=${v}`
    )
    expect(tags).toEqual(['ac-cache=pending'])

    const get = await signer.presignGet(key)
    const fetched = await new Promise<Buffer>((resolve, reject) => {
      httpRequest(get.url, { method: 'GET' }, (res) => {
        expect(res.statusCode).toBe(200)
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      })
        .on('error', reject)
        .end()
    })
    expect(fetched.equals(body)).toBe(true)
  })

  it('refuses a body of a different length than the signed one', async () => {
    const key = freshKey()
    const body = randomBytes(1024)
    const put = await signer.presignPut(key, { contentLength: body.length, checksumSha256: sha(body) })
    const longer = Buffer.concat([body, Buffer.from('x')])
    const reply = await send(put.url, 'PUT', { ...put.headers, 'content-length': String(longer.length) }, longer)
    expect(reply.status).toBe(403)
  })

  it('refuses a same-length body whose bytes do not match the signed checksum', async () => {
    const key = freshKey()
    const body = randomBytes(1024)
    const put = await signer.presignPut(key, { contentLength: body.length, checksumSha256: sha(body) })
    const other = randomBytes(1024)
    const reply = await send(put.url, 'PUT', put.headers, other)
    expect(reply.status).toBe(400)
    expect(reply.body).toMatch(/XAmzContentChecksumMismatch|BadDigest/)
    expect((await send(adminUrl('HEAD', objectPath(key)), 'HEAD')).status).toBe(404)
  })

  it('refuses an altered or omitted tag', async () => {
    const key = freshKey()
    const body = randomBytes(512)
    const put = await signer.presignPut(key, { contentLength: body.length, checksumSha256: sha(body) })
    const altered = await send(put.url, 'PUT', { ...put.headers, 'x-amz-tagging': 'ac-cache=live' }, body)
    expect(altered.status).toBe(403)
    const { 'x-amz-tagging': _omitted, ...withoutTag } = put.headers
    const omitted = await send(put.url, 'PUT', withoutTag, body)
    // MinIO answers a missing signed header with 400 AccessDenied, not 403; refused either way.
    expect(omitted.status).toBe(400)
    expect(omitted.body).toContain('<Code>AccessDenied</Code>')
    expect((await send(adminUrl('HEAD', objectPath(key)), 'HEAD')).status).toBe(404)
  })

  it('refuses an expired GET', async () => {
    const key = freshKey()
    const body = randomBytes(64)
    const put = await signer.presignPut(key, { contentLength: body.length, checksumSha256: sha(body) })
    expect((await send(put.url, 'PUT', put.headers, body)).status).toBe(200)
    const past = createPresigner({
      config: { ...config, limits: { ...config.limits, getUrlSeconds: 60 } },
      credentials,
      endpointOverride: env.endpoint,
      now: () => Date.now() - 5 * 60_000
    })
    const expired = await past.presignGet(key)
    expect((await send(expired.url, 'GET')).status).toBe(403)
  })

  it("round-trips a key whose cred repo id carries ':'", async () => {
    const key = freshKey()
    expect(key).toContain('github:42')
    const body = Buffer.from('bundle bytes')
    const put = await signer.presignPut(key, { contentLength: body.length, checksumSha256: sha(body) })
    expect((await send(put.url, 'PUT', put.headers, body)).status).toBe(200)
    const reply = await send((await signer.presignGet(key)).url, 'GET')
    expect(reply.status).toBe(200)
    expect(reply.body).toBe('bundle bytes')
  })
})
