import { buildEnvelope, decodeEnvelope, encode } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { SharedImageRefusal } from '../../file-transfer/shared-image.js'
import { handleSharedImageGet, handleSharedImagePut } from './shared-image.js'

const agentId = '11111111-1111-4111-8111-111111111111'
const daemonId = '22222222-2222-4222-8222-222222222222'
const attachmentId = '33333333-3333-4333-8333-333333333333'
const postId = '44444444-4444-4444-8444-444444444444'
const orgId = 'example-org'
const sha256 = Buffer.alloc(32, 7).toString('base64')

function frameOf(type: 'image/original/put' | 'image/original/get', payload: unknown) {
  const decoded = decodeEnvelope(encode(buildEnvelope(type, payload as never, { orgId })))
  if (!decoded.ok) throw new Error('invalid request fixture')
  return decoded.frame
}

function setup() {
  const agent = vi.fn(async () => ({ id: agentId, orgId, daemonId }) as unknown)
  const sharedImages = {
    signPut: vi.fn(async () => ({ url: 'https://store.example.test/p', headers: {} })),
    signGet: vi.fn(async () => ({ url: 'https://store.example.test/g', expiresAt: 1 })),
    resolve: vi.fn()
  }
  const conn = { daemonId, orgId, replyTo: vi.fn(), sendError: vi.fn() }
  const deps = { agent: { get: agent }, sharedImages } as unknown as DaemonWsDeps
  return { agent, sharedImages, conn, deps, c: conn as unknown as DaemonConnection }
}

describe('image/original/put', () => {
  const put = frameOf('image/original/put', {
    agentId,
    sessionId: 'session-1',
    postId,
    attachmentId,
    bytes: 5,
    sha256,
    network: 'public'
  })

  it('signs only for a daemon that currently serves the agent', async () => {
    const { agent, sharedImages, conn, deps, c } = setup()
    await handleSharedImagePut(put, c, deps)
    expect(sharedImages.signPut).toHaveBeenCalledWith(orgId, expect.objectContaining({ attachmentId }))
    expect(conn.replyTo).toHaveBeenCalledWith(expect.anything(), 'image/original/put/ok', expect.anything())

    agent.mockResolvedValueOnce({ id: agentId, orgId, daemonId: 'another-daemon' })
    await handleSharedImagePut(put, c, deps)
    expect(sharedImages.signPut).toHaveBeenCalledTimes(1)
    expect(conn.sendError).toHaveBeenLastCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
  })

  it('answers a refusal with its own message and retryability', async () => {
    const { sharedImages, conn, deps, c } = setup()
    sharedImages.signPut.mockRejectedValueOnce(new SharedImageRefusal('TOO_LARGE', 'over 100 bytes'))
    await handleSharedImagePut(put, c, deps)
    expect(conn.sendError).toHaveBeenLastCalledWith(expect.any(String), 'SCOPE_DENIED', 'over 100 bytes', false)
    sharedImages.signPut.mockRejectedValueOnce(new SharedImageRefusal('UNAVAILABLE', 'gated', true))
    await handleSharedImagePut(put, c, deps)
    expect(conn.sendError).toHaveBeenLastCalledWith(expect.any(String), 'INTERNAL', 'gated', true)
  })

  it('refuses everything on a deployment without the service', async () => {
    const { conn, c } = setup()
    await handleSharedImagePut(put, c, { agent: { get: vi.fn() } } as unknown as DaemonWsDeps)
    expect(conn.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
  })
})

describe('image/original/get', () => {
  const get = frameOf('image/original/get', { agentId, attachmentId, bytes: 5, sha256, name: 'chart.png' })

  it('tells the service whether the daemon is placed, and leaves the ticket check to it', async () => {
    const { agent, sharedImages, conn, deps, c } = setup()
    await handleSharedImageGet(get, c, deps)
    expect(sharedImages.signGet).toHaveBeenLastCalledWith(
      orgId,
      daemonId,
      expect.objectContaining({ attachmentId }),
      true
    )
    expect(conn.replyTo).toHaveBeenCalledWith(expect.anything(), 'image/original/get/ok', expect.anything())

    agent.mockResolvedValueOnce({ id: agentId, orgId, daemonId: 'another-daemon' })
    await handleSharedImageGet(get, c, deps)
    expect(sharedImages.signGet).toHaveBeenLastCalledWith(orgId, daemonId, expect.anything(), false)
  })

  it('denies an agent outside the organization and retries a signer outage', async () => {
    const { agent, sharedImages, conn, deps, c } = setup()
    agent.mockResolvedValueOnce(null)
    await handleSharedImageGet(get, c, deps)
    expect(sharedImages.signGet).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenLastCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
    sharedImages.signGet.mockRejectedValueOnce(new Error('network'))
    await handleSharedImageGet(get, c, deps)
    expect(conn.sendError).toHaveBeenLastCalledWith(expect.any(String), 'INTERNAL', expect.any(String), true)
  })
})
