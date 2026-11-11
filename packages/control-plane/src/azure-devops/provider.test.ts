// Azure DevOps's code-host entry (azure-devops-integration.md §5, §6.1, §7): its pure arms; the derivation runs end to end in test/integration.
import { describe, expect, it, vi } from 'vitest'
import { AZURE_DEVOPS_V1_FEATURE } from '@agentconnect.md/protocol'
import { codeHostProviders } from '../codehost/registry.js'
import { requiredDaemonFeatures } from '../domain/daemon-features.js'
import { CreateAgentRepoAuthBody, CreateHookBody, UpdateHookBody } from '../http/dto/index.js'
import { fromDbHookKind, isStoredHookKind, toDbHookKind } from '../persistence/hook-kind.js'
import type { CodeHostDeps, CodeHostRepoAuthorizationContext } from '../codehost/provider.js'

const provider = codeHostProviders['azure-devops']
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const GIT_REPO = 'https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo'
const CONNECTION_ID = '00000000-0000-4000-8000-0000000000b1'
const ROUTING = {
  organization: 'example-org',
  projectId: '00000000-0000-4000-8000-000000000001',
  repositoryId: '00000000-0000-4000-8000-000000000002'
}

describe('the azure-devops code-host entry', () => {
  it('is proxy-only (§6.1), as GitLab and Gitea are and GitHub is not', () => {
    const proxyOnly = Object.values(codeHostProviders).filter((entry) => entry.proxyOnly === true)
    expect(proxyOnly.map((entry) => entry.provider).sort()).toEqual(['azure-devops', 'gitea', 'gitlab'])
  })

  it('leaves an address anonymous when the deployment wires no Azure DevOps surface, and ignores other hosts', async () => {
    const deps = {} as CodeHostDeps
    expect(await provider.workspace.derive({ deps, orgId: 'org-1', gitRepo: GIT_REPO })).toBeNull()
    expect(
      await provider.workspace.derive({ deps, orgId: 'org-1', gitRepo: 'https://example.test/example-org/repo.git' })
    ).toBeNull()
  })

  it('writes the connection and routing from a binding, and refuses to write a preview', () => {
    const derived = {
      kind: 'azure-devops' as const,
      repoId: 42n,
      connectionId: CONNECTION_ID,
      attestedByUserId: 'user-1',
      azureDevOps: ROUTING,
      gitRepo: GIT_REPO,
      defaultBranch: 'main',
      access: 'write' as const
    }
    expect(provider.workspace.writeFromDerived(derived)).toEqual({
      credential: {
        provider: 'azure-devops',
        access: 'write',
        connectionId: CONNECTION_ID,
        azureDevOps: ROUTING,
        attestedByUserId: 'user-1'
      },
      workspaceRepoId: 42n
    })
    const { repoId: _omitted, ...preview } = derived
    expect(() => provider.workspace.writeFromDerived(preview)).toThrow()
  })

  it('projects the credential arm with its routing (§7)', () => {
    const credential = {
      provider: 'azure-devops' as const,
      access: 'read' as const,
      connectionId: CONNECTION_ID,
      attestedByUserId: 'user-1',
      azureDevOps: ROUTING
    }
    expect(provider.workspace.toSpec(credential, 42n)).toEqual({
      provider: 'azure-devops',
      repoId: '42',
      connectionId: CONNECTION_ID,
      azureDevOps: ROUTING
    })
    expect(provider.workspace.toDto(credential, 42n)).toEqual({
      provider: 'azure-devops',
      access: 'read',
      repoId: '42',
      connectionId: CONNECTION_ID,
      azureDevOps: ROUTING
    })
    expect(provider.workspace.toSpec({ provider: 'gitea', access: 'read' }, 42n)).toBeNull()
  })

  it('requires its own feature for any spec that consumes it, and nothing for one that does not', () => {
    expect(provider.features.required(undefined)).toEqual([AZURE_DEVOPS_V1_FEATURE])
    const consuming = {
      workspace: {
        mode: 'scratch',
        additionalRepos: [{ provider: 'azure-devops', repoId: '42', repoFullName: 'example-org/Example Project/r' }]
      }
    }
    expect(requiredDaemonFeatures(consuming as never)).toContain(AZURE_DEVOPS_V1_FEATURE)
    expect(requiredDaemonFeatures({ workspace: { mode: 'scratch' } } as never)).not.toContain(AZURE_DEVOPS_V1_FEATURE)
  })

  it('refuses to raise a grant that names no connection', async () => {
    const send = vi.fn()
    const reply = { code: vi.fn(() => ({ send })) }
    const ctx = { reply, deps: {}, row: { provider: 'azure-devops' } } as unknown as CodeHostRepoAuthorizationContext
    expect(await provider.upgradeRepoAuthorization(ctx)).toBeUndefined()
    expect(reply.code).toHaveBeenCalledWith(409)
  })
})

describe('the grant body (§5)', () => {
  it('names a repository by GUID through one connection, never by a numeric id', () => {
    const body = { provider: 'azure-devops', connectionId: CONNECTION_ID, repositoryId: ROUTING.repositoryId }
    expect(CreateAgentRepoAuthBody.parse(body)).toEqual({ ...body, access: 'read', materialize: 'always' })
    expect(CreateAgentRepoAuthBody.safeParse({ provider: 'azure-devops', repoId: '42' }).success).toBe(false)
    expect(CreateAgentRepoAuthBody.safeParse({ ...body, repositoryId: 'Example Repo' }).success).toBe(false)
  })
})

describe('the hook body (§11.4, §11.9)', () => {
  const base = { kind: 'azure-devops', agentId: AGENT_ID, name: 'example', repoId: '42' }

  it('admits the pull-request and push families, stored under the kind the database spells azure_devops', () => {
    const pulls = { ...base, family: 'merge_request', events: ['merge_request:reopened', 'merge_request:synchronize'] }
    expect(CreateHookBody.safeParse({ ...pulls, commentFamilies: ['merge_request'] }).success).toBe(true)
    expect(CreateHookBody.safeParse({ ...base, family: 'push', events: ['push:*'] }).success).toBe(true)
    expect(UpdateHookBody.safeParse({ ...pulls, enabled: false }).success).toBe(true)
    expect(isStoredHookKind('azure-devops')).toBe(true)
    expect(toDbHookKind('azure-devops')).toBe('azure_devops')
    expect(fromDbHookKind('azure_devops')).toBe('azure-devops')
    expect(fromDbHookKind('azure-devops')).toBe('azure-devops')
  })

  it('refuses issues, releases, labels-only cadences and unknown actions', () => {
    for (const [family, events] of [
      ['issues', ['issues:opened']],
      ['release', ['release:published']],
      ['merge_request', ['merge_request:labeled']],
      ['merge_request', ['merge_request:closed']],
      ['push', ['push:main']]
    ] as const) {
      expect(CreateHookBody.safeParse({ ...base, family, events }).success).toBe(false)
    }
    expect(
      CreateHookBody.safeParse({
        ...base,
        family: 'merge_request',
        events: ['merge_request:*'],
        commentFamilies: ['issues']
      }).success
    ).toBe(false)
  })
})
