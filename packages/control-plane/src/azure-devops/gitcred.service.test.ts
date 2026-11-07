// Azure DevOps gitcred leases (azure-devops-integration.md §3.4, §6.1, §6.3): authority, tier, and a TTL inside the token's life.
import { describe, expect, it, vi } from 'vitest'
import { AzureDevOpsGitcredService, LEASE_MARGIN_SEC } from './gitcred.service.js'
import { AzureDevOpsApiClient } from './api.js'
import type {
  AgentRecord,
  AgentRepoAuthorizationRecord,
  AzureDevOpsConnectionRecord,
  AzureDevOpsRepositoryBindingRecord
} from '../persistence/ports.js'

const CONNECTION_ID = '00000000-0000-4000-8000-0000000000b1'
const ROUTING = {
  organization: 'example-org',
  projectId: '00000000-0000-4000-8000-000000000001',
  repositoryId: '00000000-0000-4000-8000-000000000002'
}
const NOW = 1_800_000_000_000

const connection: AzureDevOpsConnectionRecord = {
  id: CONNECTION_ID,
  orgId: 'org-1',
  createdByUserId: null,
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  organization: 'example-org',
  organizationInstanceId: '00000000-0000-4000-8000-0000000000e1',
  identityId: '00000000-0000-4000-8000-0000000000f1',
  identityName: 'Example Application',
  credentialSource: 'own',
  clientId: '00000000-0000-4000-8000-0000000000c1',
  credentialEpoch: 3n,
  state: 'connected',
  stateReason: null,
  lastVerifiedAt: null,
  createdAt: new Date(NOW)
}

function binding(
  repoId: bigint,
  overrides: Partial<AzureDevOpsRepositoryBindingRecord> = {}
): AzureDevOpsRepositoryBindingRecord {
  return {
    id: `binding-${repoId}`,
    orgId: 'org-1',
    connectionId: CONNECTION_ID,
    repoId,
    repositoryId: ROUTING.repositoryId,
    projectId: ROUTING.projectId,
    repoPath: `example-org/Example Project/Repo ${repoId}`,
    cloneUrl: 'https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo',
    defaultBranch: 'main',
    state: 'ready',
    stateReason: null,
    createdAt: new Date(NOW),
    ...overrides
  }
}

function agent(access: 'read' | 'write'): AgentRecord {
  return {
    id: 'agent-1',
    orgId: 'org-1',
    workspace: {
      mode: 'git',
      gitRepo: 'https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo',
      credential: { provider: 'azure-devops', access, connectionId: CONNECTION_ID, azureDevOps: ROUTING }
    },
    workspaceRepoId: 7n
  } as unknown as AgentRecord
}

function harness(
  opts: {
    expiresInMs?: number
    grants?: Partial<AgentRepoAuthorizationRecord>[]
    bindings?: AzureDevOpsRepositoryBindingRecord[]
  } = {}
) {
  const bindings = opts.bindings ?? [binding(7n), binding(8n)]
  const accessToken = vi.fn(async () => ({
    token: 'example-token',
    expiresAtMs: NOW + (opts.expiresInMs ?? 3_599_000)
  }))
  const service = new AzureDevOpsGitcredService({
    connections: { get: async () => connection },
    bindings: {
      byRepo: async (_org, connectionId, repoId) =>
        bindings.find((b) => b.connectionId === connectionId && b.repoId === repoId) ?? null
    },
    repoAuths: { listForAgent: async () => (opts.grants ?? []) as AgentRepoAuthorizationRecord[] },
    service: { accessToken, withApi: vi.fn() },
    api: new AzureDevOpsApiClient(),
    clock: { now: () => NOW } as never
  })
  return { service, accessToken }
}

describe('AzureDevOpsGitcredService', () => {
  it('serves the workspace repository under its tier, echoing provider, id, path and epoch', async () => {
    const { service } = harness()
    const grant = await service.grantForAgent(agent('write'))
    expect(grant).toMatchObject({
      username: 'Example Application',
      token: 'example-token',
      access: 'write',
      provider: 'azure-devops',
      externalRepoId: '7',
      repoFullName: 'example-org/Example Project/Repo 7',
      credentialEpoch: '3'
    })
    expect((await service.grantForAgent(agent('write'), 7n, 'read')).access).toBe('read')
    expect((await service.grantForAgent(agent('read'), 7n, 'write')).access).toBe('read')
  })

  it('never leases longer than the token inside it, less a margin', async () => {
    const hour = harness({ expiresInMs: 3_599_000 })
    expect((await hour.service.grantForAgent(agent('read'))).ttlSec).toBe(3599 - LEASE_MARGIN_SEC)
    const short = harness({ expiresInMs: 20 * 60_000 })
    const grant = await short.service.grantForAgent(agent('read'))
    expect(grant.ttlSec).toBe(20 * 60 - LEASE_MARGIN_SEC)
    expect(Date.parse(grant.expiresAt)).toBeLessThan(Date.parse(grant.providerExpiresAt!))
    const dying = harness({ expiresInMs: LEASE_MARGIN_SEC * 1000 })
    await expect(dying.service.grantForAgent(agent('read'))).rejects.toMatchObject({ code: 'LEASE_DENIED' })
  })

  it('serves an explicit grant at its tier, comment reading only, and refuses an unauthorized repository', async () => {
    const { service } = harness({
      grants: [{ provider: 'azure-devops', repoId: 8n, access: 'comment', connectionId: CONNECTION_ID }]
    })
    expect(await service.grantForAgent(agent('write'), 8n)).toMatchObject({ access: 'read', externalRepoId: '8' })
    await expect(service.grantForAgent(agent('write'), 9n)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    const scratch = { ...agent('write'), workspace: { mode: 'scratch' } } as unknown as AgentRecord
    await expect(service.grantForAgent(scratch)).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
  })

  it('refuses a repository the identity no longer sees', async () => {
    const { service, accessToken } = harness({
      bindings: [binding(7n, { state: 'runtime_degraded', stateReason: 'repository_unavailable' })]
    })
    await expect(service.grantForAgent(agent('read'))).rejects.toMatchObject({ code: 'LEASE_DENIED' })
    expect(accessToken).not.toHaveBeenCalled()
  })
})
