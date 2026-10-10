import type { SharedImageResolveReq } from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import { createSharedImageService, SharedImageRefusal } from './shared-image.js'
import { FileTransferError, type FileTransfer } from './transfer.js'

const ORG = 'org_1'
const DAEMON = 'daemon-1'
const AGENT = '11111111-1111-4111-8111-111111111111'
const ATTACHMENT = '22222222-2222-4222-8222-222222222222'
const POST = '33333333-3333-4333-8333-333333333333'
const SHA = Buffer.alloc(32, 3).toString('base64')

function bucket(opts: { enabled?: boolean; stored?: boolean; seen?: unknown[] } = {}): FileTransfer {
  const seen = opts.seen ?? []
  return {
    enabled: () => opts.enabled ?? true,
    maxBytes: 100,
    grantUpload: async () => ({ uploadId: 'u', url: 'https://store.example.test/u', headers: {}, expiresAt: 1 }),
    uploadedFileUrl: async () => undefined,
    cachedDownload: async () => undefined,
    signPut: async (input) => {
      seen.push({ signPut: input })
      if (input.bytes > 100) throw new FileTransferError('too-large', 'too large')
      return { url: 'https://store.example.test/p', headers: { 'content-length': String(input.bytes) }, expiresAt: 1 }
    },
    signDownload: async () => ({ url: 'https://store.example.test/g', headers: {}, expiresAt: 2 }),
    storedDownload: async (input) => {
      seen.push({ storedDownload: input })
      return opts.stored === false ? undefined : { url: 'https://store.example.test/g', headers: {}, expiresAt: 2 }
    }
  }
}

const put = { agentId: AGENT, sessionId: 's-1', postId: POST, attachmentId: ATTACHMENT, bytes: 5, sha256: SHA }
const get = { agentId: AGENT, attachmentId: ATTACHMENT, bytes: 5, sha256: SHA, name: 'chart.png' }

describe('shared-image originals', () => {
  it('signs a PUT under the org-scoped key the attachment names', async () => {
    const seen: unknown[] = []
    const service = createSharedImageService({
      transfer: bucket({ seen }),
      control: { sharedImageResolve: async () => ({ original: { kind: 'inline' } }) }
    })
    expect(await service.signPut(ORG, { ...put, network: 'cluster' })).toEqual({
      url: 'https://store.example.test/p',
      headers: { 'content-length': '5' }
    })
    expect(seen).toEqual([
      { signPut: { key: `src/${ORG}/transfer/img/${AGENT}/${ATTACHMENT}`, bytes: 5, sha256: SHA, network: 'cluster' } }
    ])
  })

  it('refuses a PUT over the transfer limit, without a bucket, or while the bucket is gated', async () => {
    const control = { sharedImageResolve: async () => ({ original: { kind: 'inline' as const } }) }
    await expect(
      createSharedImageService({ transfer: bucket(), control }).signPut(ORG, { ...put, bytes: 101, network: 'public' })
    ).rejects.toMatchObject({ code: 'TOO_LARGE', message: expect.stringContaining('100 bytes') })
    await expect(
      createSharedImageService({ control }).signPut(ORG, { ...put, network: 'public' })
    ).rejects.toMatchObject({
      code: 'SCOPE_DENIED'
    })
    await expect(
      createSharedImageService({ transfer: bucket({ enabled: false }), control }).signPut(ORG, {
        ...put,
        network: 'public'
      })
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true })
  })

  it('signs a GET for a placed daemon, or for one answering an open console resolve of that attachment', async () => {
    const asked: SharedImageResolveReq[] = []
    const answers: unknown[] = []
    const service: ReturnType<typeof createSharedImageService> = createSharedImageService({
      transfer: bucket(),
      control: {
        sharedImageResolve: async (daemonId, orgId, req) => {
          asked.push(req)
          answers.push(await service.signGet(orgId, daemonId, { ...get, resolveId: req.resolveId }, false))
          await expect(
            service.signGet(orgId, 'daemon-2', { ...get, resolveId: req.resolveId }, false)
          ).rejects.toBeInstanceOf(SharedImageRefusal)
          await expect(
            service.signGet(orgId, daemonId, { ...get, agentId: POST, resolveId: req.resolveId }, false)
          ).rejects.toBeInstanceOf(SharedImageRefusal)
          return { original: { kind: 'inline' } }
        }
      }
    })
    expect(await service.signGet(ORG, DAEMON, get, true)).toEqual({ url: 'https://store.example.test/g', expiresAt: 2 })
    await expect(service.signGet(ORG, DAEMON, get, false)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })

    await service.resolve({ orgId: ORG, daemonId: DAEMON, agentId: AGENT, sessionId: 's-1', attachmentId: ATTACHMENT })
    expect(asked).toEqual([
      { agentId: AGENT, sessionId: 's-1', attachmentId: ATTACHMENT, resolveId: expect.any(String) }
    ])
    expect(answers).toEqual([{ url: 'https://store.example.test/g', expiresAt: 2 }])
    // The ticket closes with the read.
    await expect(service.signGet(ORG, DAEMON, { ...get, resolveId: asked[0]!.resolveId }, false)).rejects.toMatchObject(
      {
        code: 'SCOPE_DENIED'
      }
    )
  })

  it('answers missing when the bucket no longer holds the bytes, and expires an abandoned ticket', async () => {
    let now = 0
    let resolveId = ''
    const service = createSharedImageService({
      transfer: bucket({ stored: false }),
      now: () => now,
      control: {
        sharedImageResolve: async (_d, _o, req) => {
          resolveId = req.resolveId
          now += 3 * 60_000
          return { original: { kind: 'inline' } }
        }
      }
    })
    expect(await service.signGet(ORG, DAEMON, get, true)).toEqual({ missing: true })
    await service.resolve({ orgId: ORG, daemonId: DAEMON, agentId: AGENT, sessionId: 's-1', attachmentId: ATTACHMENT })
    await expect(service.signGet(ORG, DAEMON, { ...get, resolveId }, false)).rejects.toBeInstanceOf(SharedImageRefusal)
  })
})
