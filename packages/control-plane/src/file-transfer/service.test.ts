import type { TransferUploadOutcome, WorkspaceReadContent, WorkspaceUploadReq } from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import { ProtocolError } from '../domain/errors.js'
import type { UploadTicketRepo, UploadTicketState } from '../persistence/ports.js'
import {
  createFileTransferService,
  FileTransferRefusal,
  isTransferPending,
  type FileTransferControl,
  type WorkspaceTransferPending
} from './service.js'
import { FileTransferError, type FileTransfer } from './transfer.js'

const SHA = Buffer.alloc(32, 3).toString('base64')
const MTIME = '2026-10-09T00:00:00.000Z'

function signer(cached?: string, seen: unknown[] = []): FileTransfer {
  return {
    enabled: () => true,
    maxBytes: 100,
    grantUpload: async () => ({ uploadId: 'u', url: 'https://store.example.test/u', headers: {}, expiresAt: 1 }),
    uploadedFileUrl: async () => undefined,
    storedDownload: async () => undefined,
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
): FileTransferControl & { uploads: WorkspaceUploadReq[]; begins: WorkspaceUploadReq[] } {
  const uploads: WorkspaceUploadReq[] = []
  const begins: WorkspaceUploadReq[] = []
  return {
    uploads,
    begins,
    workspaceRead: async (_daemonId, req) =>
      ({ agentId: req.agentId, path: req.path, ...stat }) as WorkspaceReadContent,
    workspaceUpload: async (_daemonId, req) => {
      uploads.push(req)
      return await upload(req)
    },
    workspaceUploadBegin: async (_daemonId, req) => {
      begins.push(req)
      return {}
    }
  }
}

// The process-local stand-in for `PgUploadTicketRepo`; `test/repo/upload-ticket.repo.test.ts` covers the shared store.
function memoryTickets(): UploadTicketRepo & { rows: Map<string, UploadTicketState> } {
  const rows = new Map<string, UploadTicketState>()
  return {
    rows,
    open: async (id, ticket) => void rows.set(id, ticket),
    find: async (id, daemonId) => {
      const row = rows.get(id)
      return row?.daemonId === daemonId && !row.outcome ? { objectKey: row.objectKey, size: row.size } : undefined
    },
    pending: async (objectKey, daemonId) =>
      [...rows].find(
        ([, row]) => row.objectKey === objectKey && row.daemonId === daemonId && row.agentId && !row.outcome
      )?.[0],
    settle: async (id, daemonId, outcome) => {
      const row = rows.get(id)
      if (row?.daemonId !== daemonId || row.outcome) return false
      rows.set(id, { ...row, outcome })
      return true
    },
    get: async (id) => rows.get(id),
    close: async (id) => void rows.delete(id)
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
    const service = createFileTransferService({
      transfer: signer(SHA, seen),
      control: daemon,
      tickets: memoryTickets()
    })
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
    const tickets = memoryTickets()
    const service = createFileTransferService({ transfer: signer(undefined, seen), control: daemon, tickets })
    late.service = service
    const got = await service.workspaceDownload(target)
    expect(got).toMatchObject({ sha256: SHA, cached: false })
    expect(seen).toContainEqual({ signPut: expect.objectContaining({ bytes: 9, network: 'cluster' }) })
    const ticket = daemon.uploads[0]!.ticket
    expect(tickets.rows.size).toBe(0)
    await expect(service.signUpload('d1', { ticket, bytes: 9, sha256: SHA, network: 'public' })).rejects.toBeInstanceOf(
      FileTransferRefusal
    )
  })

  it('refuses a missing file, a directory, an empty file, a size change and the signer’s own refusals', async () => {
    const upload = async () => ({ bytes: 9, sha256: SHA })
    const download = (stat: Parameters<typeof control>[0], transfer: FileTransfer = signer()) =>
      createFileTransferService({
        transfer,
        control: control(stat, upload),
        tickets: memoryTickets()
      }).workspaceDownload(target)
    await expect(download({ exists: false })).rejects.toMatchObject({ status: 404, code: 'WORKSPACE_NOT_FOUND' })
    await expect(download({ exists: true, type: 'dir' })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_A_FILE' })
    await expect(download({ ...file, size: 0 })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_A_FILE' })
    await expect(
      createFileTransferService({
        transfer: signer(),
        control: control(file, async () => ({ bytes: 8, sha256: SHA })),
        tickets: memoryTickets()
      }).workspaceDownload(target)
    ).rejects.toMatchObject({ status: 409, code: 'WORKSPACE_STALE' })
    const off = {
      ...signer(),
      cachedDownload: async () => Promise.reject(new FileTransferError('transfer-unavailable', 'x'))
    }
    await expect(download(file, off)).rejects.toMatchObject({ code: 'WORKSPACE_TRANSFER_UNAVAILABLE' })
  })
})

describe('begun workspace uploads', () => {
  const ok: TransferUploadOutcome = { ok: true, bytes: 9, sha256: SHA }

  function begun(over: { bucket?: () => string | undefined; sleep?: (ms: number) => Promise<void> } = {}) {
    const tickets = memoryTickets()
    const daemon = control(file, async () => {
      throw new Error('the single-shot RPC is not used')
    })
    // The first HEAD is the cache check; later ones are the poll's own look at the bucket.
    const transfer: FileTransfer = { ...signer(), cachedDownload: async () => over.bucket?.() }
    const service = createFileTransferService({
      transfer,
      control: daemon,
      tickets,
      ...(over.sleep ? { sleep: over.sleep } : {})
    })
    return { service, daemon, tickets }
  }

  it('answers pending with the ticket as the operation, then the GET once the daemon settles it', async () => {
    const { service, daemon, tickets } = begun()
    const first = await service.workspaceDownload({ ...target, begin: true, poll: true })
    expect(isTransferPending(first)).toBe(true)
    const { operationId } = first as WorkspaceTransferPending
    expect(first).toEqual({ operationId, path: 'dist/app.bin', size: 9 })
    expect(daemon.begins).toEqual([
      expect.objectContaining({ ticket: operationId, revision: { size: 9, mtime: MTIME } })
    ])
    expect(daemon.uploads).toEqual([])
    expect(tickets.rows.get(operationId)).toMatchObject({ agentId: 'a1', path: 'dist/app.bin', daemonId: 'd1' })

    expect(await service.transferStatus({ agentId: 'a1', operationId })).toEqual(first)
    await service.settleUpload('d1', { ticket: operationId, outcome: ok })
    expect(await service.transferStatus({ agentId: 'a1', operationId })).toEqual({
      path: 'dist/app.bin',
      size: 9,
      url: 'https://store.example.test/g',
      expiresAt: 2,
      sha256: SHA,
      cached: false
    })
    // A settled ticket signs nothing more, and another agent cannot read the operation.
    await expect(
      service.signUpload('d1', { ticket: operationId, bytes: 9, sha256: SHA, network: 'public' })
    ).rejects.toMatchObject({ code: 'WORKSPACE_TRANSFER_UNAVAILABLE' })
    await expect(service.transferStatus({ agentId: 'a2', operationId })).rejects.toMatchObject({
      status: 404,
      code: 'WORKSPACE_TRANSFER_UNKNOWN'
    })
  })

  it('joins a retry to the running upload and re-sends its begin under the same ticket', async () => {
    const { service, daemon } = begun()
    const a = (await service.workspaceDownload({ ...target, begin: true, poll: true })) as WorkspaceTransferPending
    const b = (await service.workspaceDownload({ ...target, begin: true, poll: true })) as WorkspaceTransferPending
    expect(b.operationId).toBe(a.operationId)
    expect(daemon.begins.map((req) => req.ticket)).toEqual([a.operationId, a.operationId])
  })

  it('completes from the bucket when the settle never arrived', async () => {
    const bucket: { sha256?: string } = {}
    const { service } = begun({ bucket: () => bucket.sha256 })
    const pending = await service.workspaceDownload({ ...target, begin: true, poll: true })
    const { operationId } = pending as WorkspaceTransferPending
    bucket.sha256 = SHA
    expect(await service.transferStatus({ agentId: 'a1', operationId })).toMatchObject({ sha256: SHA, cached: false })
  })

  it('answers a settled failure as the error the single-shot RPC would have thrown', async () => {
    const { service } = begun()
    const pending = await service.workspaceDownload({ ...target, begin: true, poll: true })
    const { operationId } = pending as WorkspaceTransferPending
    // Another daemon cannot settle it.
    await service.settleUpload('d2', { ticket: operationId, outcome: ok })
    await service.settleUpload('d1', {
      ticket: operationId,
      outcome: { ok: false, code: 'CONFLICT', reason: 'stale', message: 'workspace/upload failed: changed' }
    })
    const err = await service.transferStatus({ agentId: 'a1', operationId }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProtocolError)
    expect(err).toMatchObject({ code: 'CONFLICT', details: { reason: 'stale' } })
  })

  it('waits on the shared ticket for a caller that does not poll', async () => {
    const waits: number[] = []
    const ref: { tickets?: ReturnType<typeof memoryTickets>; service?: ReturnType<typeof createFileTransferService> } =
      {}
    const run = begun({
      sleep: async (ms) => {
        waits.push(ms)
        const [id] = [...ref.tickets!.rows.keys()]
        await ref.service!.settleUpload('d1', { ticket: id!, outcome: ok })
      }
    })
    ref.tickets = run.tickets
    ref.service = run.service
    expect(await run.service.workspaceDownload({ ...target, begin: true })).toMatchObject({
      sha256: SHA,
      cached: false
    })
    expect(waits).toEqual([1000])
  })

  it('fails a waiting caller whose ticket expired unsettled', async () => {
    const ref: { tickets?: ReturnType<typeof memoryTickets> } = {}
    const run = begun({ sleep: async () => void ref.tickets!.rows.clear() })
    ref.tickets = run.tickets
    await expect(run.service.workspaceDownload({ ...target, begin: true })).rejects.toMatchObject({
      code: 'BAD_PAYLOAD',
      details: { reason: 'transfer-failed' }
    })
  })

  it('forgets a ticket whose begin the daemon never accepted', async () => {
    const tickets = memoryTickets()
    const daemon = {
      ...control(file, async () => ({ bytes: 9, sha256: SHA })),
      workspaceUploadBegin: async () => Promise.reject(new Error('connection closed'))
    }
    const service = createFileTransferService({ transfer: signer(), control: daemon, tickets })
    await expect(service.workspaceDownload({ ...target, begin: true, poll: true })).rejects.toThrow('connection closed')
    expect(tickets.rows.size).toBe(0)
  })
})
