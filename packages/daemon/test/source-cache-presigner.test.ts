import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CredentialsProvider, SourceCacheCredentials } from '../src/source-cache/credentials.js'
import { bundleKey, pointerKey, type SourceCacheObjectKey } from '../src/source-cache/keys.js'
import {
  addressFor,
  createPresigner,
  redactPresignedUrl,
  type SourceCachePresignerConfig
} from '../src/source-cache/presigner.js'
import { presign } from '../src/source-cache/sigv4.js'

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0, 500)
const CREDS: SourceCacheCredentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }
const KEY = bundleKey({
  org: 'org_1',
  class: 'cred',
  repo: 'github:42',
  id: '3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c'
})
const CHECKSUM = createHash('sha256').update('bundle').digest('base64')

function provider(creds: SourceCacheCredentials = CREDS, seen: number[] = []): CredentialsProvider {
  return {
    source: 'static',
    get: async (minValidityMs) => {
      seen.push(minValidityMs)
      return creds
    }
  }
}

function config(overrides: Partial<SourceCachePresignerConfig> = {}): SourceCachePresignerConfig {
  return {
    region: 'us-east-1',
    bucket: 'ac-cache',
    prefix: '',
    forcePathStyle: false,
    limits: { getUrlSeconds: 300, putUrlSeconds: 900, maxBundleBytes: 2 * 1024 ** 3 },
    ...overrides
  }
}

