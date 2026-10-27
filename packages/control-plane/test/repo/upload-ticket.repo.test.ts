// Upload tickets in PostgreSQL: a ticket minted by one CP replica is signed by another (source-cache-file-transfer.md §3).
import type { WorkspaceReadContent, WorkspaceUploadReq } from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgUploadTicketRepo } from '../../src/persistence/repositories/upload-ticket.repo.js'
import {
  createFileTransferService,
  type FileTransferControl,
  type FileTransferService,
  type WorkspaceTransferPending
} from '../../src/file-transfer/service.js'
import type { FileTransfer } from '../../src/file-transfer/transfer.js'

const D1 = 'd1d1d1d1-1111-4111-8111-111111111111'
const D2 = 'd2d2d2d2-2222-4222-8222-222222222222'
const T1 = '7a7a7a7a-1111-4111-8111-111111111111'
const T2 = '7b7b7b7b-2222-4222-8222-222222222222'
const KEY = `src/org_1/transfer/dl/${'a'.repeat(64)}`
const SHA = Buffer.alloc(32, 5).toString('base64')
const FIVE_GIB = 5 * 1024 ** 3

function signer(signed: string[]): FileTransfer {
  return {
    enabled: () => true,
    maxBytes: 100,
    uploadLimits: () => ({ maxBytes: 100 }),
    grantUpload: async () => ({ uploadId: 'u', url: 'https://store.example.test/u', headers: {}, expiresAt: 1 }),
    grantMultipartUpload: async () => {
      throw new Error('unused')
    },
    signParts: async () => {
      throw new Error('unused')
    },
    uploadedFileUrl: async () => undefined,
    storedDownload: async () => undefined,
    cachedDownload: async () => undefined,
    signPut: async (input) => {
      signed.push(input.key)
      return { url: 'https://store.example.test/p', headers: {}, expiresAt: 1 }
    },
    signDownload: async () => ({ url: 'https://store.example.test/g', headers: {}, expiresAt: 2 })
  }
}

