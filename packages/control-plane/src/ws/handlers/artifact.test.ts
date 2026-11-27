import { buildEnvelope, decodeEnvelope, encode } from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { ArtifactRefusal } from '../../artifacts/service.js'
import {
  handleArtifactFetch,
  handleArtifactList,
  handleArtifactPublishBegin,
  handleArtifactPublishComplete,
  handleArtifactShare,
  handleArtifactUnshare
} from './artifact.js'

const agentId = '11111111-1111-4111-8111-111111111111'
const daemonId = '22222222-2222-4222-8222-222222222222'
const artifactId = '33333333-3333-4333-8333-333333333333'
const orgId = 'example-org'

function frameOf(type: Parameters<typeof buildEnvelope>[0], payload: unknown) {
  const decoded = decodeEnvelope(encode(buildEnvelope(type, payload as never, { orgId })))
  if (!decoded.ok) throw new Error(`invalid request fixture: ${decoded.msg}`)
  return decoded.frame
}

const manifest = {
  entry: 'index.html',
  files: [{ path: 'index.html', sha256: 'a'.repeat(64), bytes: 5, mediaType: 'text/html' }]
}
const begin = frameOf('artifact/publish/begin', {
  agentId,
  sessionId: 'webchat:s-1',
  title: 'Report',
  manifest,
  idempotencyKey: 'publish-0001',
  network: 'cluster'
})
const complete = frameOf('artifact/publish/complete', { agentId, artifactId, revision: 1 })
const fetch = frameOf('artifact/fetch', { agentId, sessionId: 'webchat:s-1', artifactId, network: 'public' })
const list = frameOf('artifact/list', { agentId, sessionId: 'webchat:s-1' })
const shareId = '44444444-4444-4444-8444-444444444444'
const initiator = { kind: 'console', userId: 'u-1' }
const share = frameOf('artifact/share', { agentId, sessionId: 'webchat:s-1', artifactId, audience: 'org', initiator })
const unshare = frameOf('artifact/unshare', { agentId, sessionId: 'webchat:s-1', artifactId, shareId, initiator })

function setup() {
  const agent = vi.fn(async () => ({ id: agentId, orgId, daemonId }) as unknown)
  const artifacts = {
    begin: vi.fn(async () => ({ state: 'pending', artifactId, revision: 1, uploads: [], expiresAt: 1 })),
    complete: vi.fn(async () => ({})),
    fetch: vi.fn(async () => ({})),
    list: vi.fn(async () => ({ artifacts: [] })),
    share: vi.fn(async () => ({ shareId })),
    unshare: vi.fn(async () => ({ shareId })),
    fileDownload: vi.fn()
  }
  const conn = { daemonId, orgId, replyTo: vi.fn(), sendError: vi.fn() }
  const log = { error: vi.fn() }
  const deps = { agent: { get: agent }, artifacts, log } as unknown as DaemonWsDeps
  return { agent, artifacts, conn, deps, log, c: conn as unknown as DaemonConnection }
}

