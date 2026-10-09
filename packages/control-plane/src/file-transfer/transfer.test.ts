import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CredentialsProvider, SourceCacheObjectHead } from '@agentconnect.md/object-store'
import { FileTransferConfigSchema, type FileTransferConfig } from './config.js'
import {
  attachmentDisposition,
  createFileTransfer,
  FileTransferError,
  isTransferObjectKey,
  transferDownloadKey,
  transferUploadKey
} from './transfer.js'

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)
const ORG = 'org_1'
const UPLOAD_ID = '3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c'
const SHA = createHash('sha256').update('hello').digest('base64')

const credentials: CredentialsProvider = {
  source: 'static',
  get: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' })
}

function config(overrides: Record<string, unknown> = {}): FileTransferConfig {
  return FileTransferConfigSchema.parse({
    version: 1,
    endpoint: 'https://store.internal.example.test',
    region: 'us-east-1',
    bucket: 'ac-cache',
    forcePathStyle: true,
    credentials: { source: 'static', dir: '/creds', accessKeyIdKey: 'id', secretAccessKeyKey: 'secret' },
    ...overrides
  })
}

function transfer(head: SourceCacheObjectHead, opts: { enabled?: boolean; cfg?: FileTransferConfig } = {}) {
  return createFileTransfer({
    config: opts.cfg ?? config({ publicEndpoint: 'https://store.example.test' }),
    credentials,
    objects: { head: async () => head },
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

describe('file transfer signing', () => {
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
    const capped = transfer({ exists: false }, { cfg: config({ limits: { maxBytes: 4 } }) })
    await expect(capped.grantUpload({ org: ORG, size: 5, sha256: SHA })).rejects.toMatchObject({ reason: 'too-large' })
    const off = transfer({ exists: false }, { enabled: false })
    await expect(off.grantUpload({ org: ORG, size: 5, sha256: SHA })).rejects.toBeInstanceOf(FileTransferError)
  })

  it('hands the agent a GET on the network it is on, only for the bytes that were declared', async () => {
    const landed = transfer({ exists: true, contentLength: 5, checksumSha256: SHA })
    const pod = await landed.uploadedFileUrl({
      org: ORG,
      uploadId: UPLOAD_ID,
      size: 5,
      sha256: SHA,
      network: 'cluster'
    })
    expect(new URL(pod!.url).host).toBe('store.internal.example.test')
    expect(pod!.expiresAt).toBe(NOW + 1800_000)
    const local = await landed.uploadedFileUrl({
      org: ORG,
      uploadId: UPLOAD_ID,
      size: 5,
      sha256: SHA,
      network: 'public'
    })
    expect(new URL(local!.url).host).toBe('store.example.test')

    const missing = transfer({ exists: false })
    expect(
      await missing.uploadedFileUrl({ org: ORG, uploadId: UPLOAD_ID, size: 5, sha256: SHA, network: 'public' })
    ).toBeUndefined()
    const other = createHash('sha256').update('other').digest('base64')
    const swapped = transfer({ exists: true, contentLength: 5, checksumSha256: other })
    expect(
      await swapped.uploadedFileUrl({ org: ORG, uploadId: UPLOAD_ID, size: 5, sha256: SHA, network: 'public' })
    ).toBeUndefined()
  })

  it('reuses only a recent copy whose checksum the store reports', async () => {
    const key = transferDownloadKey(ORG, ['agent', null, null, 'dist/app.bin', 5, 'mtime'])
    const recent = { exists: true as const, contentLength: 5, lastModified: NOW - 60_000 }
    expect(await transfer({ ...recent, checksumSha256: SHA }).cachedDownload({ key, size: 5 })).toBe(SHA)
    expect(await transfer(recent).cachedDownload({ key, size: 5 })).toBeUndefined()
    const old = { ...recent, checksumSha256: SHA, lastModified: NOW - 2 * 86_400_000 }
    expect(await transfer(old).cachedDownload({ key, size: 5 })).toBeUndefined()
    expect(await transfer({ ...recent, checksumSha256: SHA }).cachedDownload({ key, size: 6 })).toBeUndefined()
  })

  it('signs a daemon PUT on its network and a browser GET that downloads as an attachment', async () => {
    const key = transferDownloadKey(ORG, ['a'])
    const t = transfer({ exists: false })
    const pod = await t.signPut({ key, bytes: 5, sha256: SHA, network: 'cluster' })
    expect(new URL(pod.url).host).toBe('store.internal.example.test')
    expect(pod.headers['content-length']).toBe('5')
    const local = await t.signPut({ key, bytes: 5, sha256: SHA, network: 'public' })
    expect(new URL(local.url).host).toBe('store.example.test')

    const get = new URL((await t.signDownload({ key, name: 'app.bin' })).url)
    expect(get.host).toBe('store.example.test')
    expect(get.searchParams.get('response-content-disposition')).toBe(attachmentDisposition('app.bin'))
    expect(get.searchParams.get('response-content-type')).toBe('application/octet-stream')
  })
})

describe('transfer config', () => {
  it('defaults the cap and link lifetime and validates the public endpoint', () => {
    const cfg = config()
    expect(cfg.limits.maxBytes).toBe(512 * 1024 * 1024)
    expect(cfg.limits.urlSeconds).toBe(1800)
    expect(() => config({ publicEndpoint: 'http://store.example.test' })).toThrow()
    expect(() => config({ limits: { urlSeconds: '13h' } })).toThrow()
  })

  it('derives a web identity session that outlives the longest link', () => {
    const hour = config({ credentials: { source: 'webIdentity' }, limits: { urlSeconds: '1h' } })
    expect(hour.credentials).toEqual({ source: 'webIdentity', durationSeconds: 3600 + 360 })
    expect(() => config({ credentials: { source: 'webIdentity' }, limits: { urlSeconds: '12h' } })).toThrow(
      /12h session maximum/
    )
  })
})
