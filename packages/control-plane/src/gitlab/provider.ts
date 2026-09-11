/**
 * The GitLab entry of the code-host provider registry (`codehost/provider.ts`).
 *
 * GitLab is the half that made each member a member: a managed project binding
 * vouches for a workspace, every hook write re-converges the project's webhook
 * and §7.2 memberships, a self-managed instance adds a negotiated feature, and a
 * grant tier is also a project role. The binding lifecycle itself — OAuth
 * administration, service accounts, PAT rotation, the rerun authorizer — stays in
 * its own services: it has no GitHub counterpart to share a shape with.
 */
import {
  GITLAB_COM_V1_FEATURE,
  GITLAB_INSTANCE_V1_FEATURE,
  GitCloneUrlError,
  isSelfManagedGitlabHost,
  normalizeGitCloneUrl,
  normalizeGitUrl
} from '@agentconnect.md/protocol'
import {
  refuseWorkspaceCredential,
  type CodeHostProviderModule,
  type CodeHostWorkspaceDerivation,
  type DerivedWorkspace
} from '../codehost/provider.js'
import type { AgentWorkspaceCredentialDtoT } from '../http/dto/index.js'
import { gitlabManagedProjectPath } from '../domain/git-host.js'
import { gitlabAuthorizationAccessLevel, gitlabPublicProject } from './api.js'
import { gitlabAccountUnavailableMessage } from './account.service.js'

/** The gitlab arm of the §6 outcome table: a managed binding, else an anonymous public project. */
async function deriveGitlabWorkspace(derivation: CodeHostWorkspaceDerivation): Promise<DerivedWorkspace | null> {
  const { deps, orgId, gitRepo, requestedAccess } = derivation
  const gitlab = deps.gitlab
  const gitlabPath = gitlab ? gitlabManagedProjectPath(gitRepo, gitlab.api.baseUrl) : null
  if (!gitlabPath || !gitlab) return null
  const binding = await deps.repos.gitlabProjectBinding.byProjectPath(orgId, gitlabPath)
  if (binding) {
    // A binding mid-removal must refuse, never demote to an anonymous clone of
    // the same path — the managed identity still exists until cleanup finishes.
    if (binding.state === 'cleanup_pending') {
      refuseWorkspaceCredential(`${gitlabPath} is being removed from this organization — wait for cleanup to finish`)
    }
    // The persisted catalog row, not caller input and never a composed URL, is
    // the authority for the clone URL (§24.1).
    const catalogRow = await deps.repos.codeHostRepository.byExternalId(orgId, 'gitlab', binding.projectId)
    if (!catalogRow?.cloneUrl) {
      refuseWorkspaceCredential('the GitLab project binding has no clone URL yet — repair the project first')
    }
    return {
      kind: 'gitlab',
      projectId: binding.projectId,
      gitRepo: catalogRow.cloneUrl,
      defaultBranch: binding.defaultBranch ?? 'main',
      // A managed binding always mints, so an unstated tier is write.
      access: requestedAccess ?? 'write'
    }
  }
  if (requestedAccess === 'write') {
    refuseWorkspaceCredential(
      'gitlab write access requires a managed project — add the project to the organization first'
    )
  }
  const project = await gitlabPublicProject(gitlabPath, gitlab.api)
  if (!project) {
    refuseWorkspaceCredential(
      `${gitlabPath} is not a managed GitLab project in this organization — add the project first`
    )
  }
  // The provider's own clone URL, held to the same codec every stored address
  // passes; a malformed answer falls back to the caller's normalized input.
  let cloneUrl: string
  try {
    cloneUrl = normalizeGitCloneUrl(project.http_url_to_repo ?? gitRepo)
  } catch (e) {
    if (!(e instanceof GitCloneUrlError)) throw e
    cloneUrl = normalizeGitUrl(gitRepo)
  }
  return {
    kind: 'anonymous',
    gitRepo: cloneUrl,
    ...(typeof project.default_branch === 'string' ? { defaultBranch: project.default_branch } : {}),
    access: 'read',
    host: 'gitlab'
  }
}

