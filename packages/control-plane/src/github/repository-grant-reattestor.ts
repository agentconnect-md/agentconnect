// GitHub's scheduled re-attestation uses the same human gate as grant creation.
import type { AgentId } from '../domain/ids.js'
import type { GithubInstallationRepo, RepoGrantStaleReason } from '../persistence/ports.js'
import {
  RepositoryGrantReattestor as CodeHostRepositoryGrantReattestor,
  type RepositoryGrantReattestorDeps as SharedDeps,
  type RepositoryGrantReattestorConfig,
  type ClaimedGrant,
  type ReattestationVerdict
} from '../codehost/repository-grant-reattestor.js'
import { UserAuthzDeniedError, type GithubUserAuthzService, type RepoPermission } from './user-authz.js'
import type { GithubService } from './service.js'

export type {
  RepositoryGrantReattestorConfig,
  ReattestationVerdict,
  ReattestationSweep
} from '../codehost/repository-grant-reattestor.js'

export interface RepositoryGrantReattestorDeps extends Omit<SharedDeps, 'provider' | 'attest' | 'staleReasonText'> {
  installations: Pick<GithubInstallationRepo, 'liveByOrgAndAccount'>
  agentApp?: (agentId: AgentId) => Promise<string | null>
  github: Pick<GithubService, 'repoRefForCommentAuthz'>
  authz: Pick<GithubUserAuthzService, 'assertAccess'>
}

/** How a refusal names why a stale grant is not honored. */
export const STALE_REASON_TEXT: Record<RepoGrantStaleReason, string> = {
  access_lost: 'the member who authorized it no longer has that access on GitHub',
  identity_unlinked: 'the member who authorized it no longer has a linked GitHub identity',
  attester_removed: 'the member who authorized it no longer has an account'
}

/** The access check's lookups with the strict error policy: only a missing subject reads as no access. */
export function strictRepoAccessLookups(
  github: Pick<GithubService, 'repoRefForCommentAuthz' | 'userRepoPermissionForCommentAuthz'>
): ConstructorParameters<typeof GithubUserAuthzService>[0]['github'] {
  return {
    getRepoMeta: async (ins, owner, repo) => {
      const ref = await github.repoRefForCommentAuthz(ins, owner, repo)
      return ref ? { private: ref.private } : null
    },
    userRepoPermission: async (ins, owner, repo, login): Promise<RepoPermission> => {
      const role = await github.userRepoPermissionForCommentAuthz(ins, owner, repo, login)
      return role === 'triage' ? 'read' : role
    }
  }
}

export class RepositoryGrantReattestor extends CodeHostRepositoryGrantReattestor {
  constructor(deps: RepositoryGrantReattestorDeps, cfg: RepositoryGrantReattestorConfig) {
    super(
      { ...deps, provider: 'github', attest: (grant) => attest(deps, grant), staleReasonText: STALE_REASON_TEXT },
      cfg
    )
  }
}

/** The creation gate's check against the grant's attester; throws on an upstream failure. */
async function attest(deps: RepositoryGrantReattestorDeps, grant: ClaimedGrant): Promise<ReattestationVerdict> {
  if (grant.attestedByUserId === null) return { kind: 'stale', reason: 'attester_removed' }
  const [owner, repo] = grant.repoFullName.split('/')
  if (!owner || !repo) return { kind: 'skipped', why: 'not an owner/repo name' }
  const githubAppId = (await deps.agentApp?.(grant.agentId)) ?? null
  const installation = await deps.installations.liveByOrgAndAccount(grant.orgId, owner, githubAppId)
  if (!installation || installation.suspendedAt) return { kind: 'skipped', why: 'no live installation' }
  // The numeric id is the grant's identity: a reused name is another repository, which the mint gate denies anyway.
  const ref = await deps.github.repoRefForCommentAuthz(installation, owner, repo)
  if (!ref || ref.repoId !== grant.repoId) return { kind: 'skipped', why: 'repository no longer resolves' }
  const [refOwner, refRepo] = ref.fullName.split('/')
  try {
    await deps.authz.assertAccess(
      grant.attestedByUserId,
      installation,
      refOwner ?? owner,
      refRepo ?? repo,
      grant.access === 'write' ? 'write' : 'read'
    )
    return { kind: 'held' }
  } catch (err) {
    if (!(err instanceof UserAuthzDeniedError)) throw err
    return { kind: 'stale', reason: err.code === 'USER_NO_ACCESS' ? 'access_lost' : 'identity_unlinked' }
  }
}
