/**
 * `AgentSpecAssembler` — the one place specs are assembled: `assemble` fetches
 * secrets from the store seam, `project` trusts the caller's snapshot (the
 * agent-move fingerprint path), and the instance-owned icon bases reach the spec.
 */
import { describe, it, expect } from 'vitest'
import { AgentSpecAssembler } from './agentSpecAssembler.js'
import type { AgentRepoAuthorizationRepo, AgentRecord, AgentSecretStore } from '../persistence/ports.js'
import { AgentId, OrgId } from '../domain/ids.js'

const AGENT: AgentRecord = {
  id: AgentId('77777777-7777-4777-8777-777777777777'),
  orgId: OrgId('org'),
  name: 'deploy-bot',
  displayName: 'Deploy Bot',
  builtin: false,
  icon: null,
  description: null,
  runtime: 'claude-acp',
  model: null,
  reasoningEffort: null,
  outputMode: null,
  showFooter: true,
  showStatusBar: false,
  fastMode: null,
  permissionMode: null,
  approvalsReviewer: null,
  allowRuntimeChangesInChat: false,
  pause: null,
  env: {},
  mcpServers: [],
  skills: [],
  managedSkills: [],
  memory: null,
  status: 'active',
  placementKind: 'daemon',
  daemonId: null,
  setId: null,
  workspace: { mode: 'scratch' },
  capabilities: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  createdBy: null,
  createdByUserId: null,
  visibility: 'org',
  sharedWith: [],
  callPolicy: 'all',
  allowedCallerAgentIds: [],
  outboundPolicy: 'all',
  allowedTargetAgentIds: [],
  introduceOnJoin: false,
  runInSandbox: false,
  lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
  lastModifiedBy: null,
  configRevision: 0n
}

function storeWith(values: Record<string, Record<string, string>>): AgentSecretStore {
  return {
    get: async (_orgId, agentId) => values[agentId] ?? {},
    merge: async () => {},
    keys: async () => new Map()
  }
}

const unused = () => Promise.reject(new Error('not used by this test'))

/** Only `listForAgent` participates in the projection; the writers stay inert. */
function repoAuthWith(rows: Array<[fullName: string, repoId: bigint]>): AgentRepoAuthorizationRepo {
  return {
    listForAgent: async (agentId) =>
      rows.map(([repoFullName, repoId], index) => ({
        id: `auth-${index}`,
        agentId,
        provider: 'github' as const,
        repoId,
        repoFullName,
        access: 'read' as const,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        createdBy: null
      })),
    create: unused,
    get: unused,
    updateAccess: unused,
    updateFullName: unused,
    remove: unused,
    removeWithReviewProjectionCleanup: unused
  }
}