describe('artifact/* handlers', () => {
  it('answers each frame for a daemon placed on the agent', async () => {
    const { artifacts, conn, deps, c } = setup()
    await handleArtifactPublishBegin(begin, c, deps)
    expect(artifacts.begin).toHaveBeenCalledWith(orgId, expect.objectContaining({ id: agentId }), begin.payload)
    expect(conn.replyTo).toHaveBeenLastCalledWith(begin, 'artifact/publish/begin/ok', expect.anything())
    await handleArtifactPublishComplete(complete, c, deps)
    expect(conn.replyTo).toHaveBeenLastCalledWith(complete, 'artifact/publish/complete/ok', expect.anything())
    await handleArtifactFetch(fetch, c, deps)
    expect(conn.replyTo).toHaveBeenLastCalledWith(fetch, 'artifact/fetch/ok', expect.anything())
    await handleArtifactList(list, c, deps)
    expect(conn.replyTo).toHaveBeenLastCalledWith(list, 'artifact/list/ok', { artifacts: [] })
    await handleArtifactShare(share, c, deps)
    expect(artifacts.share).toHaveBeenCalledWith(orgId, share.payload)
    expect(conn.replyTo).toHaveBeenLastCalledWith(share, 'artifact/share/ok', { shareId })
    await handleArtifactUnshare(unshare, c, deps)
    expect(artifacts.unshare).toHaveBeenCalledWith(orgId, unshare.payload)
    expect(conn.replyTo).toHaveBeenLastCalledWith(unshare, 'artifact/unshare/ok', { shareId })
  })

  it('refuses a daemon that does not serve the agent, before the service sees the frame', async () => {
    const { agent, artifacts, conn, deps, c } = setup()
    agent.mockResolvedValue({ id: agentId, orgId, daemonId: 'another-daemon' })
    for (const [frame, handler] of [
      [begin, handleArtifactPublishBegin],
      [complete, handleArtifactPublishComplete],
      [fetch, handleArtifactFetch],
      [list, handleArtifactList],
      [share, handleArtifactShare],
      [unshare, handleArtifactUnshare]
    ] as const) {
      await handler(frame, c, deps)
      expect(conn.sendError).toHaveBeenLastCalledWith(frame.id, 'SCOPE_DENIED', expect.any(String), false)
    }
    agent.mockResolvedValueOnce(null)
    await handleArtifactPublishBegin(begin, c, deps)
    expect(conn.sendError).toHaveBeenLastCalledWith(begin.id, 'SCOPE_DENIED', expect.any(String), false)
    expect(artifacts.begin).not.toHaveBeenCalled()
    expect(artifacts.list).not.toHaveBeenCalled()
    expect(artifacts.share).not.toHaveBeenCalled()
  })

  it('refuses every frame on a deployment where artifacts are not enabled, naming the reason', async () => {
    const { conn, c } = setup()
    const off = { agent: { get: vi.fn() } } as unknown as DaemonWsDeps
    for (const [frame, handler] of [
      [begin, handleArtifactPublishBegin],
      [complete, handleArtifactPublishComplete],
      [fetch, handleArtifactFetch],
      [list, handleArtifactList],
      [share, handleArtifactShare],
      [unshare, handleArtifactUnshare]
    ] as const) {
      await handler(frame, c, off)
      expect(conn.sendError).toHaveBeenLastCalledWith(frame.id, 'SCOPE_DENIED', expect.any(String), false, {
        reason: 'not-enabled'
      })
    }
  })

  it('passes a refusal’s code, retryability, reason and details through', async () => {
    const { artifacts, conn, deps, c } = setup()
    artifacts.begin.mockRejectedValueOnce(new ArtifactRefusal('not-producer', 'SCOPE_DENIED', 'not yours'))
    await handleArtifactPublishBegin(begin, c, deps)
    expect(conn.sendError).toHaveBeenLastCalledWith(begin.id, 'SCOPE_DENIED', 'not yours', false, {
      reason: 'not-producer'
    })
    artifacts.complete.mockRejectedValueOnce(
      new ArtifactRefusal('incomplete', 'CONFLICT', '1 file(s) are missing', false, { paths: ['index.html'] })
    )
    await handleArtifactPublishComplete(complete, c, deps)
    expect(conn.sendError).toHaveBeenLastCalledWith(complete.id, 'CONFLICT', '1 file(s) are missing', false, {
      reason: 'incomplete',
      paths: ['index.html']
    })
    artifacts.share.mockRejectedValueOnce(new ArtifactRefusal('no-member-authority', 'SCOPE_DENIED', 'no member'))
    await handleArtifactShare(share, c, deps)
    expect(conn.sendError).toHaveBeenLastCalledWith(share.id, 'SCOPE_DENIED', 'no member', false, {
      reason: 'no-member-authority'
    })
  })

  it('answers an unexpected failure as a retryable INTERNAL and logs it', async () => {
    const { artifacts, conn, deps, log, c } = setup()
    artifacts.fetch.mockRejectedValueOnce(new Error('database down'))
    await handleArtifactFetch(fetch, c, deps)
    expect(conn.sendError).toHaveBeenLastCalledWith(fetch.id, 'INTERNAL', expect.any(String), true)
    expect(log.error).toHaveBeenCalled()
  })
})
