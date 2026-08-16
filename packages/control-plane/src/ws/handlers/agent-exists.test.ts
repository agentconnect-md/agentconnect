// `agent/exists` — existence only, fenced to the connection's org when it has one.
import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleAgentExists } from './agent-exists.js'

const LIVE = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_ORG = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const GONE = 'c0c0c0c0-cccc-4ccc-8ccc-cccccccccccc'

function existsFrame(agentIds: string[]): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: '2026-08-14T00:00:00.000Z',
    type: 'agent/exists',
    payload: { agentIds }
  } as AnyFrame
}

function fakeConn(orgId: string | null) {
  return { daemonId: 'd', orgId, replyTo: vi.fn(), sendError: vi.fn() } as unknown as DaemonConnection & {
    replyTo: ReturnType<typeof vi.fn>
  }
}

const listByIds = vi.fn(async (ids: readonly string[]) =>
  [
    { id: LIVE, orgId: 'org-a' },
    { id: OTHER_ORG, orgId: 'org-b' }
  ].filter((agent) => ids.includes(agent.id))
)
const deps = { agent: { listByIds } } as unknown as DaemonWsDeps

describe('agent/exists', () => {
  it('answers an install-wide member with every asked id that exists, deduplicated', async () => {
    const conn = fakeConn(null)
    await handleAgentExists(existsFrame([LIVE, LIVE, OTHER_ORG, GONE]), conn, deps)
    expect(listByIds).toHaveBeenLastCalledWith([LIVE, OTHER_ORG, GONE])
    expect(conn.replyTo).toHaveBeenCalledWith(expect.anything(), 'agent/exists/ok', { existing: [LIVE, OTHER_ORG] })
  })

  it('fences an org-scoped connection to its own org', async () => {
    const conn = fakeConn('org-a')
    await handleAgentExists(existsFrame([LIVE, OTHER_ORG, GONE]), conn, deps)
    expect(conn.replyTo).toHaveBeenCalledWith(expect.anything(), 'agent/exists/ok', { existing: [LIVE] })
  })
})
