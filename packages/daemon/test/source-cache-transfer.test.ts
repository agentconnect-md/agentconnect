import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SourceCacheConfigSchema, type SourceCacheConfig } from '../src/source-cache/config.js'
import type { CredentialsProvider } from '../src/source-cache/credentials.js'
import type { SourceCacheObjectClient, SourceCacheObjectHead } from '../src/source-cache/object-client.js'
import {
  attachmentDisposition,
  createFileTransfer,
  FileTransferError,
  isTransferObjectKey,
  transferDownloadKey,
  transferUploadKey
} from '../src/source-cache/transfer.js'

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)
const ORG = 'org_1'
const UPLOAD_ID = '3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c'
const SHA = createHash('sha256').update('hello').digest('base64')

const credentials: CredentialsProvider = {
  source: 'static',
  get: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' })
}

function config(overrides: Record<string, unknown> = {}): SourceCacheConfig {
  return SourceCacheConfigSchema.parse({
    version: 1,
    endpoint: 'https://store.internal.example.test',
    region: 'us-east-1',
    bucket: 'ac-cache',
    forcePathStyle: true,
    credentials: { source: 'static', dir: '/creds', accessKeyIdKey: 'id', secretAccessKeyKey: 'secret' },
    ...overrides
  })
}

function objects(head: SourceCacheObjectHead, heads: string[] = []): SourceCacheObjectClient {
  return {
    head: async (key) => {
      heads.push(key)
      return head
    },
    putTagging: async () => undefined,
    delete: async () => undefined,
    getBucketLifecycle: async () => ({ kind: 'none' })
  }
}

function transfer(
  head: SourceCacheObjectHead,
  opts: { enabled?: boolean; cfg?: SourceCacheConfig; heads?: string[] } = {}
) {
  return createFileTransfer({
    config: opts.cfg ?? config({ publicEndpoint: 'https://store.example.test' }),
    credentials,
    objects: objects(head, opts.heads),
    enabled: () => opts.enabled ?? true,
    now: () => NOW
  })
}

describe('transfer keys', () => {
  it('builds org-scoped upload and download keys under src/<org>/transfer/', () => {
    expect(transferUploadKey(ORG, UPLOAD_ID)).toBe(`src/${ORG}/transfer/up/${UPLOAD_ID}`)
    const dl = transferDownloadKey(ORG, ['agent', null, null, 'a.bin', 5, 'mtime'])
    expect(dl).toMatch(/^src\/org_1\/transfer\/dl\/[0-9a-f]{64}$/)
    expect(transferDownloadKey(ORG, ['agent', null, null, 'a.bin', 6, 'mtime'])).not.toBe(dl)
    expect(isTransferObjectKey(dl)).toBe(true)
    expect(isTransferObjectKey(`src/${ORG}/cred/github:1/bundles/${UPLOAD_ID}.bundle`)).toBe(false)
  })

  it('refuses an org or upload id that could leave its prefix', () => {
    expect(() => transferUploadKey('../x', UPLOAD_ID)).toThrow()
    expect(() => transferUploadKey(ORG, '../../etc')).toThrow()
  })

  it('writes an RFC 6266 disposition with an ASCII fallback', () => {
    expect(attachmentDisposition('résumé "v2".pdf')).toBe(
      `attachment; filename="r_sum_ _v2_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22.pdf`
    )
  })
})

