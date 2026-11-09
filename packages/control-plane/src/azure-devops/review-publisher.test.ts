// The Azure DevOps review publisher (azure-devops-integration.md §11.6): one shared identity per hooked binding.
import { azureDevOpsReviewPublisherId } from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import type { AzureDevOpsConnectionRecord, AzureDevOpsRepositoryBindingRecord } from '../persistence/ports.js'
import { azureDevOpsReviewPublisher } from './review-publisher.js'

const IDENTITY = '00000000-0000-4000-8000-0000000000a3'

function binding(over: Partial<AzureDevOpsRepositoryBindingRecord>): AzureDevOpsRepositoryBindingRecord {
  return {
    id: 'binding-1',
    orgId: 'org_1',
    connectionId: 'connection-1',
    repoId: 41n,
    repoPath: 'example-org/Example Project/example-repo',
    state: 'ready',
    createdAt: new Date(1_000),
    ...over
  } as AzureDevOpsRepositoryBindingRecord
}

function deps(bindings: AzureDevOpsRepositoryBindingRecord[], state: 'connected' | 'degraded' = 'connected') {
  return {
    bindings: { listForRepo: async () => bindings },
    connections: {
      get: async (_orgId: string, id: string) =>
        ({
          id,
          identityId: id === 'connection-1' ? IDENTITY : '00000000-0000-4000-8000-0000000000b9',
          state
        }) as AzureDevOpsConnectionRecord
    }
  }
}

describe('azureDevOpsReviewPublisher', () => {
  it('names the hooked (oldest) binding’s connection identity, keyed as the daemon keys it', async () => {
    const newer = binding({ id: 'binding-2', connectionId: 'connection-2', createdAt: new Date(2_000) })
    expect(await azureDevOpsReviewPublisher(deps([newer, binding({})]), 'org_1', 41n)).toEqual({
      serviceAccountExternalId: BigInt(azureDevOpsReviewPublisherId(IDENTITY)),
      projectPath: 'example-org/Example Project/example-repo'
    })
  })

  it('publishes nothing through a degraded binding or connection, or without a binding', async () => {
    expect(await azureDevOpsReviewPublisher(deps([binding({ state: 'runtime_degraded' })]), 'org_1', 41n)).toBeNull()
    expect(await azureDevOpsReviewPublisher(deps([binding({})], 'degraded'), 'org_1', 41n)).toBeNull()
    expect(await azureDevOpsReviewPublisher(deps([]), 'org_1', 41n)).toBeNull()
  })
})
