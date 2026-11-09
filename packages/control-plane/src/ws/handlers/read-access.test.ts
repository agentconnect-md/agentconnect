import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import type { AgentRecord } from '../../persistence/ports.js'
import { AgentId, DaemonId } from '../../domain/ids.js'
import { PlacementResolver } from '../../orchestrator/placementResolver.js'
import { FakeClock } from '../../../test/fakes/fake-clock.js'
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

const agent = {
  id: AGENT_ID,
  orgId: 'org-a',
  placementKind: 'daemon',
  daemonId: 'daemon-1',
  setId: null
} as AgentRecord

const baseDeps = (over: Partial<DaemonWsDeps>) =>
  ({
    log: { error: vi.fn() },
    agent: {
      get: vi.fn(async (orgId: string, agentId: string) =>
        orgId === agent.orgId && agentId === agent.id ? agent : null
      )
    },
    ...over
  }) as unknown as DaemonWsDeps

describe('handleReadAccess', () => {
  it('refuses an unrelated daemon and another organization before looking up any identity', async () => {
    const frame = askFrame()
    const readAccess = vi.fn()
    const deps = baseDeps({ readAccess })
    const unrelated = fakeConn()
    unrelated.daemonId = DaemonId('daemon-other')
    await handleReadAccess(frame, unrelated, deps)
    expect(unrelated.sendError).toHaveBeenCalledWith(frame.id, 'SCOPE_DENIED', expect.any(String), false)
    expect(unrelated.replyTo).not.toHaveBeenCalled()

    const foreign = fakeConn()
    await handleReadAccess({ ...frame, orgId: 'org-other' }, foreign, deps)
    expect(foreign.sendError).toHaveBeenCalledWith(frame.id, 'SCOPE_DENIED', expect.any(String), false)
    expect(readAccess).not.toHaveBeenCalled()
  })

  it('admits a current duty holder and refuses it after its duty expires', async () => {
    const frame = askFrame()
    const conn = fakeConn()
    conn.orgId = null
    const holdersOf = vi.fn(async () => [DaemonId(conn.daemonId)])
    const placementResolver = new PlacementResolver({
      clock: new FakeClock(),
      duties: { holdersOf, confirmedHoldersOf: holdersOf }
    })
    const readAccess = vi.fn(async () => ({ asker: 'linked' as const, visibleSessionIds: ['ses-1'] }))
    const deps = baseDeps({ placementResolver, readAccess })
    vi.mocked(deps.agent.get).mockResolvedValue({ ...agent, placementKind: 'set', daemonId: null, setId: 'set-1' })
    await handleReadAccess(frame, conn, deps)
    expect(holdersOf).toHaveBeenCalledWith(AgentId(AGENT_ID), new Date(0))
    expect(readAccess).toHaveBeenCalledOnce()
    holdersOf.mockResolvedValue([])
    await handleReadAccess(frame, conn, deps)
    expect(conn.sendError).toHaveBeenCalledWith(frame.id, 'SCOPE_DENIED', expect.any(String), false)
    expect(readAccess).toHaveBeenCalledOnce()
  })

  it('withholds resolved identity metadata when placement changes during the lookup', async () => {
    const frame = askFrame()
    const conn = fakeConn()
    const readAccess = vi.fn(async () => ({ asker: 'linked' as const, visibleSessionIds: ['ses-1'] }))
    const deps = baseDeps({ readAccess })
    vi.mocked(deps.agent.get)
      .mockResolvedValueOnce(agent)
      .mockResolvedValueOnce({ ...agent, daemonId: DaemonId('daemon-other') })
    await handleReadAccess(frame, conn, deps)
    expect(readAccess).toHaveBeenCalledOnce()
    expect(conn.replyTo).not.toHaveBeenCalled()
    expect(conn.sendError).toHaveBeenCalledWith(frame.id, 'SCOPE_DENIED', expect.any(String), false)
  })

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
