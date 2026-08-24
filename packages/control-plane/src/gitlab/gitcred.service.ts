import type { GitCredGrant } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { GitCredDeniedError } from '../github/service.js'
import { GITLAB_CREATION_FORBIDDEN_STATE } from '../persistence/ports.js'
import type {
  AgentRecord,
  AgentRepoAuthorizationRepo,
  GitlabAgentAccountRecord,
  GitlabAgentAccountRepo,
  GitlabProjectBindingRecord,
  GitlabProjectBindingRepo,
  GitlabProjectCredentialRepo,
  GitlabProjectCredentialSecretStore
} from '../persistence/ports.js'

/** Local lease ceiling — the daemon refreshes hourly even though the PAT lives ~90 days. */
const LEASE_MAX_SEC = 3600
/** Effect leases are action-time (§14.1): enough for one post + one auth retry. */
const EFFECT_LEASE_MAX_SEC = 900
/** Clock-skew shave, mirroring the GitHub grant discipline. */
const SKEW_SEC = 60

export interface GitlabGitcredDeps {
  bindings: Pick<GitlabProjectBindingRepo, 'byProject'>
  accounts: Pick<GitlabAgentAccountRepo, 'forAgentBinding'>
  credentials: Pick<GitlabProjectCredentialRepo, 'get'>
  credentialSecrets: Pick<GitlabProjectCredentialSecretStore, 'get'>
  /** The §8.3 additional-project allowlist — the second authority beside the workspace. */
  repoAuths: Pick<AgentRepoAuthorizationRepo, 'listForAgent'>
  clock: Clock
  /** The normalized instance base URL (§24.1), echoed on every grant so the consumer can
   *  verify the host exactly as it verifies provider and project id (§24.4). */
  baseUrl: string
}

/**
 * gitcred v2 GitLab grants (gitlab-com-integration.md §13.1/§17.1): serve the
 * authorized binding's purpose-separated PAT under the agent's access clamp —
 * the workspace project, or a project the agent holds an explicit additional
 * authorization on (§8.3).
 * The grant carries TOKEN MATERIAL — never log it. Every request re-resolves
 * the live binding, the AGENT's own account in that project's root (§7.2), and
 * the credential epoch; the token is the agent account's, never a human's.
 */
export class GitlabGitcredService {
  constructor(private readonly deps: GitlabGitcredDeps) {}

  /** §14.1 effect lease: the HOOK AGENT's own effect PAT for the note poster, authorized by the enabled hook, not the workspace gitAccess. */
  async grantForHookReply(orgId: string, agentId: string, projectId: bigint): Promise<GitCredGrant> {
    // The wire access field describes CONTENTS capability here — 'read' is the conservative label, as for the GitHub hook-reply grant.
    return this.effectGrant(orgId, agentId, projectId, 'read')
  }

  /** §14.2 broker effect lease: the same never-agent-visible effect PAT, authorized by the agent's GitLab workspace binding or an enabled gitlab hook (§13.1). */
  async grantForBrokerEffect(agent: AgentRecord, projectId: bigint, hookAuthorized: boolean): Promise<GitCredGrant> {
    const workspace =
      agent.workspace.mode === 'gitlab' && agent.workspaceRepoId === projectId ? agent.workspace : undefined
    if (workspace === undefined && !hookAuthorized) {
      throw new GitCredDeniedError('the agent is not authorized for that gitlab project', 'SCOPE_DENIED', false)
    }
    // The clamp the daemon broker enforces per operation (§13.1): only a write workspace earns full
    // effect authority; a read workspace or hook-only authorization stays comment-level.
    const access = workspace !== undefined && workspace.gitAccess !== 'read' ? 'write' : 'comment'
    return this.effectGrant(agent.orgId, agent.id, projectId, access)
  }

  /** The purpose=effect PAT on an action-time lease; every request re-resolves the binding, the agent's account, and the epoch. */
  private async effectGrant(
    orgId: string,
    agentId: string,
    projectId: bigint,
    access: 'read' | 'comment' | 'write'
  ): Promise<GitCredGrant> {
    const binding = await this.servableBinding(orgId, projectId)
    const account = await this.agentAccount(orgId, agentId, binding.id)
    const credential = await this.deps.credentials.get(account.id, 'effect')
    if (!credential) {
      throw new GitCredDeniedError('the agent account has no effect credential — repair it', 'LEASE_DENIED', true)
    }
    const token = await this.deps.credentialSecrets.get(orgId, credential.id)
    if (!token) {
      throw new GitCredDeniedError('the project credential is sealed away — repair the binding', 'LEASE_DENIED', true)
    }
    const nowMs = this.deps.clock.now()
    const providerRemainingSec = Math.floor((credential.providerExpiresAt.getTime() - nowMs) / 1000) - SKEW_SEC
    const ttlSec = Math.min(EFFECT_LEASE_MAX_SEC, providerRemainingSec)
    if (ttlSec <= 0) {
      throw new GitCredDeniedError(
        'the project credential has expired — rotation or repair must run',
        'LEASE_DENIED',
        true
      )
    }
    return {
      username: account.username,
      token,
      ttlSec,
      expiresAt: new Date(nowMs + ttlSec * 1000).toISOString(),
      repoFullName: binding.projectPath,
      access,
      provider: 'gitlab',
      externalRepoId: projectId.toString(),
      credentialEpoch: account.credentialEpoch.toString(),
      providerExpiresAt: credential.providerExpiresAt.toISOString(),
      host: this.deps.baseUrl
    }
  }

