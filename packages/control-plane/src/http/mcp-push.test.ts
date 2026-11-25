// Every relay binding a provider push builds keeps its restricted agent grants (mcp-tool-permissions.md §6.1).
import { describe, expect, it, vi } from 'vitest'
import { makeMcpPush } from './mcp-push.js'
import { rotateProviderGrant } from './routes/mcp-providers.js'
import { grantKeyHash, mcpRcAssignFor, type McpBinding } from '../orchestrator/mcpProvider.js'
import type { HttpDeps } from './deps.js'
import type { McpGrantRecord, McpProviderRecord } from '../persistence/ports.js'
import type { OrgId } from '../domain/ids.js'

const provider = {
  id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  orgId: 'org-1' as OrgId,
  name: 'docs',
  url: 'https://mcp.example.test/mcp'
} as McpProviderRecord
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function fakeDeps() {
  const bindings: McpBinding[] = []
  const unassigned: string[] = []
  const active = new Map<string, McpGrantRecord>([
    ['old', { id: 'old', mcpProviderId: provider.id, key: 'oct_old', status: 'active', createdAt: new Date(1) }]
  ])
  const deps = {
    repos: {
      agent: { list: async () => [] },
      mcpGrant: {
        activeForProvider: async () => [...active.values()],
        mintFor: async () => {
          const g: McpGrantRecord = {
            id: 'new',
            mcpProviderId: provider.id,
            key: 'oct_new',
            status: 'active',
            createdAt: new Date(2)
          }
          active.set(g.id, g)
          return g
        },
        revoke: async (id: string) => void active.delete(id),
        activeRestricted: async () => [
          { id: 'ga', mcpProviderId: provider.id, key: 'oct_agent', agentId: AGENT, custody: 'runtime' }
        ]
      },
      agentMcpToolPolicy: {
        listForProvider: async () => [{ agentId: AGENT, allowTools: ['read'], approvalTools: ['write'], askTools: [] }]
      }
    },
    relayControl: {
      mcpAssign: vi.fn((b: McpBinding) => void bindings.push(b)),
      mcpUnassign: vi.fn((u: { grantKeyHash?: string }) => void unassigned.push(u.grantKeyHash!))
    }
  } as unknown as HttpDeps
  return { deps, bindings, unassigned }
}

describe('makeMcpPush — restricted grants ride every binding', () => {
  it('a rotation re-binds the fresh shared key with the restricted grant kept, then retires only the old shared key', async () => {
    const { deps, bindings, unassigned } = fakeDeps()
    const push = makeMcpPush(deps)
    await rotateProviderGrant(provider, [], provider.orgId, deps.repos.mcpGrant, push.pushAssign, (_id, hash) =>
      deps.relayControl.mcpUnassign({ providerId: provider.id, grantKeyHash: hash })
    )
    const frame = mcpRcAssignFor(bindings[0]!, ['mcp-tool-policy-v1'])
    expect(frame.grantKeyHashes).toEqual([grantKeyHash('oct_new')])
    // The runtime grant's table never carries approval-gated names (§5.6).
    expect(frame.toolPolicies).toEqual([{ allow: ['read'], approval: [], ask: [] }])
    expect(frame.restrictedGrants).toEqual([{ grantKeyHash: grantKeyHash('oct_agent'), policy: 0 }])
    expect(unassigned).toEqual([grantKeyHash('oct_old')])
  })

  it('an OAuth re-bind keeps them too', async () => {
    const { deps, bindings } = fakeDeps()
    await makeMcpPush(deps).pushBinding(provider, [], ['oct_old'])
    expect(mcpRcAssignFor(bindings[0]!, ['mcp-tool-policy-v1']).restrictedGrants).toHaveLength(1)
  })
})
