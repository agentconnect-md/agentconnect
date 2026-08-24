import { describe, it, expect } from 'vitest'
import { rotateProviderGrant, serializeByProvider, serializeByProviderNames } from './mcp-providers.js'
import { currentMcpGrant, grantKeyHash, type GrantView } from '../../orchestrator/mcpProvider.js'
import type { McpProviderRecord, McpGrantRecord, McpGrantRepo, McpHeader } from '../../persistence/ports.js'
import type { OrgId } from '../../domain/ids.js'

const provider: McpProviderRecord = {
  id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  orgId: 'org-1' as OrgId,
  name: 'linear',
  kind: 'custom',
  transport: 'http',
  url: 'https://mcp.linear.app/sse',
  visibility: 'org',
  sharedWith: [],
  createdByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date()
}

/** In-memory grant repo recording revoke calls; mintFor yields a fresh active key. */
function fakeGrants(active: McpGrantRecord[]) {
  const revoked: string[] = []
  let minted = 0
  const repo: McpGrantRepo = {
    activeForProvider: async () => active,
    mintFor: async (mcpProviderId) => ({
      id: `new-${++minted}`,
      mcpProviderId,
      key: 'oct_fresh',
      status: 'active',
      createdAt: new Date()
    }),
    revoke: async (id) => {
      revoked.push(id)
    }
  }
  return { repo, revoked }
}

describe('rotateProviderGrant', () => {
  it('mints the new key and pushes it BEFORE revoking/unassigning the old grant (grace-safe)', async () => {
    const old: McpGrantRecord = {
      id: 'old-1',
      mcpProviderId: provider.id,
      key: 'oct_old',
      status: 'active',
      createdAt: new Date()
    }
    const { repo, revoked } = fakeGrants([old])
    const calls: string[] = []
    const pushed: string[] = []
    const unassigned: { providerId: string; hash: string }[] = []

    const key = await rotateProviderGrant(
      provider,
      [],
      provider.orgId,
      {
        ...repo,
        revoke: async (id) => {
          calls.push('revoke')
          revoked.push(id)
        }
      },
      async (_p, _h, grant) => {
        calls.push('assign')
        pushed.push(grant.key)
      },
      (providerId, hash) => {
        calls.push('unassign')
        unassigned.push({ providerId, hash })
      }
    )

    expect(key).toBe('oct_fresh')
    // The new binding is pushed with the NEW key before the old grant is torn down.
    expect(calls).toEqual(['assign', 'revoke', 'unassign'])
    expect(pushed).toEqual(['oct_fresh'])
    expect(revoked).toEqual(['old-1'])
    // The OLD key's hash is what gets retired — never the plaintext.
    expect(unassigned).toEqual([{ providerId: provider.id, hash: grantKeyHash('oct_old') }])
  })

  it('rotates cleanly when there is no prior active grant (nothing to revoke)', async () => {
    const { repo, revoked } = fakeGrants([])
    const unassigned: unknown[] = []
    const key = await rotateProviderGrant(
      provider,
      [],
      provider.orgId,
      repo,
      async () => {},
      (providerId, hash) => unassigned.push({ providerId, hash })
    )
    expect(key).toBe('oct_fresh')
    expect(revoked).toEqual([])
    expect(unassigned).toEqual([])
  })

  it('serializes concurrent rotations of the same provider — one active grant survives', async () => {
    // Model the active set as mutable state: mint adds, revoke removes. Under a race both
    // rotations would capture the same prior and leave TWO active grants; serialization
    // makes the second see the first's fresh grant and retire it → exactly one survives.
    let n = 0
    const active = new Map<string, McpGrantRecord>([
      ['old-1', { id: 'old-1', mcpProviderId: provider.id, key: 'oct_old', status: 'active', createdAt: new Date() }]
    ])
    const yieldTick = () => new Promise((r) => setTimeout(r, 0)) // force the two calls to interleave if unguarded
    const repo: McpGrantRepo = {
      activeForProvider: async () => {
        await yieldTick()
        return [...active.values()]
      },
      mintFor: async (mcpProviderId) => {
        await yieldTick()
        const g: McpGrantRecord = {
          id: `new-${++n}`,
          mcpProviderId,
          key: `oct_fresh_${n}`,
          status: 'active',
          createdAt: new Date()
        }
        active.set(g.id, g)
        return g
      },
      revoke: async (id) => {
        active.delete(id)
      }
    }
    const push = async () => {
      await yieldTick()
    }
    const [k1, k2] = await Promise.all([
      rotateProviderGrant(provider, [], provider.orgId, repo, push, () => {}),
      rotateProviderGrant(provider, [], provider.orgId, repo, push, () => {})
    ])

    expect([...active.values()].map((g) => g.id)).toEqual(['new-2']) // only the last-minted grant stays active
    expect(k1).toBe('oct_fresh_1')
    expect(k2).toBe('oct_fresh_2') // the caller's returned key is the one the surviving binding accepts
  })

  it('a concurrent PATCH push never republishes the rotation-revoked key', async () => {
    // The relay allowlist is last-writer-wins; the PATCH re-push reads the active grant and
    // pushes it. Racing a rotation, an unguarded PATCH could push the OLD (revoked) key after
    // rotation retired it. Both ops go through serializeByProvider → the last push is the
    // fresh key regardless of interleave order.
    const active = new Map<string, McpGrantRecord>([
      ['old-1', { id: 'old-1', mcpProviderId: provider.id, key: 'oct_old', status: 'active', createdAt: new Date() }]
    ])
    const yieldTick = () => new Promise((r) => setTimeout(r, 0))
    let published = '' // what the relay would currently accept (last rc/mcp-assign wins)
    const repo: McpGrantRepo = {
      activeForProvider: async () => (await yieldTick(), [...active.values()]),
      mintFor: async (mcpProviderId) => {
        await yieldTick()
        const g: McpGrantRecord = {
          id: 'new-1',
          mcpProviderId,
          key: 'oct_fresh',
          status: 'active',
          createdAt: new Date()
        }
        active.set(g.id, g)
        return g
      },
      revoke: async (id) => {
        active.delete(id)
      }
    }
    const pushAssign = async (_p: McpProviderRecord, _h: McpHeader[], grant: GrantView, _org: OrgId) => {
      await yieldTick()
      published = grant.key
    }
    // rotation + a PATCH-style re-push (read active inside the lock, then push it) race
    await Promise.all([
      rotateProviderGrant(provider, [], provider.orgId, repo, pushAssign, () => {}),
      serializeByProvider(provider.orgId, provider.name, async () => {
        const grant = currentMcpGrant(await repo.activeForProvider(provider.orgId, provider.id))
        if (grant) await pushAssign(provider, [], grant, provider.orgId)
      })
    ])

    expect(published).toBe('oct_fresh') // never left pointing at the revoked 'oct_old'
    expect([...active.values()].map((g) => g.id)).toEqual(['new-1'])
  })
})

