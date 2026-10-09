import type { WorkspaceReadContent, WorkspaceUploadReq } from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import { createFileTransferService, FileTransferRefusal, type FileTransferControl } from './service.js'
import { FileTransferError, type FileTransfer } from './transfer.js'

const SHA = Buffer.alloc(32, 3).toString('base64')
const MTIME = '2026-10-09T00:00:00.000Z'

function signer(cached?: string, seen: unknown[] = []): FileTransfer {
  return {
    enabled: () => true,
    maxBytes: 100,
    grantUpload: async () => ({ uploadId: 'u', url: 'https://store.example.test/u', headers: {}, expiresAt: 1 }),
    uploadedFileUrl: async () => undefined,
    cachedDownload: async (input) => {
      seen.push({ cachedDownload: input })
      return cached
    },
    signPut: async (input) => {
      seen.push({ signPut: input })
      return { url: 'https://store.example.test/p', headers: { 'content-length': String(input.bytes) }, expiresAt: 1 }
    },
    signDownload: async (input) => {
      seen.push({ signDownload: input })
      return { url: 'https://store.example.test/g', headers: {}, expiresAt: 2 }
    }
  }
}

function control(
  stat: Partial<WorkspaceReadContent> & { exists: boolean },
  upload: (req: WorkspaceUploadReq) => Promise<{ bytes: number; sha256: string }>
): FileTransferControl & { uploads: WorkspaceUploadReq[] } {
  const uploads: WorkspaceUploadReq[] = []
  return {
    uploads,
    workspaceRead: async (_daemonId, req) =>
      ({ agentId: req.agentId, path: req.path, ...stat }) as WorkspaceReadContent,
    workspaceUpload: async (_daemonId, req) => {
      uploads.push(req)
      return await upload(req)
    }
  }
}

const target = { orgId: 'org_1', daemonId: 'd1', agentId: 'a1', sessionId: 's1', path: 'dist/app.bin' }
const file = { exists: true, type: 'file' as const, size: 9, mtime: MTIME }

describe('file transfer service', () => {
  it('answers a recent copy without asking the daemon to upload', async () => {
    const seen: unknown[] = []
    const daemon = control(file, async () => {
      throw new Error('no upload expected')
    })
    const service = createFileTransferService({ transfer: signer(SHA, seen), control: daemon })
    const got = await service.workspaceDownload(target)
    expect(got).toEqual({
      path: 'dist/app.bin',
      size: 9,
      url: 'https://store.example.test/g',
      expiresAt: 2,
      sha256: SHA,
      cached: true
    })
    expect(daemon.uploads).toEqual([])
    expect(seen.at(-1)).toEqual({ signDownload: expect.objectContaining({ name: 'app.bin' }) })
  })

  it('signs the PUT only for the daemon and revision its ticket names, then never again', async () => {
    const seen: unknown[] = []
    const late: { service?: ReturnType<typeof createFileTransferService> } = {}
    const daemon = control(file, async (req) => {
      expect(req.revision).toEqual({ size: 9, mtime: MTIME })
      const service = late.service!
      // Another daemon, or a snapshot of another length, gets no signature.
      await expect(
        service.signUpload('d2', { ticket: req.ticket, bytes: 9, sha256: SHA, network: 'public' })
      ).rejects.toMatchObject({
        code: 'WORKSPACE_TRANSFER_UNAVAILABLE'
      })
      await expect(
        service.signUpload('d1', { ticket: req.ticket, bytes: 8, sha256: SHA, network: 'public' })
      ).rejects.toMatchObject({
        code: 'WORKSPACE_STALE'
      })
      const put = await service.signUpload('d1', { ticket: req.ticket, bytes: 9, sha256: SHA, network: 'cluster' })
      expect(put.headers).toEqual({ 'content-length': '9' })
      return { bytes: 9, sha256: SHA }
    })
    const service = createFileTransferService({ transfer: signer(undefined, seen), control: daemon })
    late.service = service
    const got = await service.workspaceDownload(target)
    expect(got).toMatchObject({ sha256: SHA, cached: false })
    expect(seen).toContainEqual({ signPut: expect.objectContaining({ bytes: 9, network: 'cluster' }) })
    const ticket = daemon.uploads[0]!.ticket
    await expect(service.signUpload('d1', { ticket, bytes: 9, sha256: SHA, network: 'public' })).rejects.toBeInstanceOf(
      FileTransferRefusal
    )
  })

  it('refuses a missing file, a directory, an empty file, a size change and the signer’s own refusals', async () => {
    const upload = async () => ({ bytes: 9, sha256: SHA })
    const download = (stat: Parameters<typeof control>[0], transfer: FileTransfer = signer()) =>
      createFileTransferService({ transfer, control: control(stat, upload) }).workspaceDownload(target)
    await expect(download({ exists: false })).rejects.toMatchObject({ status: 404, code: 'WORKSPACE_NOT_FOUND' })
    await expect(download({ exists: true, type: 'dir' })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_A_FILE' })
    await expect(download({ ...file, size: 0 })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_A_FILE' })
    await expect(
      createFileTransferService({
        transfer: signer(),
        control: control(file, async () => ({ bytes: 8, sha256: SHA }))
      }).workspaceDownload(target)
    ).rejects.toMatchObject({ status: 409, code: 'WORKSPACE_STALE' })
    const off = {
      ...signer(),
      cachedDownload: async () => Promise.reject(new FileTransferError('transfer-unavailable', 'x'))
    }
    await expect(download(file, off)).rejects.toMatchObject({ code: 'WORKSPACE_TRANSFER_UNAVAILABLE' })
  })
})
