import { describe, expect, it, vi } from 'vitest'
import { grantCustodyFor, makeMcpAgentGrantMinter, type McpAgentGrantMintDeps } from './mcpAgentGrants.js'
import { mcpRcAssignFor, grantKeyHash, type McpBinding } from './mcpProvider.js'
import { OrgId } from '../domain/ids.js'
import type { McpAgentGrantRecord, McpGrantCustody, McpProviderRecord } from '../persistence/ports.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const provider = {
  id: 'p-docs',
  orgId: ORG,
  name: 'docs',
  url: 'https://upstream.example.test/mcp',
  auth: 'none'
} as unknown as McpProviderRecord
const policy = {
  agentId: AGENT,
  mcpProviderId: provider.id,
  allowTools: ['read'],
  approvalTools: ['write'],
  askTools: []
}

function world(opts: { policy?: boolean; held?: McpGrantCustody[] } = {}) {
  const grants: McpAgentGrantRecord[] = (opts.held ?? []).map((custody, i) => ({
    id: `g-${custody}`,
    key: `oct_${custody}`,
    agentId: AGENT,
    custody,
    createdAt: new Date(1_000 + i)
  })) as McpAgentGrantRecord[]
  const bindings: McpBinding[] = []
  const order: string[] = []
  const deps = {
    grants: {
      activeForProvider: async () => [{ id: 'g-shared', key: 'oct_shared', createdAt: new Date(1) }],
      activeForAgent: async () => grants,
      activeRestricted: async () => grants,
      mintForAgent: vi.fn(async (_org: OrgId, _p: string, agentId: string, custody: McpGrantCustody) => {
        order.push(`mint:${custody}`)
        const minted = {
          id: `g-new-${custody}`,
          key: `oct_new_${custody}`,
          agentId,
          custody,
          createdAt: new Date(9_000)
        }
        grants.push(minted as McpAgentGrantRecord)
        return minted as McpAgentGrantRecord
      })
    },
    policies: {
      get: async () => (opts.policy === false ? null : policy),
      listForProvider: async () => (opts.policy === false ? [] : [policy])
    },
    secrets: { get: async () => [{ name: 'Authorization', value: 'Bearer UPSTREAM' }] },
    relays: {
      mcpAssign: (binding: McpBinding) => {
        order.push('bind')
        bindings.push(binding)
      }
    },
    serialize: vi.fn(<T>(_orgId: string, _name: string, run: () => Promise<T>) => run())
  } as unknown as McpAgentGrantMintDeps
  return { deps, bindings, order }
}

describe('grantCustodyFor', () => {
  it('gives the daemon custody only to a daemon advertising mcp-tool-approval-v1', () => {
    expect(grantCustodyFor(['mcp-agent-defs-v1', 'mcp-tool-approval-v1'])).toBe('daemon')
    expect(grantCustodyFor(['mcp-agent-defs-v1'])).toBe('runtime')
    expect(grantCustodyFor(undefined)).toBe('runtime')
  })
})

describe('makeMcpAgentGrantMinter (mcp-tool-permissions.md §5.6)', () => {
  it('returns the grant of the asked custody it already holds without minting', async () => {
    const { deps, bindings } = world({ held: ['runtime', 'daemon'] })
    const grant = await makeMcpAgentGrantMinter(deps)(provider, AGENT, 'daemon')
    expect(grant?.key).toBe('oct_daemon')
    expect(deps.grants.mintForAgent).not.toHaveBeenCalled()
    expect(bindings).toEqual([])
  })

  it('mints a daemon grant beside a runtime one, inside the provider chain, and binds it before returning', async () => {
    const { deps, bindings, order } = world({ held: ['runtime'] })
    const grant = await makeMcpAgentGrantMinter(deps)(provider, AGENT, 'daemon')
    expect(grant).toMatchObject({ key: 'oct_new_daemon', custody: 'daemon' })
    expect(deps.serialize).toHaveBeenCalledWith(ORG, 'docs', expect.any(Function))
    expect(order).toEqual(['mint:daemon', 'bind'])
    // Each custody keeps its own table; the runtime grant was not promoted.
    const assign = mcpRcAssignFor(bindings[0]!, ['mcp-tool-policy-v1', 'mcp-tool-approval-v1'])
    expect(assign.restrictedGrants).toEqual([
      { grantKeyHash: grantKeyHash('oct_runtime'), policy: 0 },
      { grantKeyHash: grantKeyHash('oct_new_daemon'), policy: 1 }
    ])
    expect(assign.toolPolicies).toEqual([
      { allow: ['read'], approval: [], ask: [] },
      { allow: ['read'], approval: ['write'], ask: [] }
    ])
  })

  it('mints nothing for an agent whose policy is gone', async () => {
    const { deps, bindings } = world({ policy: false })
    expect(await makeMcpAgentGrantMinter(deps)(provider, AGENT, 'daemon')).toBeUndefined()
    expect(deps.grants.mintForAgent).not.toHaveBeenCalled()
    expect(bindings).toEqual([])
  })
})
