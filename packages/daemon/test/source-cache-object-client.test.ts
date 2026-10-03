import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CredentialsProvider } from '../src/source-cache/credentials.js'
import { bundleKey, pointerKey, type SourceCacheObjectKey } from '../src/source-cache/keys.js'
import { createObjectClient, SourceCacheObjectError } from '../src/source-cache/object-client.js'
import { canonicalUri, sha256Hex } from '../src/source-cache/sigv4.js'

// The member's own header-signed HEAD and PutObjectTagging (source-cache.md §9 step 5), against a fake fetch.

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const KEY = bundleKey({ org: 'org_1', class: 'cred', repo: 'github:42', id: '0b5c3f8e-8d0a-4c4e-9a1e-0123456789ab' })

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function harness(opts: { response?: Response; forcePathStyle?: boolean; sessionToken?: string; prefix?: string } = {}) {
  const captured: Captured[] = []
  const credentials: CredentialsProvider = {
    source: 'static',
    get: async () => ({
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      ...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {})
    })
  }
  const client = createObjectClient({
    config: {
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      bucket: 'cache',
      prefix: opts.prefix ?? 'agentconnect',
      forcePathStyle: opts.forcePathStyle ?? true
    },
    credentials,
    now: () => NOW,
    fetch: (async (url: string, init: RequestInit) => {
      captured.push({
        url,
        method: init.method!,
        headers: init.headers as Record<string, string>,
        ...(typeof init.body === 'string' ? { body: init.body } : {})
      })
      return opts.response?.clone() ?? new Response(null, { status: 200 })
    }) as typeof fetch
  })
  return { client, captured }
}

describe('Source Cache object client', () => {
  it('HEADs a bundle with checksum mode, signed headers, and parses length, checksum and etag', async () => {
    const response = new Response(null, {
      status: 200,
      headers: { 'content-length': '4096', 'x-amz-checksum-sha256': 'abc=', etag: '"e1"' }
    })
    const { client, captured } = harness({ response, sessionToken: 'tok' })
    expect(await client.head(KEY)).toEqual({ exists: true, contentLength: 4096, checksumSha256: 'abc=', etag: '"e1"' })
    const [req] = captured
    expect(req!.method).toBe('HEAD')
    expect(req!.url).toBe(`https://s3.example.com${canonicalUri(`/cache/agentconnect/${KEY}`)}`)
    expect(req!.headers['x-amz-checksum-mode']).toBe('ENABLED')
    expect(req!.headers['x-amz-date']).toBe('20261003T120000Z')
    expect(req!.headers['x-amz-content-sha256']).toBe(sha256Hex(''))
    expect(req!.headers['x-amz-security-token']).toBe('tok')
    expect(req!.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/20261003\/us-east-1\/s3\/aws4_request,SignedHeaders=host;x-amz-checksum-mode;x-amz-content-sha256;x-amz-date;x-amz-security-token,Signature=[0-9a-f]{64}$/
    )
  })

  it('addresses virtual-hosted style when not forced to path style', async () => {
    const { client, captured } = harness({ forcePathStyle: false, prefix: '' })
    await client.head(KEY)
    expect(captured[0]!.url).toBe(`https://cache.s3.example.com${canonicalUri(`/${KEY}`)}`)
  })

  it('reads 404 as absent and any other failure as a typed error', async () => {
    expect(await harness({ response: new Response(null, { status: 404 }) }).client.head(KEY)).toEqual({ exists: false })
    await expect(harness({ response: new Response(null, { status: 403 }) }).client.head(KEY)).rejects.toBeInstanceOf(
      SourceCacheObjectError
    )
  })

  it('retags with a signed Tagging body, its MD5 and payload hash', async () => {
    const { client, captured } = harness()
    await client.putTagging(KEY, 'ac-cache=live')
    const [req] = captured
    expect(req!.method).toBe('PUT')
    expect(req!.url).toBe(`https://s3.example.com${canonicalUri(`/cache/agentconnect/${KEY}`)}?tagging=`)
    expect(req!.body).toBe(
      '<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet><Tag><Key>ac-cache</Key><Value>live</Value></Tag></TagSet></Tagging>'
    )
    expect(req!.headers['content-md5']).toBe(createHash('md5').update(req!.body!).digest('base64'))
    expect(req!.headers['x-amz-content-sha256']).toBe(sha256Hex(req!.body!))
    expect(req!.headers.authorization).toContain(
      'SignedHeaders=content-md5;content-type;host;x-amz-content-sha256;x-amz-date,'
    )
  })

  it('surfaces a refused retag with its S3 code and no credentials', async () => {
    const response = new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })
    const failure = await harness({ response })
      .client.putTagging(KEY, 'ac-cache=live')
      .catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(SourceCacheObjectError)
    expect(failure).toMatchObject({ status: 403, code: 'AccessDenied' })
    expect((failure as Error).message).not.toContain('secret')
  })

  it('refuses a pointer key: pointers are store rows, never objects', async () => {
    const pointer = pointerKey({
      org: 'org_1',
      class: 'cred',
      repo: 'github:42',
      ref: 'refs/heads/main',
      shape: 'full'
    })
    const { client, captured } = harness()
    await expect(client.head(pointer)).rejects.toThrow(/bundle key/)
    await expect(client.putTagging(pointer, 'ac-cache=live')).rejects.toThrow(/bundle key/)
    await expect(client.head('src/../x' as SourceCacheObjectKey)).rejects.toThrow(/bundle key/)
    expect(captured).toEqual([])
  })
})