describe('serializeByProviderNames', () => {
  it('two multi-provider writers naming the chains in opposite order both complete, mutually excluded', async () => {
    // Unsorted entry would deadlock here: A holds p1 waiting on p2's tail while B
    // holds p2 waiting on p1's. Sorted entry means both join p1 first — strict
    // serialization, no cycle.
    const order: string[] = []
    const critical = (label: string) => async () => {
      order.push(`start:${label}`)
      await new Promise((r) => setTimeout(r, 10))
      order.push(`end:${label}`)
      return label
    }
    const [a, b] = await Promise.all([
      serializeByProviderNames('org-1', ['p1', 'p2'], critical('A')),
      serializeByProviderNames('org-1', ['p2', 'p1'], critical('B'))
    ])
    expect(a).toBe('A')
    expect(b).toBe('B')
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B'])
  })

  it('a single-name writer queues behind a held serializeByProvider section (the DELETE↔agent-write fence)', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const del = serializeByProvider('org-1', 'p1', async () => {
      order.push('delete:checked')
      await gate // parked mid-critical-section (the reference check just read its snapshot)
      order.push('delete:dropped')
    })
    const write = serializeByProviderNames('org-1', ['p1'], async () => {
      order.push('agent:written')
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['delete:checked']) // the write cannot land inside the window
    release()
    await Promise.all([del, write])
    expect(order).toEqual(['delete:checked', 'delete:dropped', 'agent:written'])
  })
})