/** The assembler's optional dependencies are positional; only the allowlist matters here. */
function assemblerWith(agentRepoAuth: AgentRepoAuthorizationRepo): AgentSpecAssembler {
  return new AgentSpecAssembler(storeWith({}), {}, undefined, undefined, undefined, undefined, undefined, agentRepoAuth)
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

  it('assembleAll quarantines only unsafe historical clone targets', async () => {
    const unsafe = {
      ...AGENT,
      id: AgentId('88888888-8888-4888-8888-888888888888'),
      name: 'unsafe',
      workspace: { mode: 'github' as const, gitRepo: 'file:///var/lib/agentconnect/other-workspace' }
    }
    const quarantined: string[] = []
    const specs = new AgentSpecAssembler(storeWith({}))

    const assembled = await specs.assembleAll([AGENT, unsafe], (agent) => quarantined.push(agent.id))

    expect(assembled.map((spec) => spec.agentId)).toEqual([AGENT.id])
    expect(quarantined).toEqual([unsafe.id])
  })

  it('project trusts the caller-snapshotted secrets (never re-fetches)', async () => {
    let reads = 0
    const store = storeWith({ [AGENT.id]: { LIVE: 'now' } })
    const counting: AgentSecretStore = {
      ...store,
      get: async (_orgId, id) => {
        reads += 1
        return store.get(_orgId, id)
      }
    }
    const specs = new AgentSpecAssembler(counting)
    const pinned = await specs.secretsOf(AGENT) // the move snapshot's one read
    expect(reads).toBe(1)
    expect(specs.project(AGENT, pinned, []).secrets).toEqual({ LIVE: 'now' })
    expect(reads).toBe(1) // project() added none
  })

  it('redacts legacy URL secrets before projecting an anonymous workspace onto the daemon wire', () => {
    const specs = new AgentSpecAssembler(storeWith({}))
    const spec = specs.project(
      {
        ...AGENT,
        workspace: {
          mode: 'github',
          gitRepo: 'https://legacy-user:legacy-password@github.com/acme/legacy.git?token=query-secret#fragment'
        }
      },
      {},
      []
    )

    expect(spec.workspace).toMatchObject({
      mode: 'github',
      gitRepo: 'https://github.com/acme/legacy.git'
    })
    expect(JSON.stringify(spec.workspace)).not.toContain('legacy-password')
    expect(JSON.stringify(spec.workspace)).not.toContain('query-secret')
  })

  it('binds a legacy App-backed workspace to its canonical GitHub repository', () => {
    const specs = new AgentSpecAssembler(storeWith({}))
    const spec = specs.project(
      {
        ...AGENT,
        workspace: {
          mode: 'github',
          gitRepo: 'https://legacy-user:legacy-password@other-host.example/acme/legacy.git?token=query-secret',
          installationId: 'installation-id'
        }
      },
      {},
      []
    )

    expect(spec.workspace).toMatchObject({
      mode: 'github',
      gitRepo: 'https://github.com/acme/legacy.git',
      gitCredential: 'github-app'
    })
    expect(JSON.stringify(spec.workspace)).not.toContain('legacy-password')
    expect(JSON.stringify(spec.workspace)).not.toContain('query-secret')
    expect(JSON.stringify(spec.workspace)).not.toContain('other-host.example')
  })

  it('refuses to project an unsafe historical clone transport', () => {
    const specs = new AgentSpecAssembler(storeWith({}))
    expect(() =>
      specs.project(
        { ...AGENT, workspace: { mode: 'github', gitRepo: 'file:///var/lib/agentconnect/other-workspace' } },
        {},
        []
      )
    ).toThrow('git clone url must use https or ssh')
  })

  it('projects the agent’s authorized repositories onto a scratch workspace, sorted by full name', async () => {
    const specs = assemblerWith(
      repoAuthWith([
        ['example-co/shared-library', 815n],
        ['acme/infra', 4711n]
      ])
    )

    const spec = await specs.assemble(AGENT)

    expect(spec.workspace).toMatchObject({
      mode: 'scratch',
      additionalRepos: [
        { repoFullName: 'acme/infra', repoId: '4711' },
        { repoFullName: 'example-co/shared-library', repoId: '815' }
      ]
    })
  })

  it('projects the same list onto a github workspace', async () => {
    const specs = assemblerWith(repoAuthWith([['example-co/shared-library', 815n]]))

    const spec = await specs.assemble({
      ...AGENT,
      workspace: { mode: 'github', gitRepo: 'https://github.com/acme/primary-service' }
    })

    expect(spec.workspace).toMatchObject({
      mode: 'github',
      additionalRepos: [{ repoFullName: 'example-co/shared-library', repoId: '815' }]
    })
  })

  it('projects an empty list for an agent with no grants, and with no allowlist dependency at all', async () => {
    expect((await assemblerWith(repoAuthWith([])).assemble(AGENT)).workspace).toMatchObject({ additionalRepos: [] })
    expect((await new AgentSpecAssembler(storeWith({})).assemble(AGENT)).workspace).toMatchObject({
      additionalRepos: []
    })
  })

  it('project trusts the caller-snapshotted allowlist (the move bundle pins it)', () => {
    const specs = assemblerWith(repoAuthWith([['acme/infra', 4711n]]))
    const pinned = [{ repoFullName: 'example-co/shared-library', repoId: '815', provider: 'github' }]

    const spec = specs.project(AGENT, {}, [], [], undefined, pinned)

    expect(spec.workspace).toMatchObject({ additionalRepos: pinned })
  })

  it('applies the instance-owned icon bases to the spec iconUrl', async () => {
    const withIcon = { ...AGENT, icon: { kind: 'glyph', glyph: 'rocket', color: 'blue' } as AgentRecord['icon'] }
    const specs = new AgentSpecAssembler(storeWith({}), { cp: 'https://cp.example.com' })
    const spec = await specs.assemble(withIcon)
    expect(spec.iconUrl).toContain('https://cp.example.com')
  })
})