  /** The live binding, or the denial its lifecycle state earns (§19.2/§19.3). */
  private async servableBinding(orgId: string, projectId: bigint): Promise<GitlabProjectBindingRecord> {
    const binding = await this.deps.bindings.byProject(orgId, projectId)
    if (!binding || binding.state === 'cleanup_pending') {
      throw new GitCredDeniedError(
        'the project is not a managed GitLab binding in this organization',
        'SCOPE_DENIED',
        false
      )
    }
    // §19.3: runtime drift stops NEW authority — no fresh local lease until a
    // repair reconverges. admin_degraded (§19.2) keeps serving existing runtime
    // credentials; only the admin plane is broken there.
    if (binding.state === 'runtime_degraded') {
      throw new GitCredDeniedError('the project binding is runtime-degraded — repair it', 'LEASE_DENIED', true)
    }
    return binding
  }

  /** §7.2: the agent's own account on this project. Its membership IS its
   *  authorization, so an unbound or unprovisioned agent gets nothing. */
  private async agentAccount(orgId: string, agentId: string, bindingId: string): Promise<GitlabAgentAccountRecord> {
    const account = await this.deps.accounts.forAgentBinding(orgId, agentId, bindingId)
    // §24.3: withdrawn creation authority is the one non-ready state that still
    // serves. It cannot mint or rotate, so the credential's own expiry — checked
    // by every caller below — is the bound, exactly the §19.1 degradation.
    const servable = account?.state === 'ready' || account?.state === GITLAB_CREATION_FORBIDDEN_STATE
    if (!account || account.serviceAccountUserId === null || !servable) {
      throw new GitCredDeniedError(
        'the agent has no ready GitLab account on that project — repair it',
        'LEASE_DENIED',
        true
      )
    }
    return account
  }

  /**
   * The project this request may be served for, and the ceiling it carries (§13.1
   * step 3, §8.3). Two authorities, exactly as GitHub has: the agent's workspace
   * project, and an explicit additional authorization. A project that is neither is
   * a denial, never a fallback onto the workspace.
   */
  private async authority(
    agent: AgentRecord,
    requestedExternalRepoId?: bigint
  ): Promise<{ projectId: bigint; clamp: 'read' | 'write' }> {
    const workspaceProject = agent.workspace.mode === 'gitlab' ? agent.workspaceRepoId : undefined
    if (requestedExternalRepoId === undefined || requestedExternalRepoId === workspaceProject) {
      if (agent.workspace.mode !== 'gitlab' || workspaceProject === undefined) {
        throw new GitCredDeniedError('agent workspace is not a managed GitLab project', 'SCOPE_DENIED', false)
      }
      return { projectId: workspaceProject, clamp: agent.workspace.gitAccess === 'read' ? 'read' : 'write' }
    }
    const grants = await this.deps.repoAuths.listForAgent(agent.id)
    const grant = grants.find((row) => row.provider === 'gitlab' && row.repoId === requestedExternalRepoId)
    if (!grant) {
      throw new GitCredDeniedError(
        'requested project is neither this agent’s workspace nor an authorized additional project',
        'SCOPE_DENIED',
        false
      )
    }
    // `comment` earns no push: on Git it is contents-read, the same as `read` (§13.1).
    return { projectId: requestedExternalRepoId, clamp: grant.access === 'write' ? 'write' : 'read' }
  }

  async grantForAgent(
    agent: AgentRecord,
    requestedExternalRepoId?: bigint,
    requestedAccess?: 'read' | 'write'
  ): Promise<GitCredGrant> {
    const { projectId, clamp } = await this.authority(agent, requestedExternalRepoId)
    const binding = await this.servableBinding(agent.orgId, projectId)
    const account = await this.agentAccount(agent.orgId, agent.id, binding.id)
    // Access clamp (§13.1): the authority's ceiling picks the purpose — read → the
    // read PAT, write → the git_write PAT. The effect PAT is never served through
    // this path (it backs daemon-owned effects, M5). A v2 `requestedAccess` may only
    // NARROW the clamp (§17.1): the read-only CLI wrapper asks for read even on a
    // write workspace.
    const access: 'read' | 'write' = requestedAccess === 'read' ? 'read' : clamp
    const purpose = access === 'read' ? 'read' : 'git_write'
    const credential = await this.deps.credentials.get(account.id, purpose)
    if (!credential) {
      throw new GitCredDeniedError('the agent account has no usable credential — repair it', 'LEASE_DENIED', true)
    }
    const token = await this.deps.credentialSecrets.get(agent.orgId, credential.id)
    if (!token) {
      throw new GitCredDeniedError('the project credential is sealed away — repair the binding', 'LEASE_DENIED', true)
    }
    const nowMs = this.deps.clock.now()
    const providerRemainingSec = Math.floor((credential.providerExpiresAt.getTime() - nowMs) / 1000) - SKEW_SEC
    const ttlSec = Math.min(LEASE_MAX_SEC, providerRemainingSec)
    if (ttlSec <= 0) {
      throw new GitCredDeniedError(
        'the project credential has expired — rotation or repair must run',
        'LEASE_DENIED',
        true
      )
    }
    return {
      username: account.username,
      token,
      ttlSec,
      expiresAt: new Date(nowMs + ttlSec * 1000).toISOString(),
      repoFullName: binding.projectPath,
      access,
      provider: 'gitlab',
      externalRepoId: projectId.toString(),
      credentialEpoch: account.credentialEpoch.toString(),
      providerExpiresAt: credential.providerExpiresAt.toISOString(),
      host: this.deps.baseUrl
    }
  }
}
