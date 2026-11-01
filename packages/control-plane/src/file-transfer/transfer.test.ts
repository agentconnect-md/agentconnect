import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { compositeSha256, type CredentialsProvider, type SourceCacheObjectHead } from '@agentconnect.md/object-store'
import { FileTransferConfigSchema, type FileTransferConfig } from './config.js'
import {
  attachmentDisposition,
  createFileTransfer,
  FileTransferError,
  isTransferObjectKey,
  PART_URL_BATCH,
  sharedImageKey,
  transferDownloadKey,
  transferUploadKey
} from './transfer.js'

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)
const ORG = 'org_1'
const UPLOAD_ID = '3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c'
const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT = '44444444-4444-4444-8444-444444444444'
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

const MIB = 1024 * 1024

function transfer(
  head: SourceCacheObjectHead,
  opts: { enabled?: boolean; multipart?: boolean; cfg?: FileTransferConfig; started?: string[] } = {}
) {
  return createFileTransfer({
    config: opts.cfg ?? config({ publicEndpoint: 'https://store.example.test' }),
    credentials,
    objects: {
      head: async () => head,
      createMultipartUpload: async (key, tagging) => {
        opts.started?.push(`${key} ${tagging}`)
        return 'mp-1'
      }
    },
    enabled: () => opts.enabled ?? true,
    multipart: () => opts.multipart ?? true,
    now: () => NOW
  })
}

/** `count` distinct part digests. */
function digests(count: number): string[] {
  return Array.from({ length: count }, (_, i) => createHash('sha256').update(`part ${i}`).digest('base64'))
}

describe('transfer keys', () => {
  it('builds agent-bound upload and org-scoped download keys under src/<org>/transfer/', () => {
    const up = transferUploadKey(ORG, AGENT, UPLOAD_ID)
    expect(up).toBe(`src/${ORG}/transfer/up/${AGENT}/${UPLOAD_ID}`)
    expect(isTransferObjectKey(up)).toBe(true)
    expect(transferUploadKey(ORG, OTHER_AGENT, UPLOAD_ID)).not.toBe(up)
    const dl = transferDownloadKey(ORG, ['agent', null, null, 'a.bin', 5, 'mtime'])
    expect(dl).toMatch(/^src\/org_1\/transfer\/dl\/[0-9a-f]{64}$/)
    expect(transferDownloadKey(ORG, ['agent', null, null, 'a.bin', 6, 'mtime'])).not.toBe(dl)
    expect(isTransferObjectKey(dl)).toBe(true)
    expect(isTransferObjectKey(`src/${ORG}/cred/github:1/bundles/${UPLOAD_ID}.bundle`)).toBe(false)
  })

  it('refuses an org or upload id that could leave its prefix', () => {
    expect(() => transferUploadKey('../x', AGENT, UPLOAD_ID)).toThrow()
    expect(() => transferUploadKey(ORG, AGENT, '../../etc')).toThrow()
    expect(() => transferUploadKey(ORG, '..', UPLOAD_ID)).toThrow()
  })

  it('writes an RFC 6266 disposition with an ASCII fallback', () => {
    expect(attachmentDisposition('résumé "v2".pdf')).toBe(
      `attachment; filename="r_sum_ _v2_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22.pdf`
    )
  })
})

