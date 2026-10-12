import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleReadAccess } from './read-access.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'

function fakeConn() {
  return {
    daemonId: 'daemon-1',
    orgId: 'org-a',
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & { replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
}

function askFrame(): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    type: 'agent/read-access',
    orgId: 'org-a',
    payload: { agentId: AGENT_ID, asker: { consoleUserId: 'user-1' }, sessionIds: ['ses-1'] }
  } as AnyFrame
}

const baseDeps = (over: Partial<DaemonWsDeps>) => ({ log: { error: vi.fn() }, ...over }) as unknown as DaemonWsDeps

describe('handleReadAccess', () => {
  it("replies with the resolver's answer, scoped to the frame's organization", async () => {
    const frame = askFrame()
    const conn = fakeConn()
    const answer = { asker: 'linked', visibleSessionIds: ['ses-1'] }
    const readAccess = vi.fn().mockResolvedValue(answer)
    await handleReadAccess(frame, conn, baseDeps({ readAccess }))
    expect(readAccess).toHaveBeenCalledWith(frame.payload, 'org-a')
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'agent/read-access/ok', answer)
  })

  it('identifies nobody when no resolver is wired', async () => {
    const frame = askFrame()
    const conn = fakeConn()
    await handleReadAccess(frame, conn, baseDeps({}))
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'agent/read-access/ok', {
      asker: 'unidentifiable',
      visibleSessionIds: []
    })
  })

  it('maps a resolver throw to a retryable INTERNAL error', async () => {
    const frame = askFrame()
    const conn = fakeConn()
    await handleReadAccess(frame, conn, baseDeps({ readAccess: vi.fn().mockRejectedValue(new Error('x')) }))
    expect(conn.sendError).toHaveBeenCalledWith(frame.id, 'INTERNAL', expect.any(String), true)
    expect(conn.replyTo).not.toHaveBeenCalled()
  })
})