describe('Source Cache presigner', () => {
  it('presigns a GET for five minutes over host alone', async () => {
    const seen: number[] = []
    const signer = createPresigner({ config: config(), credentials: provider(CREDS, seen), now: () => NOW })
    const get = await signer.presignGet(KEY)
    const url = new URL(get.url)
    expect(get.method).toBe('GET')
    expect(get.headers).toEqual({})
    expect(url.host).toBe('ac-cache.s3.us-east-1.amazonaws.com')
    expect(url.pathname).toBe('/src/org_1/cred/github%3A42/bundles/3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c.bundle')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261003T120000Z')
    expect(get.expiresAt).toBe(Date.UTC(2026, 9, 3, 12, 5, 0))
    expect(seen).toEqual([(300 + 300) * 1000])
  })

  it('presigns a PUT for fifteen minutes with length, checksum and tag as signed headers only', async () => {
    const seen: number[] = []
    const signer = createPresigner({ config: config(), credentials: provider(CREDS, seen), now: () => NOW })
    const put = await signer.presignPut(KEY, { contentLength: 6, checksumSha256: CHECKSUM })
    const url = new URL(put.url)
    expect(put.method).toBe('PUT')
    expect(put.headers).toEqual({
      'content-length': '6',
      'x-amz-checksum-sha256': CHECKSUM,
      'x-amz-tagging': 'ac-cache=pending'
    })
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host;x-amz-checksum-sha256;x-amz-tagging')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    for (const name of url.searchParams.keys()) {
      expect(name.toLowerCase()).not.toMatch(/checksum|tagging|content-length/)
    }
    expect(put.expiresAt).toBe(Date.UTC(2026, 9, 3, 12, 15, 0))
    expect(seen).toEqual([(900 + 300) * 1000])
    // An independent recomputation through the low-level core yields the same URL.
    const expected = presign({
      method: 'PUT',
      protocol: 'https:',
      host: 'ac-cache.s3.us-east-1.amazonaws.com',
      path: `/${KEY}`,
      headers: put.headers,
      credentials: CREDS,
      region: 'us-east-1',
      datetime: '20261003T120000Z',
      expiresSeconds: 900
    })
    expect(put.url).toBe(expected.url)
  })

  it('carries a session token as X-Amz-Security-Token', async () => {
    const signer = createPresigner({
      config: config(),
      credentials: provider({ ...CREDS, sessionToken: 'FwoG+token/=' }),
      now: () => NOW
    })
    const url = new URL((await signer.presignGet(KEY)).url)
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('FwoG+token/=')
  })

  it('addresses virtual-hosted by default and path-style when forced or when TLS naming requires it', () => {
    expect(addressFor('https://s3.us-east-1.amazonaws.com', 'ac-cache', false)).toEqual({
      protocol: 'https:',
      host: 'ac-cache.s3.us-east-1.amazonaws.com',
      basePath: '/',
      style: 'virtual'
    })
    expect(addressFor('https://minio.example.test', 'ac-cache', true)).toMatchObject({
      host: 'minio.example.test',
      basePath: '/ac-cache/',
      style: 'path'
    })
    expect(addressFor('https://s3.us-east-1.amazonaws.com', 'ac.cache', false).style).toBe('path')
    expect(addressFor('https://10.0.0.5:9000', 'ac-cache', false)).toMatchObject({
      host: '10.0.0.5:9000',
      style: 'path'
    })
    expect(addressFor('https://[::1]:9000', 'ac-cache', false)).toMatchObject({ host: '[::1]:9000', style: 'path' })
    expect(addressFor('https://localhost:9000', 'ac-cache', false).style).toBe('path')
    expect(addressFor('https://minio.example.test:9443', 'ac-cache', false).host).toBe(
      'ac-cache.minio.example.test:9443'
    )
    expect(addressFor('https://minio.example.test:443', 'ac-cache', true).host).toBe('minio.example.test')
  })

  it('prepends the configured prefix and signs the encoded path-style URL', async () => {
    const signer = createPresigner({
      config: config({ endpoint: 'https://minio.example.test', prefix: 'agentconnect/prod', forcePathStyle: true }),
      credentials: provider(),
      now: () => NOW
    })
    const url = new URL((await signer.presignGet(KEY)).url)
    expect(url.origin).toBe('https://minio.example.test')
    expect(url.pathname).toBe(
      '/ac-cache/agentconnect/prod/src/org_1/cred/github%3A42/bundles/3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c.bundle'
    )
  })

  it('refuses a key outside src/ and malformed upload declarations', async () => {
    const signer = createPresigner({ config: config(), credentials: provider(), now: () => NOW })
    await expect(signer.presignGet('snapshots/org_1/x' as SourceCacheObjectKey)).rejects.toThrow('src/')
    await expect(signer.presignGet('src/../snapshots/x' as SourceCacheObjectKey)).rejects.toThrow('src/')
    for (const contentLength of [0, -1, 1.5, 2 * 1024 ** 3 + 1, Number.NaN]) {
      await expect(signer.presignPut(KEY, { contentLength, checksumSha256: CHECKSUM })).rejects.toThrow('length')
    }
    for (const checksumSha256 of [
      '',
      'abc',
      createHash('sha1').update('x').digest('base64'),
      CHECKSUM.slice(0, -1) + '!'
    ]) {
      await expect(signer.presignPut(KEY, { contentLength: 1, checksumSha256 })).rejects.toThrow('checksum')
    }
  })

  it('refuses a pointer key for GET and PUT: pointers are store rows, never objects', async () => {
    const signer = createPresigner({ config: config(), credentials: provider(), now: () => NOW })
    const pointer = pointerKey({
      org: 'org_1',
      class: 'cred',
      repo: 'github:42',
      ref: 'refs/heads/main',
      shape: 'full'
    })
    await expect(signer.presignGet(pointer)).rejects.toThrow('bundle key')
    await expect(signer.presignPut(pointer, { contentLength: 1, checksumSha256: CHECKSUM })).rejects.toThrow(
      'bundle key'
    )
  })

  it('rejects when credentials cannot be had, which callers treat as a miss', async () => {
    const signer = createPresigner({
      config: config(),
      credentials: { source: 'webIdentity', get: async () => Promise.reject(new Error('sts down')) },
      now: () => NOW
    })
    await expect(signer.presignGet(KEY)).rejects.toThrow('sts down')
  })

  it('redacts a presigned URL to its origin and path', async () => {
    const signer = createPresigner({ config: config(), credentials: provider(), now: () => NOW })
    const redacted = redactPresignedUrl((await signer.presignGet(KEY)).url)
    expect(redacted).not.toContain('X-Amz')
    expect(redacted).toMatch(/^https:\/\/ac-cache\.s3\.us-east-1\.amazonaws\.com\/src\//)
  })
})