describe('PgUploadTicketRepo (real Postgres)', () => {
  it('finds an open ticket only for its daemon, keeps a size past 32 bits, and forgets it on close', async () => {
    const repo = new PgUploadTicketRepo(prisma)
    await repo.open(T1, { daemonId: D1, objectKey: KEY, size: FIVE_GIB }, 60_000)
    expect(await repo.find(T1, D1)).toEqual({ objectKey: KEY, size: FIVE_GIB })
    expect(await repo.find(T1, D2)).toBeUndefined()
    await repo.close(T1)
    expect(await repo.find(T1, D1)).toBeUndefined()
    await repo.close(T1)
  })

  it('judges expiry by database time and sweeps expired tickets on the next open', async () => {
    const repo = new PgUploadTicketRepo(prisma)
    await repo.open(T1, { daemonId: D1, objectKey: KEY, size: 9 }, -1)
    expect(await repo.find(T1, D1)).toBeUndefined()
    await repo.open(T2, { daemonId: D1, objectKey: KEY, size: 9 }, 60_000)
    const ids = (await prisma.transferUploadTicket.findMany({ select: { id: true } })).map((row) => row.id)
    expect(ids).toEqual([T2])
  })

  it('lets a replica other than the one that sent `workspace/upload` sign the daemon’s PUT', async () => {
    const signed: string[] = []
    const replicas: { b?: FileTransferService } = {}
    const a = createFileTransferService({
      transfer: signer(signed),
      tickets: new PgUploadTicketRepo(prisma),
      control: {
        workspaceRead: async (_daemonId, req) =>
          ({
            agentId: req.agentId,
            path: req.path,
            exists: true,
            type: 'file',
            size: 9,
            mtime: '2026-10-09T00:00:00.000Z'
          }) as WorkspaceReadContent,
        // The daemon's socket is owned by replica B, so its `transfer/sign` lands there.
        workspaceUploadBegin: async () => Promise.reject(new Error('unused')),
        workspaceUpload: async (daemonId, req) => {
          await expect(
            replicas.b!.signUpload(D2, { ticket: req.ticket, bytes: 9, sha256: SHA, network: 'public' })
          ).rejects.toMatchObject({ code: 'WORKSPACE_TRANSFER_UNAVAILABLE' })
          await replicas.b!.signUpload(daemonId, { ticket: req.ticket, bytes: 9, sha256: SHA, network: 'public' })
          return { bytes: 9, sha256: SHA }
        }
      }
    })
    replicas.b = createFileTransferService({
      transfer: signer(signed),
      tickets: new PgUploadTicketRepo(prisma),
      control: {
        workspaceRead: async () => Promise.reject(new Error('unused')),
        workspaceUpload: async () => Promise.reject(new Error('unused')),
        workspaceUploadBegin: async () => Promise.reject(new Error('unused'))
      }
    })
    const got = await a.workspaceDownload({ orgId: 'org_1', daemonId: D1, agentId: 'a1', path: 'dist/app.bin' })
    expect(got).toMatchObject({ sha256: SHA, cached: false })
    expect(signed).toHaveLength(1)
    expect(signed[0]).toMatch(/^src\/org_1\/transfer\/dl\//)
    expect(await prisma.transferUploadTicket.count()).toBe(0)
  })

  it('settles a begun ticket once, for its daemon only, and stops it signing or being joined', async () => {
    const repo = new PgUploadTicketRepo(prisma)
    await repo.open(T1, { daemonId: D1, objectKey: KEY, size: FIVE_GIB, agentId: 'a1', path: 'dist/app.bin' }, 60_000)
    expect(await repo.pending(KEY, D1)).toBe(T1)
    expect(await repo.pending(KEY, D2)).toBeUndefined()
    expect(await repo.get(T1)).toEqual({
      daemonId: D1,
      objectKey: KEY,
      size: FIVE_GIB,
      agentId: 'a1',
      path: 'dist/app.bin'
    })

    const ok = { ok: true as const, bytes: FIVE_GIB, sha256: SHA }
    expect(await repo.settle(T1, D2, ok, 60_000)).toBe(false)
    expect(await repo.settle(T1, D1, ok, 60_000)).toBe(true)
    expect(await repo.settle(T1, D1, { ok: false, code: 'INTERNAL', message: 'late' }, 60_000)).toBe(false)
    expect((await repo.get(T1))?.outcome).toEqual(ok)
    expect(await repo.find(T1, D1)).toBeUndefined()
    expect(await repo.pending(KEY, D1)).toBeUndefined()

    // A single-shot ticket has no poll scope, so a begun retry never joins it.
    await repo.open(T2, { daemonId: D1, objectKey: KEY, size: 9 }, 60_000)
    expect(await repo.pending(KEY, D1)).toBeUndefined()
  })

  it('keeps a settled ticket only for its retention, judged by database time', async () => {
    const repo = new PgUploadTicketRepo(prisma)
    await repo.open(T1, { daemonId: D1, objectKey: KEY, size: 9, agentId: 'a1', path: 'p' }, 60_000)
    expect(await repo.settle(T1, D1, { ok: true, bytes: 9, sha256: SHA }, -1)).toBe(true)
    expect(await repo.get(T1)).toBeUndefined()
  })

  it('lets any replica answer a begun upload that a third one recorded the outcome of', async () => {
    const begins: WorkspaceUploadReq[] = []
    const control: FileTransferControl = {
      workspaceRead: async (_daemonId, req) =>
        ({
          agentId: req.agentId,
          path: req.path,
          exists: true,
          type: 'file',
          size: 9,
          mtime: '2026-10-09T00:00:00.000Z'
        }) as WorkspaceReadContent,
      workspaceUpload: async () => Promise.reject(new Error('unused')),
      workspaceUploadBegin: async (_daemonId, req) => {
        begins.push(req)
        return {}
      }
    }
    const replica = () =>
      createFileTransferService({ transfer: signer([]), tickets: new PgUploadTicketRepo(prisma), control })
    const [a, b, c] = [replica(), replica(), replica()]
    const target = { orgId: 'org_1', daemonId: D1, agentId: 'a1', path: 'dist/app.bin', begin: true, poll: true }
    const pending = (await a.workspaceDownload(target)) as WorkspaceTransferPending
    expect(pending.operationId).toBe(begins[0]!.ticket)
    // A retry after A failed lands on C and joins the same upload.
    expect(await c.workspaceDownload(target)).toEqual(pending)
    await b.settleUpload(D1, { ticket: pending.operationId, outcome: { ok: true, bytes: 9, sha256: SHA } })
    expect(await c.transferStatus({ agentId: 'a1', operationId: pending.operationId })).toMatchObject({
      path: 'dist/app.bin',
      sha256: SHA,
      url: 'https://store.example.test/g'
    })
  })
})
