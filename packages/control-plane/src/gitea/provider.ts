/**
 * The Gitea entry of the code-host provider registry (`codehost/provider.ts`).
 *
 * Gitea is the third implementer: a managed repository binding vouches for a workspace, a hook or
 * grant write re-converges the repository's managed webhook, and a grant tier is a local clamp only
 * — every tier is served by the organization's one bot token (gitea-integration.md §5), so raising
 * one changes nothing at the provider. The feature predicates are `gitea-v1` alone: one string
 * covers gitea.com and a self-hosted address (§11).
 */
import { GITEA_V1_FEATURE, GitCloneUrlError, normalizeGitCloneUrl, normalizeGitUrl } from '@agentconnect.md/protocol'
import {
  refuseWorkspaceCredential,
  type CodeHostProviderModule,
  type CodeHostWorkspaceDerivation,
  type DerivedWorkspace
} from '../codehost/provider.js'
import type { AgentWorkspaceCredentialDtoT } from '../http/dto/index.js'
import type { GiteaRepositoryBindingRecord } from '../persistence/ports.js'
import { gitlabManagedProjectPath } from '../domain/git-host.js'
import { giteaPublicRepository, splitGiteaRepoPath } from './api.js'
import { GiteaConnectDenied } from './connection.service.js'

/** The managed outcome: the persisted catalog row, never caller input or a composed URL, is the clone authority. */
async function managedGiteaWorkspace(
  derivation: CodeHostWorkspaceDerivation,
  binding: GiteaRepositoryBindingRecord
): Promise<DerivedWorkspace> {
  const catalogRow = await derivation.deps.repos.codeHostRepository.byExternalId(
    derivation.orgId,
    'gitea',
    binding.repoId
  )
  if (!catalogRow?.cloneUrl) {
    refuseWorkspaceCredential('the Gitea repository binding has no clone URL yet — repair the repository first')
  }
  return {
    kind: 'gitea',
    repoId: binding.repoId,
    gitRepo: catalogRow.cloneUrl,
    defaultBranch: binding.defaultBranch ?? 'main',
    access: derivation.requestedAccess ?? 'write'
  }
}

/** The gitea arm of the §6 outcome table: a managed binding — bound on first use where the bot administers the address — else an anonymous public repository. */
async function deriveGiteaWorkspace(derivation: CodeHostWorkspaceDerivation): Promise<DerivedWorkspace | null> {
  const { deps, orgId, gitRepo, requestedAccess } = derivation
  const gitea = deps.gitea
  // The same host+prefix path rule GitLab uses; a Gitea path has exactly two segments.
  const repoPath = gitea ? gitlabManagedProjectPath(gitRepo, gitea.api.baseUrl) : null
  const split = repoPath ? splitGiteaRepoPath(repoPath) : null
  if (!gitea || !repoPath || !split) return null
  const binding = await deps.repos.giteaRepositoryBinding.byRepoPath(orgId, repoPath)
  if (binding) {
    // A binding mid-removal must refuse, never demote to an anonymous clone of the same path.
    if (binding.state === 'cleanup_pending') {
      refuseWorkspaceCredential(`${repoPath} is being removed from this organization — wait for cleanup to finish`)
    }
    return managedGiteaWorkspace(derivation, binding)
  }
  // Not bound yet: a repository the bot administers is managed all the same (§6) — a write binds it here, a preview only says so.
  let administered
  try {
    administered = await gitea.bindings.administeredByPath(orgId, split.owner, split.repo)
  } catch (e) {
    if (e instanceof GiteaConnectDenied) refuseWorkspaceCredential(e.message)
    throw e
  }
  if (administered) {
    if (derivation.write) {
      try {
        const bound = await gitea.bindings.ensureBound(orgId, BigInt(administered.repo.id))
        return managedGiteaWorkspace(derivation, bound.binding)
      } catch (e) {
        if (e instanceof GiteaConnectDenied) refuseWorkspaceCredential(e.message)
        throw e
      }
    }
    let cloneUrl: string
    try {
      cloneUrl = normalizeGitCloneUrl(administered.repo.clone_url ?? gitRepo)
    } catch (e) {
      if (!(e instanceof GitCloneUrlError)) throw e
      cloneUrl = normalizeGitUrl(gitRepo)
    }
    return {
      kind: 'gitea',
      repoId: BigInt(administered.repo.id),
      gitRepo: cloneUrl,
      defaultBranch: administered.repo.default_branch ?? 'main',
      access: requestedAccess ?? 'write'
    }
  }
  if (requestedAccess === 'write') {
    refuseWorkspaceCredential(
      `gitea write access requires a repository the connected bot administers — give it admin on ${repoPath}, or check the connection on the Integrations card`
    )
  }
  const repository = await giteaPublicRepository(split.owner, split.repo, gitea.api)
  if (!repository) {
    refuseWorkspaceCredential(
      `${repoPath} is not a Gitea repository the connected bot administers — give it admin on the repository, or check the connection on the Integrations card`
    )
  }
  let cloneUrl: string
  try {
    cloneUrl = normalizeGitCloneUrl(repository.clone_url ?? gitRepo)
  } catch (e) {
    if (!(e instanceof GitCloneUrlError)) throw e
    cloneUrl = normalizeGitUrl(gitRepo)
  }
  return {
    kind: 'anonymous',
    gitRepo: cloneUrl,
    ...(typeof repository.default_branch === 'string' ? { defaultBranch: repository.default_branch } : {}),
    access: 'read',
    host: 'gitea'
  }
}

