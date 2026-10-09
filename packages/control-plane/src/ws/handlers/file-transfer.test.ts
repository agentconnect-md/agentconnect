import { buildEnvelope, decodeEnvelope, encode } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { FileTransferRefusal } from '../../file-transfer/service.js'
import { handleTransferGet, handleTransferSign } from './file-transfer.js'

const agentId = '11111111-1111-4111-8111-111111111111'
const daemonId = '22222222-2222-4222-8222-222222222222'
const orgId = 'example-org'
const uploadId = '3f1c2a4e-9b7d-4e21-8c3a-0d5e6f7a8b9c'
const sha256 = Buffer.alloc(32, 7).toString('base64')

function frameOf(type: 'transfer/get' | 'transfer/sign', payload: unknown) {
  const decoded = decodeEnvelope(encode(buildEnvelope(type, payload as never, { orgId })))
  if (!decoded.ok) throw new Error('invalid request fixture')
  return decoded.frame
}

function setup() {
  const agent = vi.fn(async () => ({ id: agentId, orgId, daemonId }) as unknown)
  const fileTransfer = {
    uploadedFile: vi.fn(async () => ({ url: 'https://store.example.test/g', expiresAt: 1 })),
    signUpload: vi.fn(async () => ({ url: 'https://store.example.test/p', headers: {} }))
  }
  const conn = { daemonId, orgId, replyTo: vi.fn(), sendError: vi.fn() }
  const deps = { agent: { get: agent }, fileTransfer } as unknown as DaemonWsDeps
  return { agent, fileTransfer, conn, deps, c: conn as unknown as DaemonConnection }
}

describe('transfer/get', () => {
  const get = frameOf('transfer/get', { agentId, uploadId, size: 5, sha256, network: 'public' })

  it('signs a GET only for an agent this daemon serves, in that agent’s organization', async () => {
    const { agent, fileTransfer, conn, deps, c } = setup()
    await handleTransferGet(get, c, deps)
    expect(fileTransfer.uploadedFile).toHaveBeenCalledWith(orgId, expect.objectContaining({ uploadId }))
    expect(conn.replyTo).toHaveBeenCalledWith(expect.anything(), 'transfer/get/ok', {
      url: 'https://store.example.test/g',
      expiresAt: 1
    })

    agent.mockResolvedValueOnce({ id: agentId, orgId, daemonId: 'another-daemon' })
    await handleTransferGet(get, c, deps)
    agent.mockResolvedValueOnce(null)
    await handleTransferGet(get, c, deps)
    expect(fileTransfer.uploadedFile).toHaveBeenCalledTimes(1)
    expect(conn.sendError).toHaveBeenCalledTimes(2)
    expect(conn.sendError).toHaveBeenLastCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
  })

  it('refuses everything on a deployment without a transfer bucket', async () => {
    const { conn, c } = setup()
    await handleTransferGet(get, c, { agent: { get: vi.fn() } } as unknown as DaemonWsDeps)
    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
  })
})

describe('transfer/sign', () => {
  const sign = frameOf('transfer/sign', { ticket: uploadId, bytes: 5, sha256, network: 'public' })

  it('signs for the connection’s own daemon and answers a size change as a conflict', async () => {
    const { fileTransfer, conn, deps, c } = setup()
    await handleTransferSign(sign, c, deps)
    expect(fileTransfer.signUpload).toHaveBeenCalledWith(daemonId, expect.objectContaining({ ticket: uploadId }))
    expect(conn.replyTo).toHaveBeenCalledWith(expect.anything(), 'transfer/sign/ok', expect.anything())

    fileTransfer.signUpload.mockRejectedValueOnce(new FileTransferRefusal(409, 'WORKSPACE_STALE', 'changed'))
    await handleTransferSign(sign, c, deps)
    expect(conn.sendError).toHaveBeenLastCalledWith(expect.any(String), 'CONFLICT', 'changed', false)
    fileTransfer.signUpload.mockRejectedValueOnce(
      new FileTransferRefusal(409, 'WORKSPACE_TRANSFER_UNAVAILABLE', 'no open upload')
    )
    await handleTransferSign(sign, c, deps)
    expect(conn.sendError).toHaveBeenLastCalledWith(expect.any(String), 'SCOPE_DENIED', 'no open upload', false)
  })
})
