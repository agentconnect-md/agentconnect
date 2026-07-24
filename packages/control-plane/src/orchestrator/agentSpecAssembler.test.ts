/**
 * `AgentSpecAssembler` — the one place specs are assembled: `assemble` fetches
 * secrets from the store seam, `project` trusts the caller's snapshot (the
 * agent-move fingerprint path), and the instance-owned icon bases reach the spec.
 */
import { describe, it, expect } from 'vitest'
import { AgentSpecAssembler } from './agentSpecAssembler.js'
import type { AgentRecord, AgentSecretStore } from '../persistence/ports.js'
import { AgentId, OrgId } from '../domain/ids.js'

const AGENT: AgentRecord = {
  id: AgentId('77777777-7777-4777-8777-777777777777'),
  orgId: OrgId('org'),
  name: 'deploy-bot',
  displayName: 'Deploy Bot',
  icon: null,
  description: null,
  runtime: 'claude-acp',
  model: null,
  reasoningEffort: null,
  outputMode: null,
  fastMode: null,
  permissionMode: null,
  pause: null,
  env: {},
  mcpServers: [],
  memory: null,
  status: 'active',
  daemonId: null,
  workspace: { mode: 'scratch' },
  capabilities: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  createdBy: null,
  createdByUserId: null,
  visibility: 'org',
  sharedWith: [],
  callPolicy: 'all',
  allowedCallerAgentIds: [],
  introduceOnJoin: false,
  lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
  lastModifiedBy: null
}

function storeWith(values: Record<string, Record<string, string>>): AgentSecretStore {
  return {
    get: async (agentId) => values[agentId] ?? {},
    merge: async () => {},
    keys: async () => new Map()
  }
}

describe('AgentSpecAssembler', () => {
  it('assemble fetches the agent secrets from the store seam onto the spec', async () => {
    const specs = new AgentSpecAssembler(storeWith({ [AGENT.id]: { API_KEY: 'sk-1' } }))
    const spec = await specs.assemble(AGENT)
    expect(spec).toMatchObject({ agentId: AGENT.id, secrets: { API_KEY: 'sk-1' } })
  })

  it('assembleAll assembles one spec per agent (each with ITS OWN secrets)', async () => {
    const other = { ...AGENT, id: AgentId('88888888-8888-4888-8888-888888888888'), name: 'other' }
    const specs = new AgentSpecAssembler(storeWith({ [AGENT.id]: { A: '1' }, [other.id]: { B: '2' } }))
    const [a, b] = await specs.assembleAll([AGENT, other])
    expect(a!.secrets).toEqual({ A: '1' })
    expect(b!.secrets).toEqual({ B: '2' })
  })

  it('project trusts the caller-snapshotted secrets (never re-fetches)', async () => {
    let reads = 0
    const store = storeWith({ [AGENT.id]: { LIVE: 'now' } })
    const counting: AgentSecretStore = {
      ...store,
      get: async (id) => {
        reads += 1
        return store.get(id)
      }
    }
    const specs = new AgentSpecAssembler(counting)
    const pinned = await specs.secretsOf(AGENT) // the move snapshot's one read
    expect(reads).toBe(1)
    expect(specs.project(AGENT, pinned, []).secrets).toEqual({ LIVE: 'now' })
    expect(reads).toBe(1) // project() added none
  })

  it('applies the instance-owned icon bases to the spec iconUrl', async () => {
    const withIcon = { ...AGENT, icon: { kind: 'glyph', glyph: 'rocket', color: 'blue' } as AgentRecord['icon'] }
    const specs = new AgentSpecAssembler(storeWith({}), { cp: 'https://cp.example.com' })
    const spec = await specs.assemble(withIcon)
    expect(spec.iconUrl).toContain('https://cp.example.com')
  })
})
