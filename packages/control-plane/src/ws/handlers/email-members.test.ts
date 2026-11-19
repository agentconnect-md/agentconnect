import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import type { AgentRecord } from '../../persistence/ports.js'
import { DaemonId } from '../../domain/ids.js'
import { handleEmailMembers } from './email-members.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const ALICE = 'alice@corp.example.test'

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
    type: 'agent/email-members',
    orgId: 'org-a',
    payload: { agentId: AGENT_ID, addresses: [ALICE] }
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

describe('handleEmailMembers', () => {
  it('answers the daemon serving the agent with the resolver’s members, scoped to its organization', async () => {
    const frame = askFrame()
    const answer = { members: [{ address: ALICE, consoleUserId: 'user-alice' }] }
    const emailMembers = vi.fn(async () => answer)
    const conn = fakeConn()
    await handleEmailMembers(frame, conn, baseDeps({ emailMembers }))
    expect(emailMembers).toHaveBeenCalledWith(frame.payload, 'org-a')
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'agent/email-members/ok', answer)
  })

  it('refuses an unrelated daemon and another organization before any address is read', async () => {
    const frame = askFrame()
    const emailMembers = vi.fn()
    const deps = baseDeps({ emailMembers })
    const unrelated = fakeConn()
    unrelated.daemonId = DaemonId('daemon-other')
    await handleEmailMembers(frame, unrelated, deps)
    expect(unrelated.sendError).toHaveBeenCalledWith(frame.id, 'SCOPE_DENIED', expect.any(String), false)

    const foreign = fakeConn()
    await handleEmailMembers({ ...frame, orgId: 'org-other' }, foreign, deps)
    expect(foreign.sendError).toHaveBeenCalledWith(frame.id, 'SCOPE_DENIED', expect.any(String), false)
    expect(emailMembers).not.toHaveBeenCalled()
    expect(unrelated.replyTo).not.toHaveBeenCalled()
  })

  it('admits nobody without a resolver, and answers a failed read as retryable', async () => {
    const frame = askFrame()
    const bare = fakeConn()
    await handleEmailMembers(frame, bare, baseDeps({}))
    expect(bare.replyTo).toHaveBeenCalledWith(frame, 'agent/email-members/ok', { members: [] })

    const failing = fakeConn()
    const emailMembers = vi.fn().mockRejectedValue(new Error('db unavailable'))
    await handleEmailMembers(frame, failing, baseDeps({ emailMembers }))
    expect(failing.sendError).toHaveBeenCalledWith(frame.id, 'INTERNAL', expect.any(String), true)
    expect(failing.replyTo).not.toHaveBeenCalled()
  })
})
