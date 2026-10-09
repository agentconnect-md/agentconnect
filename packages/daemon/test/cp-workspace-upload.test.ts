import type { AnyFrame, TransferSignReq } from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import { GitMessagePasses, workspaceUpload, type WorkspaceControlDeps } from '../src/cp/control/workspace.js'
import type { ControlWire } from '../src/cp/control/context.js'
import type { WorkspaceReader } from '../src/cp/workspace-reader.js'
import type { WorkspaceUploadReq as FilesUploadReq } from '../src/workspace/workspace-files.js'

// `workspace/upload`: the daemon snapshots and PUTs on a URL the control plane signs for the frame's ticket.

const SHA = Buffer.alloc(32, 7).toString('base64')
const TICKET = '3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c'

const frame = {
  type: 'workspace/upload',
  id: 'req-1',
  orgId: 'org_1',
  payload: {
    agentId: 'agent-1',
    sessionId: 's1',
    path: 'dist/app.bin',
    revision: { size: 9, mtime: '2026-10-09T00:00:00.000Z' },
    maxBytes: 100,
    ticket: TICKET
  }
} as unknown as AnyFrame

function wire() {
  const replies: Array<{ type: string; payload: unknown }> = []
  const errors: Array<{ code: string; details?: Record<string, unknown> }> = []
  const w: ControlWire = {
    reply: (_req, type, payload) => replies.push({ type, payload }),
    sendError: (_corr, code, _message, _retryable, details) => errors.push({ code, ...(details ? { details } : {}) }),
    emit: () => undefined,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as ControlWire['log']
  }
  return { w, replies, errors }
}

function deps(over: Partial<WorkspaceControlDeps>, uploads: FilesUploadReq[] = []): WorkspaceControlDeps {
  const workspaceRead = {
    upload: async (req: FilesUploadReq, sign: (file: { bytes: number; sha256: string }) => Promise<unknown>) => {
      uploads.push(req)
      await sign({ bytes: 9, sha256: SHA })
      return { bytes: 9, sha256: SHA }
    }
  } as unknown as WorkspaceReader
  return { workspaceRead, workspaceGit: {} as never, gitMessagePasses: new GitMessagePasses(), ...over }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('workspace/upload', () => {
  it('binds the snapshot to the revision and asks the control plane to sign it for the ticket', async () => {
    const signed: Array<{ req: TransferSignReq; orgId?: string }> = []
    const uploads: FilesUploadReq[] = []
    const { w, replies, errors } = wire()
    workspaceUpload(
      frame,
      deps(
        {
          transferNetwork: 'cluster',
          signTransfer: async (req, orgId) => {
            signed.push({ req, ...(orgId ? { orgId } : {}) })
            return { url: 'https://store.example.test/k', headers: {} }
          }
        },
        uploads
      ),
      w
    )
    await settle()
    expect(errors).toEqual([])
    expect(replies).toEqual([{ type: 'workspace/upload/ok', payload: { bytes: 9, sha256: SHA } }])
    expect(uploads[0]).toMatchObject({
      agentId: 'agent-1',
      sessionId: 's1',
      path: 'dist/app.bin',
      maxBytes: 100,
      revision: { size: 9, mtime: '2026-10-09T00:00:00.000Z' }
    })
    expect(signed).toEqual([{ req: { ticket: TICKET, bytes: 9, sha256: SHA, network: 'cluster' }, orgId: 'org_1' }])
  })

  it('reads a refused signature as a conflict or a failed transfer, and refuses without a signer', async () => {
    const conflict = wire()
    workspaceUpload(
      frame,
      deps({ signTransfer: async () => Promise.reject(Object.assign(new Error('changed'), { code: 'CONFLICT' })) }),
      conflict.w
    )
    await settle()
    expect(conflict.errors).toEqual([{ code: 'CONFLICT', details: { reason: 'stale' } }])

    const denied = wire()
    workspaceUpload(
      frame,
      deps({ signTransfer: async () => Promise.reject(Object.assign(new Error('no'), { code: 'SCOPE_DENIED' })) }),
      denied.w
    )
    await settle()
    expect(denied.errors).toEqual([{ code: 'BAD_PAYLOAD', details: { reason: 'transfer-failed' } }])

    const none = wire()
    workspaceUpload(frame, deps({}), none.w)
    await settle()
    expect(none.errors).toEqual([{ code: 'BAD_PAYLOAD', details: { reason: 'transfer-unavailable' } }])
  })
})
