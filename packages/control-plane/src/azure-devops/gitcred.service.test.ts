// Azure DevOps gitcred leases (azure-devops-integration.md §3.4, §6.1, §6.3): authority, tier, and a TTL inside the token's life.
import { describe, expect, it, vi } from 'vitest'
import {
  AzureDevOpsGitcredService,
  DEGRADED_PROBE_HOLD_MS,
  FORCE_REFRESH_MIN_INTERVAL_MS,
  LEASE_MARGIN_SEC
} from './gitcred.service.js'
import { AzureDevOpsApiClient, AzureDevOpsApiError } from './api.js'
import type {
  AgentRecord,
  AgentRepoAuthorizationRecord,
  AzureDevOpsConnectionRecord,
  AzureDevOpsRepositoryBindingRecord,
  RepoGrantStaleReason
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
  createdAt: new Date(NOW),
  secretFingerprint: null
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
    hookReason: null,
    lastVerifiedDeliveryAt: null,
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
      credential: {
        provider: 'azure-devops',
        access,
        connectionId: CONNECTION_ID,
        azureDevOps: ROUTING,
        attestedByUserId: 'user-1'
      }
    },
    workspaceRepoId: 7n
  } as unknown as AgentRecord
}

function harness(
  opts: {
    expiresInMs?: number
    access?: 'read' | 'write'
    grants?: Partial<AgentRepoAuthorizationRecord>[]
    bindings?: AzureDevOpsRepositoryBindingRecord[]
    connection?: Partial<AzureDevOpsConnectionRecord>
    probe?: () => Promise<unknown>
  } = {}
) {
  const bindings = opts.bindings ?? [binding(7n), binding(8n)]
  const clock = { now: NOW }
  const accessToken = vi.fn(async () => ({
    token: 'example-token',
    expiresAtMs: clock.now + (opts.expiresInMs ?? 3_599_000)
  }))
  const withApi = vi.fn(opts.probe ?? (async () => undefined))
  const purgeToken = vi.fn()
  const current = { agent: agent(opts.access ?? 'read') }
  const attestAccess = vi.fn(async (): Promise<RepoGrantStaleReason | null> => null)
  const service = new AzureDevOpsGitcredService({
    agents: { get: async () => current.agent },
    authz: { attestAccess },
    connections: { get: async () => ({ ...connection, ...opts.connection }) },
    bindings: {
      byRepo: async (_org, connectionId, repoId) =>
        bindings.find((b) => b.connectionId === connectionId && b.repoId === repoId) ?? null,
      listForRepo: async (_org, repoId) => bindings.filter((b) => b.repoId === repoId)
    },
    repoAuths: {
      listForAgent: async () =>
        (opts.grants ?? []).map((g) => ({
          id: 'grant-1',
          attestedByUserId: 'user-2',
          stale: null,
          ...g
        })) as AgentRepoAuthorizationRecord[]
    },
    service: { accessToken, withApi: withApi as never, purgeToken },
    api: new AzureDevOpsApiClient(),
    clock: { now: () => clock.now } as never
  })
  return { service, accessToken, withApi, purgeToken, clock, attestAccess, current }
}

