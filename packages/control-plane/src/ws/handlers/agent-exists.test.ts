// `agent/exists` — existence only, fenced to the connection's org when it has one.
import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleAgentExists } from './agent-exists.js'

const LIVE = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_ORG = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const GONE = 'c0c0c0c0-cccc-4ccc-8ccc-cccccccccccc'

function existsFrame(agentIds: string[], placedOnSetId?: string): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: '2026-08-14T00:00:00.000Z',
    type: 'agent/exists',
    payload: { agentIds, ...(placedOnSetId ? { placedOnSetId } : {}) }
  } as AnyFrame
}

function fakeConn(orgId: string | null) {
  return { daemonId: 'd', orgId, replyTo: vi.fn(), sendError: vi.fn() } as unknown as DaemonConnection & {
    replyTo: ReturnType<typeof vi.fn>
  }
}

const POOL = 'set-pool'
const CHANGED_AT = new Date('2026-08-13T09:00:00.000Z')
/** `LIVE` sits on the pool; `OTHER_ORG` was moved to a machine of its own. */
const listByIds = vi.fn(async (ids: readonly string[]) =>
  [
    { id: LIVE, orgId: 'org-a', placementKind: 'set' as const, daemonId: null, setId: POOL },
    { id: OTHER_ORG, orgId: 'org-b', placementKind: 'daemon' as const, daemonId: 'daemon-1', setId: null }
  ]
    .filter((agent) => ids.includes(agent.id))
    .map((agent) => ({ ...agent, placementChangedAt: CHANGED_AT }))
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

  it('also names the surviving agents the asked set no longer holds, and WHEN they left', async () => {
    // What tells a moved agent from a live one: both exist, only one is still this pool's. The
    // timestamp comes from here because nothing at the sweeping end can derive it.
    const conn = fakeConn(null)
    await handleAgentExists(existsFrame([LIVE, OTHER_ORG, GONE], POOL), conn, deps)
    expect(conn.replyTo).toHaveBeenCalledWith(expect.anything(), 'agent/exists/ok', {
      existing: [LIVE, OTHER_ORG],
      elsewhere: [{ agentId: OTHER_ORG, since: CHANGED_AT.toISOString() }]
    })
  })

  it('answers no placement at all when the request names no set', async () => {
    // Absent is "not answered", never "none left" — the caller collects less, never more.
    const conn = fakeConn(null)
    await handleAgentExists(existsFrame([LIVE, OTHER_ORG]), conn, deps)
    expect(conn.replyTo).toHaveBeenCalledWith(expect.anything(), 'agent/exists/ok', {
      existing: [LIVE, OTHER_ORG]
    })
  })

  it('reports an agent moved to ANOTHER set, and one left unplaced, as no longer this pool’s', async () => {
    const conn = fakeConn(null)
    await handleAgentExists(existsFrame([LIVE, OTHER_ORG], 'set-other'), conn, deps)
    expect(conn.replyTo).toHaveBeenCalledWith(expect.anything(), 'agent/exists/ok', {
      existing: [LIVE, OTHER_ORG],
      elsewhere: [
        { agentId: LIVE, since: CHANGED_AT.toISOString() },
        { agentId: OTHER_ORG, since: CHANGED_AT.toISOString() }
      ]
    })
  })
})