export const gitlabCodeHostProvider: CodeHostProviderModule = {
  provider: 'gitlab',
  displayName: 'GitLab',
  repositorySubject: 'project',
  features: {
    deploymentHost: (deps) => deps.gitlab?.api.baseUrl,
    specHost: (spec) => spec.gitlabHost,
    ruleHost: (rule) => (rule.provider === 'gitlab' ? rule.rule.host : undefined),
    // §17.3: a GitLab-shaped value is frame-fatal on a pre-GitLab peer. §24.4: a
    // value on a self-managed instance additionally needs the per-agent host bit.
    required: (host) => [GITLAB_COM_V1_FEATURE, ...(isSelfManagedGitlabHost(host) ? [GITLAB_INSTANCE_V1_FEATURE] : [])],
    requiredForInstance: (host) => (isSelfManagedGitlabHost(host) ? [GITLAB_INSTANCE_V1_FEATURE] : [])
  },
  workspace: {
    derive: deriveGitlabWorkspace,
    writeFromDerived: (derived) =>
      derived.kind === 'gitlab'
        ? { credential: { provider: 'gitlab', access: derived.access }, workspaceRepoId: derived.projectId }
        : null,
    toDto: (credential, workspaceRepoId): AgentWorkspaceCredentialDtoT | null =>
      credential.provider === 'gitlab'
        ? { provider: 'gitlab', access: credential.access, projectId: (workspaceRepoId ?? 0n).toString() }
        : null,
    // A gitlab-vouched workspace is frame-fatal on a pre-GitLab daemon; every
    // projection path gates on daemonSupportsAgent before sending it.
    toSpec: (credential, workspaceRepoId) =>
      credential.provider === 'gitlab' ? { provider: 'gitlab', projectId: (workspaceRepoId ?? 0n).toString() } : null,
    legacySpecArm: (shared, credential) =>
      credential.provider === 'gitlab' ? { mode: 'gitlab', ...shared, projectId: credential.projectId } : null
  },
  hooks: {
    // `check` is the §16 run note. No gateMode: GitLab has no required-gate
    // surface, so a row of this kind stays informational.
    effects: (body) => ({
      reviewPolicy: body.reviewPolicy ?? 'off',
      reportingMode: body.reportingMode ?? 'off',
      gateMode: 'informational'
    }),
    // §11.1: the saga recomputes the project's desired event union, gives each
    // consumer its own §7.2 account and membership, and its onConverged
    // rebroadcasts the compiled rules. The saga itself outwaits a peer's lease.
    convergeManagedRepository: (deps, orgId, repoId, onError) => {
      const gitlab = deps.gitlab
      if (!gitlab || repoId === null) return
      void gitlab.provisioner.convergeProject(orgId, repoId).catch(onError)
    }
  },

  /** Raising the tier raises the account's project role, so it re-runs the same ensure the grant took. */
  async upgradeRepoAuthorization({ deps, req, reply, orgId, agent, row, access, toDto }) {
    const conflict = (message: string): undefined => {
      void reply.code(409).send({ error: 'Conflict', statusCode: 409, message })
    }
    const gitlab = deps.gitlab
    if (!gitlab) return conflict('GitLab is not configured on this deployment')
    const binding = await deps.repos.gitlabProjectBinding.byProject(orgId, row.repoId)
    if (!binding || binding.state === 'cleanup_pending') {
      return conflict('the project is not a managed GitLab project in this organization')
    }
    const applied = await gitlab.provisioner.provisionAgentAccount(
      orgId,
      row.repoId,
      { agentId: agent.id, accessLevel: gitlabAuthorizationAccessLevel(access) },
      // Access-only: the row's path is converged by the same lease's fact sync.
      () => deps.repos.agentRepoAuth.updateAccess(row.id, access)
    )
    if (!applied.ok) return conflict(gitlabAccountUnavailableMessage(applied.reason))
    const updated = applied.result
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
        message: `gitlab project ${updated.repoFullName} authorization upgraded (${row.access} → ${updated.access})`,
        details: {
          repoAuthId: updated.id,
          provider: 'gitlab',
          repoFullName: updated.repoFullName,
          previousAccess: row.access,
          access: updated.access
        }
      })
      .catch(() => {})
    return toDto(updated)
  }
}
