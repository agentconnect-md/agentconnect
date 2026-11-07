// The Azure DevOps publisher of a formal review (azure-devops-integration.md §11.6): the hooked binding's connection identity.
import { azureDevOpsReviewPublisherId } from '@agentconnect.md/protocol'
import type { CodeHostReviewPublisher } from '../codehost/review-lease.service.js'
import type { AzureDevOpsConnectionRepo, AzureDevOpsRepositoryBindingRepo } from '../persistence/ports.js'
import { hookBindingOf } from './hook.service.js'

export interface AzureDevOpsReviewPublisherDeps {
  bindings: Pick<AzureDevOpsRepositoryBindingRepo, 'listForRepo'>
  connections: Pick<AzureDevOpsConnectionRepo, 'get'>
}

/** Every agent on the repository publishes as the one identity, keyed by its GUID's numeric form; a degraded binding or connection publishes nothing. */
export async function azureDevOpsReviewPublisher(
  deps: AzureDevOpsReviewPublisherDeps,
  orgId: string,
  repoId: bigint
): Promise<CodeHostReviewPublisher | null> {
  const binding = hookBindingOf(await deps.bindings.listForRepo(orgId, repoId))
  if (!binding || binding.state !== 'ready') return null
  const connection = await deps.connections.get(orgId, binding.connectionId)
  if (!connection || connection.state !== 'connected') return null
  return {
    serviceAccountExternalId: BigInt(azureDevOpsReviewPublisherId(connection.identityId)),
    projectPath: binding.repoPath
  }
}