describe('AzureDevOpsGitcredService', () => {
  it('serves the workspace repository under its tier, echoing provider, id, path and epoch', async () => {
    const { service, current } = harness({ access: 'write' })
    const grant = await service.grantForAgent(agent('write'))
    // The basic-auth user is the identity's GUID, never its display name, which may hold a colon.
    expect(grant).toMatchObject({
      username: '00000000-0000-4000-8000-0000000000f1',
      token: 'example-token',
      access: 'write',
      provider: 'azure-devops',
      externalRepoId: '7',
      repoFullName: 'example-org/Example Project/Repo 7',
      credentialEpoch: '3'
    })
    expect((await service.grantForAgent(agent('write'), 7n, 'read')).access).toBe('read')
    current.agent = agent('read')
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

  it.each(['access_lost', 'identity_unlinked', 'attester_removed'] as const)(
    'refuses new leases for %s without returning the connection token',
    async (reason) => {
      const h = harness({ access: 'write' })
      h.attestAccess.mockResolvedValue(reason)
      await expect(h.service.grantForAgent(h.current.agent, 7n, 'read')).rejects.toMatchObject({ code: 'LEASE_DENIED' })
      expect(h.attestAccess).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ repository: { id: ROUTING.repositoryId, projectId: ROUTING.projectId } }),
        'write'
      )
      expect(h.accessToken).not.toHaveBeenCalled()
    }
  )

  it('does not honor a suspended additional grant and keeps provider outages retryable', async () => {
    const h = harness({
      grants: [
        {
          provider: 'azure-devops',
          repoId: 8n,
          access: 'write',
          connectionId: CONNECTION_ID,
          stale: { since: new Date(NOW), reason: 'access_lost' }
        }
      ]
    })
    await expect(h.service.grantForAgent(h.current.agent, 8n)).rejects.toMatchObject({ code: 'LEASE_DENIED' })
    expect(h.attestAccess).not.toHaveBeenCalled()
    h.attestAccess.mockRejectedValue(new AzureDevOpsApiError('unavailable', 503, 'UNAVAILABLE', true))
    await expect(h.service.grantForAgent(h.current.agent)).rejects.toMatchObject({ code: 'INTERNAL', retryable: true })
    expect(h.accessToken).not.toHaveBeenCalled()
  })

  it('discards a checked lease if its workspace authorizer or grant row changes during the check', async () => {
    const workspace = harness()
    workspace.attestAccess.mockImplementation(async () => {
      const credential =
        workspace.current.agent.workspace.mode === 'git' && workspace.current.agent.workspace.credential
      if (credential && credential.provider === 'azure-devops') credential.attestedByUserId = 'user-2'
      return null
    })
    await expect(workspace.service.grantForAgent(agent('read'))).rejects.toMatchObject({
      code: 'LEASE_DENIED',
      retryable: true
    })
    const grants = [
      {
        id: 'old-grant',
        provider: 'azure-devops' as const,
        repoId: 8n,
        access: 'read' as const,
        connectionId: CONNECTION_ID
      }
    ]
    const additional = harness({ grants })
    additional.attestAccess.mockImplementation(async () => {
      grants[0]!.id = 'replacement-grant'
      return null
    })
    await expect(additional.service.grantForAgent(agent('read'), 8n)).rejects.toMatchObject({
      code: 'LEASE_DENIED',
      retryable: true
    })
  })

  it('refuses a repository the identity no longer sees', async () => {
    const { service, accessToken } = harness({
      bindings: [binding(7n, { state: 'runtime_degraded', stateReason: 'repository_unavailable' })]
    })
    await expect(service.grantForAgent(agent('read'))).rejects.toMatchObject({ code: 'LEASE_DENIED' })
    expect(accessToken).not.toHaveBeenCalled()
  })

  it('holds a degraded connection’s failed probe for a minute, refusing leases without any outbound call', async () => {
    const h = harness({
      connection: { state: 'degraded', stateReason: 'access_revoked' },
      probe: async () => {
        throw new AzureDevOpsApiError('not a member', 401, 'ACCESS_REVOKED', false)
      }
    })
    await expect(h.service.grantForAgent(agent('read'))).rejects.toMatchObject({
      code: 'LEASE_DENIED',
      retryable: true
    })
    h.clock.now += DEGRADED_PROBE_HOLD_MS - 1
    await expect(h.service.grantForAgent(agent('read'))).rejects.toMatchObject({
      code: 'LEASE_DENIED',
      retryable: true
    })
    expect(h.withApi).toHaveBeenCalledTimes(1)
    expect(h.accessToken).not.toHaveBeenCalled()
    h.clock.now += 1
    await expect(h.service.grantForAgent(agent('read'))).rejects.toMatchObject({ code: 'LEASE_DENIED' })
    expect(h.withApi).toHaveBeenCalledTimes(2)
  })

  it('honors forceRefresh by purging the cached token, at most once per interval per connection', async () => {
    const h = harness()
    await h.service.grantForAgent(agent('read'), undefined, undefined, true)
    await h.service.grantForAgent(agent('read'), undefined, undefined, true)
    expect(h.purgeToken).toHaveBeenCalledTimes(1)
    expect(h.purgeToken).toHaveBeenCalledWith(CONNECTION_ID)
    h.clock.now += FORCE_REFRESH_MIN_INTERVAL_MS
    await h.service.grantForAgent(agent('read'), undefined, undefined, true)
    expect(h.purgeToken).toHaveBeenCalledTimes(2)
    await h.service.grantForAgent(agent('read'))
    expect(h.purgeToken).toHaveBeenCalledTimes(2)
  })
})
