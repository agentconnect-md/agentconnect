/**
 * The one projector behind BOTH the reconnect roster's definition arrays and the
 * `duty/fetch` bundle's (#979). It is keyed on agents, never on a daemon, which
 * is what lets a duty holder that is not the placement receive the definitions
 * its installed agent references — and what bounds who can obtain them: an MCP
 * proxy def carries the relay url plus a plaintext grant key, so "referenced by
 * an agent in this set" IS the authorization scope.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  mcpDefsForAgents,
  memoryDefsForAgents,
  type AgentDefinitionRef,
  type McpDefinitionDeps,
  type MemoryDefinitionDeps
} from './agentDefinitions.js'
import { OrgId } from '../domain/ids.js'
import type { McpProviderRecord } from '../persistence/ports.js'

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const CONNECTION = '33333333-3333-4333-8333-333333333333'
const OTHER_CONNECTION = '44444444-4444-4444-8444-444444444444'
const INSTALLATION = '55555555-5555-4555-8555-555555555555'

function agent(orgId: string, over: Partial<AgentDefinitionRef> = {}): AgentDefinitionRef {
  return { orgId: OrgId(orgId), mcpServers: [], memory: null, ...over } as AgentDefinitionRef
}

function provider(orgId: string, name: string, id = `p-${orgId}-${name}`): McpProviderRecord {
  return { id, orgId: OrgId(orgId), name, url: `https://upstream.example.test/${name}` } as McpProviderRecord
}

function mcpDeps(providers: McpProviderRecord[], relay = true): McpDefinitionDeps {
  return {
    providers: { listForOrg: async (orgId: string) => providers.filter((p) => p.orgId === orgId) },
    grants: {
      // Ascending by createdAt, exactly as the repo returns it: the retiring grant
      // FIRST and the fresh one last, which is the rotation overlap window.
      activeForProvider: async (_orgId: string, id: string) => [
        { id: `g-${id}-old`, key: `oct_${id}_retiring`, createdAt: new Date(1_000) },
        { id: `g-${id}`, key: `oct_${id}`, createdAt: new Date(2_000) }
      ]
    },
    relayRoster: {
      entries: async () => (relay ? [{ relayId: 'r1', name: 'r1', url: 'wss://relay.example.test' }] : [])
    }
  } as unknown as McpDefinitionDeps
}

describe('mcpDefsForAgents — the MCP half of an agent set’s definitions', () => {
  it('projects only the providers the agents NAME, never the rest of the org registry', async () => {
    const specs = await mcpDefsForAgents(
      [agent(ORG_A, { mcpServers: ['docs'] })],
      mcpDeps([provider(ORG_A, 'docs'), provider(ORG_A, 'payroll')])
    )
    expect(specs.map((s) => s.name)).toEqual(['docs'])
    // The token-bearing part: the RELAY proxy url + the grant key, never upstream.
    expect(specs[0]).toMatchObject({
      transport: 'http',
      url: 'https://relay.example.test/mcp/p-11111111-1111-4111-8111-111111111111-docs',
      headers: [{ name: 'Authorization', value: 'Bearer oct_p-11111111-1111-4111-8111-111111111111-docs' }]
    })
  })

  it('resolves each agent’s names in ITS OWN org — a mixed roster is not one flat name set', async () => {
    // The roster union spans orgs on an install-wide member, so the reference set
    // is per-org: a name one org enables must never resolve against another's
    // registry, and each org's own enable must still be found.
    const specs = await mcpDefsForAgents(
      [agent(ORG_A, { mcpServers: ['docs'] }), agent(ORG_B, { mcpServers: ['payroll'] })],
      mcpDeps([provider(ORG_A, 'docs'), provider(ORG_A, 'payroll'), provider(ORG_B, 'payroll')])
    )
    expect(specs.map((s) => [s.orgId, s.name])).toEqual([
      [ORG_A, 'docs'],
      [ORG_B, 'payroll']
    ])
  })

  it('projects the FRESH grant during a rotation overlap, and orders the def by it', async () => {
    // `activeForProvider` is ascending by createdAt and rotation leaves both active
    // until the fresh key is distributed, so the head is the key about to be revoked.
    const specs = await mcpDefsForAgents([agent(ORG_A, { mcpServers: ['docs'] })], mcpDeps([provider(ORG_A, 'docs')]))
    expect(specs[0]!.headers).toEqual([
      { name: 'Authorization', value: 'Bearer oct_p-11111111-1111-4111-8111-111111111111-docs' }
    ])
    // The marker is the fresh grant's instant — what the daemon compares on apply.
    expect(specs[0]!.issuedAt).toBe(2_000)
  })

  it('skips the reserved name — the daemon injects its own agentconnect server', async () => {
    expect(
      await mcpDefsForAgents(
        [agent(ORG_A, { mcpServers: ['agentconnect'] })],
        mcpDeps([provider(ORG_A, 'agentconnect')])
      )
    ).toEqual([])
  })

  it('ships nothing and warns when no relay is live — the next register is the backstop', async () => {
    const warn = vi.fn()
    const specs = await mcpDefsForAgents(
      [agent(ORG_A, { mcpServers: ['docs'] })],
      mcpDeps([provider(ORG_A, 'docs')], false),
      { warn }
    )
    expect(specs).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('an empty agent set reads no registry at all', async () => {
    const listForOrg = vi.fn()
    await mcpDefsForAgents([], { ...mcpDeps([]), providers: { listForOrg } } as unknown as McpDefinitionDeps)
    expect(listForOrg).not.toHaveBeenCalled()
  })
})

function memoryDeps(over: Partial<MemoryDefinitionDeps> = {}): MemoryDefinitionDeps {
  return {
    connections: {
      get: async (orgId: string, id: string) =>
        id === CONNECTION && orgId === ORG_A
          ? { id: CONNECTION, orgId: OrgId(ORG_A), installationId: INSTALLATION, revision: 2, config: { p: 1 } }
          : null
    },
    installations: {
      get: async () => ({
        id: INSTALLATION,
        pluginId: 'ai.example.memory',
        transport: 'stdio',
        commandRef: 'operator-mem0',
        expectedManifestDigest: `sha256:${'a'.repeat(64)}`,
        secretHeaders: []
      })
    },
    secrets: { get: async () => ({ apiKey: 'upstream-secret' }), keys: async () => ['apiKey'] },
    // Ascending by createdAt, as the repo returns it: retiring first, fresh last.
    grants: {
      activeForConnection: async () => [
        { id: 'g0', key: 'omg_retiring' },
        { id: 'g1', key: 'omg_key' }
      ]
    },
    relayRoster: { entries: async () => [{ relayId: 'r1', name: 'r1', url: 'wss://relay.example.test' }] },
    ...over
  } as unknown as MemoryDefinitionDeps
}

const bound = (connectionId: string) =>
  agent(ORG_A, { memory: { provider: 'external', connectionId } as AgentDefinitionRef['memory'] })

describe('memoryDefsForAgents — the external-memory half', () => {
  it('projects exactly the connection the agent binds', async () => {
    const specs = await memoryDefsForAgents([bound(CONNECTION)], memoryDeps())
    expect(specs.map((s) => s.connectionId)).toEqual([CONNECTION])
  })

  it('an agent bound to a DIFFERENT connection pulls nothing for this one', async () => {
    expect(await memoryDefsForAgents([bound(OTHER_CONNECTION)], memoryDeps())).toEqual([])
  })

  it('an agent with no external binding reads no connection at all', async () => {
    const get = vi.fn()
    await memoryDefsForAgents([agent(ORG_A)], memoryDeps({ connections: { get } } as unknown as MemoryDefinitionDeps))
    expect(get).not.toHaveBeenCalled()
  })

  it('projects the FRESH relay grant during a rotation overlap, ordered by the connection revision', async () => {
    const specs = await memoryDefsForAgents(
      [bound(CONNECTION)],
      memoryDeps({
        installations: {
          get: async () => ({
            id: INSTALLATION,
            pluginId: 'ai.example.memory',
            transport: 'streamable-http',
            endpoint: 'https://plugin.example.test/mcp',
            expectedManifestDigest: `sha256:${'a'.repeat(64)}`,
            secretHeaders: []
          })
        }
      } as unknown as MemoryDefinitionDeps)
    )
    // The memory path was already disciplined: newest active grant, and the
    // connection's own `revision` is the marker the daemon registry fences on.
    expect(specs[0]).toMatchObject({ grantKey: 'omg_key', revision: 2 })
  })

  it('a remote connection with no live relay is skipped and warned; stdio is unaffected', async () => {
    const warn = vi.fn()
    const specs = await memoryDefsForAgents(
      [bound(CONNECTION)],
      memoryDeps({
        installations: {
          get: async () => ({
            id: INSTALLATION,
            pluginId: 'ai.example.memory',
            transport: 'streamable-http',
            endpoint: 'https://plugin.example.test/mcp',
            expectedManifestDigest: `sha256:${'a'.repeat(64)}`,
            secretHeaders: []
          })
        },
        relayRoster: { entries: async () => [] }
      } as unknown as MemoryDefinitionDeps),
      { warn }
    )
    expect(specs).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })
})