describe('file transfer', () => {
  it('presigns the browser PUT on the public endpoint with the exact length, checksum and pending tag', async () => {
    const grant = await transfer({ exists: false }).grantUpload({ org: ORG, size: 5, sha256: SHA })
    const url = new URL(grant.url)
    expect(url.host).toBe('store.example.test')
    expect(url.pathname).toMatch(new RegExp(`^/ac-cache/src/${ORG}/transfer/up/[0-9a-f-]{36}$`))
    expect(url.pathname.endsWith(grant.uploadId)).toBe(true)
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host;x-amz-checksum-sha256;x-amz-tagging')
    expect(grant.headers).toEqual({
      'content-length': '5',
      'x-amz-checksum-sha256': SHA,
      'x-amz-tagging': 'ac-cache=pending'
    })
    expect(grant.expiresAt).toBe(NOW + 900_000)
  })

  it('refuses an upload over the cap, and any transfer while the lifecycle rules are missing', async () => {
    const capped = transfer({ exists: false }, { cfg: config({ limits: { transferMaxBytes: 4 } }) })
    await expect(capped.grantUpload({ org: ORG, size: 5, sha256: SHA })).rejects.toMatchObject({ reason: 'too-large' })
    const off = transfer({ exists: false }, { enabled: false })
    await expect(off.grantUpload({ org: ORG, size: 5, sha256: SHA })).rejects.toBeInstanceOf(FileTransferError)
  })

  it('hands the agent an internal-endpoint GET only for the bytes that were declared', async () => {
    const landed = transfer({ exists: true, contentLength: 5, checksumSha256: SHA })
    const get = await landed.uploadedFileUrl({ org: ORG, uploadId: UPLOAD_ID, size: 5, sha256: SHA })
    expect(new URL(get!.url).host).toBe('store.internal.example.test')
    expect(get!.expiresAt).toBe(NOW + 1800_000)

    expect(
      await transfer({ exists: false }).uploadedFileUrl({ org: ORG, uploadId: UPLOAD_ID, size: 5, sha256: SHA })
    ).toBeUndefined()
    const other = createHash('sha256').update('other').digest('base64')
    expect(
      await transfer({ exists: true, contentLength: 5, checksumSha256: other }).uploadedFileUrl({
        org: ORG,
        uploadId: UPLOAD_ID,
        size: 5,
        sha256: SHA
      })
    ).toBeUndefined()
  })

  it('reuses a recent copy of the same revision and uploads otherwise', async () => {
    const identity = ['agent', null, null, 'dist/app.bin', 5, 'mtime']
    const signedPuts: Array<{ url: string; headers: Record<string, string> }> = []
    const upload = async (
      put: (file: { bytes: number; sha256: string }) => Promise<{ url: string; headers: Record<string, string> }>
    ) => {
      signedPuts.push(await put({ bytes: 5, sha256: SHA }))
      return { bytes: 5, sha256: SHA }
    }

    const cached = await transfer({
      exists: true,
      contentLength: 5,
      checksumSha256: SHA,
      lastModified: NOW - 60_000
    }).workspaceFileUrl({
      org: ORG,
      identity,
      name: 'app.bin',
      size: 5,
      upload
    })
    expect(cached.cached).toBe(true)
    expect(cached.sha256).toBe(SHA)
    expect(signedPuts).toHaveLength(0)
    const get = new URL(cached.url)
    expect(get.host).toBe('store.example.test')
    expect(get.searchParams.get('response-content-disposition')).toBe(attachmentDisposition('app.bin'))
    expect(get.searchParams.get('response-content-type')).toBe('application/octet-stream')

    const stale = await transfer({
      exists: true,
      contentLength: 5,
      lastModified: NOW - 2 * 86_400_000
    }).workspaceFileUrl({
      org: ORG,
      identity,
      name: 'app.bin',
      size: 5,
      upload
    })
    expect(stale.cached).toBe(false)
    expect(stale.sha256).toBe(SHA)
    expect(signedPuts).toHaveLength(1)
    // The pod uploads in-cluster, so its PUT names the internal endpoint.
    expect(new URL(signedPuts[0]!.url).host).toBe('store.internal.example.test')
    expect(signedPuts[0]!.headers['content-length']).toBe('5')
  })

  it('replaces a recent copy whose checksum the store does not report, since its bytes are unproven', async () => {
    let uploads = 0
    const grant = await transfer({ exists: true, contentLength: 5, lastModified: NOW - 60_000 }).workspaceFileUrl({
      org: ORG,
      identity: ['a'],
      name: 'a.bin',
      size: 5,
      upload: async (put) => {
        uploads++
        await put({ bytes: 5, sha256: SHA })
        return { bytes: 5, sha256: SHA }
      }
    })
    expect(uploads).toBe(1)
    expect(grant).toMatchObject({ cached: false, sha256: SHA })
  })

  it('refuses a file that changed size during its upload', async () => {
    const run = transfer({ exists: false }).workspaceFileUrl({
      org: ORG,
      identity: ['a'],
      name: 'a.bin',
      size: 5,
      upload: async (put) => {
        await put({ bytes: 6, sha256: SHA })
        return { bytes: 6, sha256: SHA }
      }
    })
    await expect(run).rejects.toMatchObject({ reason: 'stale' })
  })
})

describe('transfer config', () => {
  it('defaults the cap and link lifetime and validates the public endpoint', () => {
    const cfg = config()
    expect(cfg.limits.transferMaxBytes).toBe(512 * 1024 * 1024)
    expect(cfg.limits.transferUrlSeconds).toBe(1800)
    expect(() => config({ publicEndpoint: 'http://store.example.test' })).toThrow()
    expect(() => config({ limits: { transferUrlSeconds: '13h' } })).toThrow()
  })
})
