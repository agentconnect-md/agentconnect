// Azure DevOps before its Control Plane step (azure-devops-integration.md §13): a known provider with nothing to serve.
import { describe, expect, it, vi } from 'vitest'
import { AZURE_DEVOPS_V1_FEATURE } from '@agentconnect.md/protocol'
import { codeHostProviders } from '../codehost/registry.js'
import { requiredDaemonFeatures } from '../domain/daemon-features.js'
import { CreateAgentRepoAuthBody, CreateHookBody, UpdateHookBody } from '../http/dto/index.js'
import { isStoredHookKind } from '../persistence/hook-kind.js'
import type { CodeHostDeps, CodeHostRepoAuthorizationContext } from '../codehost/provider.js'

const provider = codeHostProviders['azure-devops']
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const GIT_REPO = 'https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo'

describe('the azure-devops code-host entry', () => {
  it('derives nothing, so an Azure DevOps address stays anonymous', async () => {
    const derived = await provider.workspace.derive({ deps: {} as CodeHostDeps, orgId: 'org-1', gitRepo: GIT_REPO })
    expect(derived).toBeNull()
    expect(provider.workspace.toSpec({ provider: 'azure-devops' } as never)).toBeNull()
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

  it('refuses to raise a grant tier', async () => {
    const send = vi.fn()
    const reply = { code: vi.fn(() => ({ send })) }
    const ctx = { reply } as unknown as CodeHostRepoAuthorizationContext
    expect(await provider.upgradeRepoAuthorization(ctx)).toBeUndefined()
    expect(reply.code).toHaveBeenCalledWith(409)
  })
})

describe('no Azure DevOps hooks in v1', () => {
  it('refuses the kind before the database: no create or update body admits it, and no row can store it', () => {
    const hook = { kind: 'azure-devops', agentId: AGENT_ID, name: 'example', repoId: '42', events: ['push'] }
    expect(CreateHookBody.safeParse(hook).success).toBe(false)
    expect(UpdateHookBody.safeParse(hook).success).toBe(false)
    expect(isStoredHookKind('azure-devops')).toBe(false)
    expect(isStoredHookKind('gitea')).toBe(true)
    expect(isStoredHookKind('webhook')).toBe(true)
  })

  it('admits no additional-repository grant either', () => {
    const grant = { provider: 'azure-devops', repoId: '42', access: 'read' }
    expect(CreateAgentRepoAuthBody.safeParse(grant).success).toBe(false)
  })
})
