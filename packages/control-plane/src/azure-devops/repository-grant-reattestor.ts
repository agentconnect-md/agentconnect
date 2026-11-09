import {
  RepositoryGrantReattestor,
  type RepositoryGrantReattestorConfig,
  type RepositoryGrantReattestorDeps,
  type ClaimedGrant,
  type ReattestationVerdict
} from '../codehost/repository-grant-reattestor.js'
import type {
  AzureDevOpsConnectionRepo,
  AzureDevOpsRepositoryBindingRepo,
  RepoGrantStaleReason
} from '../persistence/ports.js'
import type { AzureDevOpsUserAuthzService } from './user-authz.js'

export const AZURE_STALE_REASON_TEXT: Record<RepoGrantStaleReason, string> = {
  access_lost: 'the member who authorized it no longer has that access on Azure DevOps',
  identity_unlinked: 'the member who authorized it no longer has a linked Microsoft identity',
  attester_removed: 'it has no recorded authorizer; save the workspace or authorize the repository again'
}

interface AzureDevOpsReattestorDeps extends Omit<
  RepositoryGrantReattestorDeps,
  'provider' | 'attest' | 'staleReasonText'
> {
  connections: Pick<AzureDevOpsConnectionRepo, 'get'>
  bindings: Pick<AzureDevOpsRepositoryBindingRepo, 'byRepo'>
  authz: Pick<AzureDevOpsUserAuthzService, 'attestAccess'>
}

export class AzureDevOpsRepositoryGrantReattestor extends RepositoryGrantReattestor {
  constructor(deps: AzureDevOpsReattestorDeps, cfg: RepositoryGrantReattestorConfig) {
    super(
      {
        ...deps,
        provider: 'azure-devops',
        attest: (grant) => attest(deps, grant),
        staleReasonText: AZURE_STALE_REASON_TEXT
      },
      cfg
    )
  }
}

async function attest(deps: AzureDevOpsReattestorDeps, grant: ClaimedGrant): Promise<ReattestationVerdict> {
  if (!grant.attestedByUserId) return { kind: 'stale', reason: 'attester_removed' }
  if (!grant.connectionId) return { kind: 'skipped', why: 'no connection' }
  const connection = await deps.connections.get(grant.orgId, grant.connectionId)
  const binding = await deps.bindings.byRepo(grant.orgId, grant.connectionId, grant.repoId)
  if (!connection || !binding) return { kind: 'skipped', why: 'no binding' }
  const reason = await deps.authz.attestAccess(
    grant.attestedByUserId,
    {
      connection,
      repository: { id: binding.repositoryId, projectId: binding.projectId }
    },
    grant.access
  )
  return reason ? { kind: 'stale', reason } : { kind: 'held' }
}