export const giteaCodeHostProvider: CodeHostProviderModule = {
  provider: 'gitea',
  displayName: 'Gitea',
  repositorySubject: 'repository',
  features: {
    deploymentHost: (deps) => deps.gitea?.api.baseUrl,
    specHost: (spec) => spec.giteaHost,
    ruleHost: (rule) => (rule.provider === 'gitea' ? rule.rule.host : undefined),
    // §11: one string for both gitea.com and a self-hosted address, so a Gitea-shaped value is
    // frame-fatal on any peer without the slice and there is no separate instance bit to add.
    required: () => [GITEA_V1_FEATURE],
    // A spec that CARRIES the axis has a Gitea consumer somewhere — an enabled hook reaching a
    // running session is invisible in the workspace — so the bit is required for it too.
    requiredForInstance: (host) => (host !== undefined ? [GITEA_V1_FEATURE] : [])
  },
  workspace: {
    derive: deriveGiteaWorkspace,
    writeFromDerived: (derived) =>
      derived.kind === 'gitea'
        ? { credential: { provider: 'gitea', access: derived.access }, workspaceRepoId: derived.repoId }
        : null,
    toDto: (credential, workspaceRepoId): AgentWorkspaceCredentialDtoT | null =>
      credential.provider === 'gitea'
        ? { provider: 'gitea', access: credential.access, repoId: (workspaceRepoId ?? 0n).toString() }
        : null,
    // Frame-fatal on a daemon without gitea-v1; every projection path gates on daemonSupportsAgent.
    toSpec: (credential, workspaceRepoId) =>
      credential.provider === 'gitea' ? { provider: 'gitea', repoId: (workspaceRepoId ?? 0n).toString() } : null,
    // No legacy arm: the host-neutral `git` arm predates Gitea, so every peer that can decode a Gitea
    // credential already advertises workspace-git-v1.
    legacySpecArm: () => null
  },
  hooks: {
    // Gitea's run state is a commit status, which is informational by construction: an operator
    // who makes the context a required check has chosen that themselves (§10.4).
    effects: (body) => ({
      reviewPolicy: body.reviewPolicy ?? 'off',
      reportingMode: body.reportingMode ?? 'off',
      gateMode: 'informational'
    }),
    // §7: the saga recomputes the repository's subscription union and its onConverged rebroadcasts the rules.
    convergeManagedRepository: (deps, orgId, repoId, onError) => {
      const gitea = deps.gitea
      if (!gitea || repoId === null) return
      void gitea.provisioner.convergeRepository(orgId, repoId).catch(onError)
    }
  },

  /** Raising the tier raises nothing at the provider (§5): the row's clamp moves and the agent is re-projected. */
  async upgradeRepoAuthorization({ deps, req, reply, orgId, agent, row, access, toDto }) {
    const binding = await deps.repos.giteaRepositoryBinding.byRepo(orgId, row.repoId)
    if (!binding || binding.state === 'cleanup_pending') {
      void reply.code(409).send({
        error: 'Conflict',
        statusCode: 409,
        message: 'the repository is not a managed Gitea repository in this organization'
      })
      return undefined
    }
    const updated = await deps.repos.agentRepoAuth.updateAccess(row.id, access)
    if (!updated) {
      void reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'authorization not found' })
      return undefined
    }
    void deps.repos.audit
      .append({
        kind: 'agent_repo_change',
        orgId,
        agentId: agent.id,
        ...(req.principal ? { actorUserId: req.principal.userId } : {}),
        frameType: 'gitcred/grant',
        message: `gitea repository ${updated.repoFullName} authorization upgraded (${row.access} → ${updated.access})`,
        details: {
          repoAuthId: updated.id,
          provider: 'gitea',
          repoFullName: updated.repoFullName,
          previousAccess: row.access,
          access: updated.access
        }
      })
      .catch(() => {})
    return toDto(updated)
  }
}
