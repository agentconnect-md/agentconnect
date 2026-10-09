import type { WorkspaceReadContent, WorkspaceReadReq } from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import { createFileTransferControl } from '../src/cp/file-transfer.js'
import type { WorkspaceReader } from '../src/cp/workspace-reader.js'
import { WorkspaceConflictError } from '../src/workspace/workspace-files.js'
import { FileTransferError, type FileTransfer } from '../src/source-cache/transfer.js'

const AGENT = 'agent-1'
const SHA = Buffer.alloc(32, 3).toString('base64')

function reader(
  stat: Partial<WorkspaceReadContent> & { exists: boolean },
  reads: WorkspaceReadReq[] = [],
  uploads: unknown[] = []
): WorkspaceReader {
  return {
    list: async () => {
      throw new Error('unused')
    },
    read: async (req) => {
      reads.push(req)
      return { agentId: req.agentId, path: req.path, ...stat }
    },
    write: async () => {
      throw new Error('unused')
    },
    delete: async () => {
      throw new Error('unused')
    },
    mkdir: async () => {
      throw new Error('unused')
    },
    upload: async (req, sign) => {
      uploads.push(req)
      await sign({ bytes: 9, sha256: SHA })
      return { bytes: 9, sha256: SHA }
    }
  }
}

function transfer(seen: unknown[] = [], fail?: Error): FileTransfer {
  return {
    enabled: () => true,
    maxBytes: 100,
    grantUpload: async (input) => {
      seen.push(input)
      if (fail) throw fail
      return {
        uploadId: '3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c',
        url: 'https://s.example.test/u',
        headers: {},
        expiresAt: 1
      }
    },
    uploadedFileUrl: async () => undefined,
    workspaceFileUrl: async (input) => {
      seen.push(input)
      if (fail) throw fail
      await input.upload(async () => ({ url: 'https://s.example.test/p', headers: {}, expiresAt: 1 }))
      return { url: 'https://s.example.test/g', headers: {}, expiresAt: 2, cached: false, sha256: SHA }
    }
  }
}

describe('file transfer control', () => {
  it('stats through the workspace read, keys the object by revision, and answers the grant', async () => {
    const reads: WorkspaceReadReq[] = []
    const uploads: unknown[] = []
    const seen: unknown[] = []
    const control = createFileTransferControl({
      transfer: transfer(seen),
      orgForAgent: () => 'org_1',
      workspaceRead: reader({ exists: true, type: 'file', size: 9, mtime: '2026-10-09T00:00:00.000Z' }, reads, uploads)
    })
    const grant = await control.workspace({ agentId: AGENT, sessionId: 's1', path: 'out/a.bin' })
    expect(grant).toEqual({
      path: 'out/a.bin',
      size: 9,
      url: 'https://s.example.test/g',
      expiresAt: 2,
      sha256: SHA,
      cached: false
    })
    // The upload is bound to the revision the object key names.
    expect(uploads[0]).toMatchObject({ revision: { size: 9, mtime: '2026-10-09T00:00:00.000Z' } })
    expect(reads).toEqual([{ agentId: AGENT, sessionId: 's1', path: 'out/a.bin', offset: 0, limit: 1 }])
    expect(seen[0]).toMatchObject({
      org: 'org_1',
      identity: [AGENT, 's1', null, 'out/a.bin', 9, '2026-10-09T00:00:00.000Z'],
      name: 'a.bin',
      size: 9
    })
  })

  it('refuses a missing file, a directory, and an agent this daemon does not serve', async () => {
    const control = (stat: Parameters<typeof reader>[0], served = true) =>
      createFileTransferControl({
        transfer: transfer(),
        orgForAgent: () => (served ? 'org_1' : undefined),
        workspaceRead: reader(stat)
      })
    await expect(control({ exists: false }).workspace({ agentId: AGENT, path: 'x' })).rejects.toMatchObject({
      reason: 'not-found'
    })
    await expect(control({ exists: true, type: 'dir' }).workspace({ agentId: AGENT, path: 'x' })).rejects.toMatchObject(
      {
        reason: 'not-a-file'
      }
    )
    await expect(
      control({ exists: true, size: 1 }, false).workspace({ agentId: AGENT, path: 'x' })
    ).rejects.toMatchObject({
      reason: 'unknown-agent'
    })
  })

  it('refuses an upload over the cap before signing and maps transfer refusals onto workspace errors', async () => {
    const seen: unknown[] = []
    const control = createFileTransferControl({
      transfer: transfer(seen),
      orgForAgent: () => 'org_1',
      workspaceRead: reader({ exists: false })
    })
    const file = { agentId: AGENT, name: 'a.zip', mimeType: 'application/zip', sha256: SHA }
    await expect(control.upload({ ...file, size: 101 })).rejects.toMatchObject({ reason: 'too-large' })
    expect(seen).toHaveLength(0)
    expect(await control.upload({ ...file, size: 100 })).toMatchObject({
      uploadId: '3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c'
    })

    const stale = createFileTransferControl({
      transfer: transfer([], new FileTransferError('stale', 'changed')),
      orgForAgent: () => 'org_1',
      workspaceRead: reader({ exists: true, type: 'file', size: 9 })
    })
    await expect(stale.workspace({ agentId: AGENT, path: 'a' })).rejects.toBeInstanceOf(WorkspaceConflictError)
  })
})