describe('file transfer signing', () => {
  it('presigns the browser PUT on the public endpoint with the exact length, checksum and pending tag', async () => {
    const grant = await transfer({ exists: false }).grantUpload({ org: ORG, agentId: AGENT, size: 5, sha256: SHA })
    const url = new URL(grant.url)
    expect(url.host).toBe('store.example.test')
    expect(url.pathname).toMatch(new RegExp(`^/ac-cache/src/${ORG}/transfer/up/${AGENT}/[0-9a-f-]{36}$`))
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
    await expect(capped.grantUpload({ org: ORG, agentId: AGENT, size: 5, sha256: SHA })).rejects.toMatchObject({
      reason: 'too-large'
    })
    const off = transfer({ exists: false }, { enabled: false })
    await expect(off.grantUpload({ org: ORG, agentId: AGENT, size: 5, sha256: SHA })).rejects.toBeInstanceOf(
      FileTransferError
    )
  })

  it('hands the agent a GET on the network it is on, only for the bytes that were declared', async () => {
    const landed = transfer({ exists: true, contentLength: 5, checksumSha256: SHA })
    const pod = await landed.uploadedFileUrl({
      org: ORG,
      agentId: AGENT,
      uploadId: UPLOAD_ID,
      size: 5,
      sha256: SHA,
      network: 'cluster'
    })
    expect(new URL(pod!.url).host).toBe('store.internal.example.test')
    expect(pod!.expiresAt).toBe(NOW + 1800_000)
    const local = await landed.uploadedFileUrl({
      org: ORG,
      agentId: AGENT,
      uploadId: UPLOAD_ID,
      size: 5,
      sha256: SHA,
      network: 'public'
    })
    expect(new URL(local!.url).host).toBe('store.example.test')

    const missing = transfer({ exists: false })
    expect(
      await missing.uploadedFileUrl({
        org: ORG,
        agentId: AGENT,
        uploadId: UPLOAD_ID,
        size: 5,
        sha256: SHA,
        network: 'public'
      })
    ).toBeUndefined()
    const other = createHash('sha256').update('other').digest('base64')
    const swapped = transfer({ exists: true, contentLength: 5, checksumSha256: other })
    expect(
      await swapped.uploadedFileUrl({
        org: ORG,
        agentId: AGENT,
        uploadId: UPLOAD_ID,
        size: 5,
        sha256: SHA,
        network: 'public'
      })
    ).toBeUndefined()
  })

  it('hands the agent a GET when a proxy drops the length from the HEAD but the checksum proves the bytes', async () => {
    const input = { org: ORG, agentId: AGENT, uploadId: UPLOAD_ID, size: 5, sha256: SHA, network: 'public' as const }
    expect(await transfer({ exists: true, checksumSha256: SHA }).uploadedFileUrl(input)).toBeDefined()
    expect(await transfer({ exists: true }).uploadedFileUrl(input)).toBeUndefined()
  })

  it('hands the agent a GET for a multipart upload whose composite checksum the store reports', async () => {
    const input = { org: ORG, agentId: AGENT, uploadId: UPLOAD_ID, size: 5, sha256: SHA, network: 'public' as const }
    expect(await transfer({ exists: true, checksumSha256: `${SHA}-3` }).uploadedFileUrl(input)).toBeDefined()
    expect(await transfer({ exists: true, checksumSha256: `${SHA}-x` }).uploadedFileUrl(input)).toBeUndefined()
    expect(await transfer({ exists: true, checksumSha256: `${SHA}3` }).uploadedFileUrl(input)).toBeUndefined()
  })

  it('signs no GET for an upload reserved for another agent', async () => {
    const heads: string[] = []
    const store = createFileTransfer({
      config: config({ publicEndpoint: 'https://store.example.test' }),
      credentials,
      objects: {
        head: async (key) => {
          heads.push(key)
          return key === transferUploadKey(ORG, AGENT, UPLOAD_ID)
            ? { exists: true, contentLength: 5, checksumSha256: SHA }
            : { exists: false }
        },
        createMultipartUpload: async () => 'mp-1'
      },
      enabled: () => true,
      now: () => NOW
    })
    const input = { org: ORG, uploadId: UPLOAD_ID, size: 5, sha256: SHA, network: 'public' as const }
    expect(await store.uploadedFileUrl({ ...input, agentId: OTHER_AGENT })).toBeUndefined()
    expect(heads).toEqual([transferUploadKey(ORG, OTHER_AGENT, UPLOAD_ID)])
    const own = await store.uploadedFileUrl({ ...input, agentId: AGENT })
    expect(new URL(own!.url).pathname).toBe(`/ac-cache/src/${ORG}/transfer/up/${AGENT}/${UPLOAD_ID}`)
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

describe('multipart browser uploads', () => {
  const cfg = config({ publicEndpoint: 'https://store.example.test', limits: { partBytes: '8Mi' } })

  it('publishes the part size only while the bucket reaps unfinished uploads, and caps by part count', () => {
    expect(transfer({ exists: false }, { cfg }).uploadLimits()).toEqual({
      maxBytes: 10_000 * 8 * MIB,
      partBytes: 8 * MIB
    })
    expect(transfer({ exists: false }, { cfg, multipart: false }).uploadLimits()).toEqual({ maxBytes: 8 * MIB })
    const capped = config({ limits: { partBytes: '8Mi', maxBytes: '1Gi' } })
    expect(transfer({ exists: false }, { cfg: capped }).uploadLimits()).toEqual({
      maxBytes: 1024 * MIB,
      partBytes: 8 * MIB
    })
  })

  it('starts a tagged multipart upload and signs each part’s exact length and checksum, then the complete', async () => {
    const started: string[] = []
    const parts = digests(3)
    const size = 2 * 6 * MIB + 7
    const grant = await transfer({ exists: false }, { cfg, started }).grantMultipartUpload({
      org: ORG,
      agentId: AGENT,
      sha256: compositeSha256(parts),
      layout: { size, partBytes: 6 * MIB, parts }
    })
    expect(started).toEqual([`src/${ORG}/transfer/up/${AGENT}/${grant.uploadId} ac-cache=pending`])
    expect(grant.multipartId).toBe('mp-1')
    expect(grant.parts.map((p) => [p.partNumber, p.headers])).toEqual([
      [1, { 'content-length': String(6 * MIB), 'x-amz-checksum-sha256': parts[0] }],
      [2, { 'content-length': String(6 * MIB), 'x-amz-checksum-sha256': parts[1] }],
      [3, { 'content-length': '7', 'x-amz-checksum-sha256': parts[2] }]
    ])
    const part = new URL(grant.parts[2]!.url)
    expect(part.host).toBe('store.example.test')
    expect(part.pathname).toBe(`/ac-cache/src/${ORG}/transfer/up/${AGENT}/${grant.uploadId}`)
    expect(part.searchParams.get('partNumber')).toBe('3')
    expect(part.searchParams.get('uploadId')).toBe('mp-1')
    expect(part.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host;x-amz-checksum-sha256')
    const complete = new URL(grant.complete.url)
    expect(complete.searchParams.get('uploadId')).toBe('mp-1')
    expect(complete.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(grant.expiresAt).toBe(NOW + 900_000)
  })

  it('signs the first batch of parts and the rest on request', async () => {
    const parts = digests(PART_URL_BATCH + 2)
    const size = parts.length * 5 * MIB
    const store = transfer({ exists: false }, { cfg })
    const grant = await store.grantMultipartUpload({
      org: ORG,
      agentId: AGENT,
      sha256: compositeSha256(parts),
      layout: { size, partBytes: 5 * MIB, parts }
    })
    expect(grant.parts).toHaveLength(PART_URL_BATCH)
    const more = await store.signParts({
      org: ORG,
      agentId: AGENT,
      uploadId: grant.uploadId,
      multipartId: grant.multipartId,
      size,
      partBytes: 5 * MIB,
      parts: [{ partNumber: PART_URL_BATCH + 2, sha256: parts[PART_URL_BATCH + 1]! }]
    })
    expect(more.parts.map((p) => p.partNumber)).toEqual([PART_URL_BATCH + 2])
    expect(new URL(more.complete.url).searchParams.get('uploadId')).toBe('mp-1')
  })

  it('refuses a layout that does not describe the file, or parts the deployment cannot take', async () => {
    const parts = digests(2)
    const grant = (over: { sha256?: string; partBytes?: number; size?: number; multipart?: boolean }) =>
      transfer({ exists: false }, { cfg, multipart: over.multipart ?? true }).grantMultipartUpload({
        org: ORG,
        agentId: AGENT,
        sha256: over.sha256 ?? compositeSha256(parts),
        layout: { size: over.size ?? 10 * MIB, partBytes: over.partBytes ?? 5 * MIB, parts }
      })
    await expect(grant({ sha256: SHA })).rejects.toMatchObject({ reason: 'invalid' })
    await expect(grant({ size: 15 * MIB })).rejects.toMatchObject({ reason: 'invalid' })
    await expect(grant({ partBytes: 4 * MIB, size: 8 * MIB })).rejects.toMatchObject({ reason: 'too-large' })
    await expect(grant({ partBytes: 9 * MIB, size: 18 * MIB })).rejects.toMatchObject({ reason: 'too-large' })
    await expect(grant({ multipart: false })).rejects.toMatchObject({ reason: 'transfer-unavailable' })
    const store = transfer({ exists: false }, { cfg })
    const sign = (partNumber: number) =>
      store.signParts({
        org: ORG,
        agentId: AGENT,
        uploadId: UPLOAD_ID,
        multipartId: 'mp-1',
        size: 10 * MIB,
        partBytes: 5 * MIB,
        parts: [{ partNumber, sha256: SHA }]
      })
    await expect(sign(3)).rejects.toMatchObject({ reason: 'invalid' })
    await expect(sign(0)).rejects.toMatchObject({ reason: 'invalid' })
  })
})

describe('shared-image originals', () => {
  const AGENT = '11111111-1111-4111-8111-111111111111'
  const ATTACHMENT = '22222222-2222-4222-8222-222222222222'

  it('keys an original under the transfer prefix, so the pending lifecycle collects it', () => {
    const key = sharedImageKey(ORG, AGENT, ATTACHMENT)
    expect(key).toBe(`src/${ORG}/transfer/img/${AGENT}/${ATTACHMENT}`)
    expect(isTransferObjectKey(key)).toBe(true)
    expect(() => sharedImageKey(ORG, '../x', ATTACHMENT)).toThrow()
    expect(() => sharedImageKey(ORG, AGENT, 'ATTACH')).toThrow()
    expect(() => sharedImageKey('../o', AGENT, ATTACHMENT)).toThrow()
  })

  it('signs a GET while the object holds exactly those bytes, however old it is', async () => {
    const key = sharedImageKey(ORG, AGENT, ATTACHMENT)
    const old = { exists: true as const, contentLength: 5, checksumSha256: SHA, lastModified: NOW - 3 * 86_400_000 }
    const get = await transfer(old).storedDownload({ key, size: 5, sha256: SHA, name: 'chart.png' })
    expect(new URL(get!.url).host).toBe('store.example.test')
    expect(new URL(get!.url).searchParams.get('response-content-disposition')).toBe(attachmentDisposition('chart.png'))
    expect(
      await transfer({ exists: false }).storedDownload({ key, size: 5, sha256: SHA, name: 'a.png' })
    ).toBeUndefined()
    expect(await transfer(old).storedDownload({ key, size: 6, sha256: SHA, name: 'a.png' })).toBeUndefined()
    const other = createHash('sha256').update('other').digest('base64')
    expect(await transfer(old).storedDownload({ key, size: 5, sha256: other, name: 'a.png' })).toBeUndefined()
  })
})

describe('transfer config', () => {
  it('defaults to no cap, a 512Mi part and a 30m link, and validates the public endpoint and part size', () => {
    const cfg = config()
    expect(cfg.limits.maxBytes).toBeUndefined()
    expect(cfg.limits.partBytes).toBe(512 * 1024 * 1024)
    expect(() => config({ limits: { partBytes: '4Mi' } })).toThrow()
    expect(() => config({ limits: { partBytes: '6Gi' } })).toThrow()
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
