/**
 * The shared post-lease re-read. Pure unit test — the repo is a fake, so no Docker and no routes.
 *
 * The case that earned the extraction is the set→set one: four route files carried their own copy
 * of this fence, three moved to placement identity and `agents.ts` stayed on `daemonId` equality,
 * where two different member sets both read as `null` and compare equal.
 */
import { describe, it, expect, vi } from 'vitest'
import { refreshMutationAgent } from './mutation-agent.js'
import type { AgentRecord } from '../persistence/ports.js'
import { DaemonId } from '../domain/ids.js'

const AT = new Date('2026-08-16T00:00:00.000Z')

function agent(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    orgId: 'org-a',
    placementKind: 'daemon',
    daemonId: 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd',
    setId: null,
    lastModifiedAt: AT,
    ...over
  } as AgentRecord
}

const repo = (current: AgentRecord | null) => ({ get: vi.fn(async () => current) })

describe('refreshMutationAgent', () => {
  it('returns the current row when neither placement nor lastModifiedAt moved', async () => {
    const observed = agent()
    const current = agent()
    const agents = repo(current)
    expect(await refreshMutationAgent(agents, observed)).toBe(current)
    // Fenced on the observed row's own org — it already came through an org-scoped read.
    expect(agents.get).toHaveBeenCalledWith('org-a', observed.id)
  })

  it('refuses a row that vanished, or one edited since the caller read it', async () => {
    expect(await refreshMutationAgent(repo(null), agent())).toBeNull()
    const edited = agent({ lastModifiedAt: new Date(AT.getTime() + 1000) })
    expect(await refreshMutationAgent(repo(edited), agent())).toBeNull()
  })

  it('refuses a machine placement that moved to another daemon', async () => {
    const moved = agent({ daemonId: DaemonId('d2d2d2d2-dddd-4ddd-8ddd-dddddddddddd') })
    expect(await refreshMutationAgent(repo(moved), agent())).toBeNull()
  })

  // The one `daemonId` equality could not see: both sides carry a null column.
  it('refuses a set placement that moved to a DIFFERENT set', async () => {
    const observed = agent({ placementKind: 'set', daemonId: null, setId: 'set-a' })
    const moved = agent({ placementKind: 'set', daemonId: null, setId: 'set-b' })
    expect(await refreshMutationAgent(repo(moved), observed)).toBeNull()
  })

  it('admits an unchanged set placement, which names no machine', async () => {
    const observed = agent({ placementKind: 'set', daemonId: null, setId: 'set-a' })
    const current = agent({ placementKind: 'set', daemonId: null, setId: 'set-a' })
    expect(await refreshMutationAgent(repo(current), observed)).toBe(current)
  })

  it('refuses a move between kinds in both directions', async () => {
    const onSet = agent({ placementKind: 'set', daemonId: null, setId: 'set-a' })
    expect(await refreshMutationAgent(repo(agent()), onSet)).toBeNull()
    expect(await refreshMutationAgent(repo(onSet), agent())).toBeNull()
  })
})
