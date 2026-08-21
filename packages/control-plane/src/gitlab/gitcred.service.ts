import type { GitCredGrant } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { GitCredDeniedError } from '../github/service.js'
import type {
  AgentRecord,
  GitlabProjectBindingRepo,
  GitlabProjectCredentialRepo,
  GitlabProjectCredentialSecretStore
} from '../persistence/ports.js'

/** Local lease ceiling — the daemon refreshes hourly even though the PAT lives ~90 days. */
const LEASE_MAX_SEC = 3600
/** Clock-skew shave, mirroring the GitHub grant discipline. */
const SKEW_SEC = 60

export interface GitlabGitcredDeps {
  bindings: Pick<GitlabProjectBindingRepo, 'byProject'>
  credentials: Pick<GitlabProjectCredentialRepo, 'get'>
  credentialSecrets: Pick<GitlabProjectCredentialSecretStore, 'get'>
  clock: Clock
}

/**
 * gitcred v2 GitLab grants (gitlab-com-integration.md §13.1/§17.1): serve the
 * workspace binding's purpose-separated PAT under the agent's access clamp.
 * The grant carries TOKEN MATERIAL — never log it. Every request re-resolves
 * the live binding, membership facts, and credential epoch; there is no
 * per-agent minting (the credential is the project service account's).
 */
export class GitlabGitcredService {
  constructor(private readonly deps: GitlabGitcredDeps) {}

  async grantForAgent(agent: AgentRecord, requestedExternalRepoId?: bigint): Promise<GitCredGrant> {
    if (agent.workspace.mode !== 'gitlab' || agent.workspaceRepoId === undefined) {
      throw new GitCredDeniedError('agent workspace is not a managed GitLab project', 'SCOPE_DENIED', false)
    }
    const projectId = agent.workspaceRepoId
    // v1 scope: the workspace project only. Additional-repo authorization rows
    // are GitHub-shaped today; a foreign id is a denial, not a fallback.
    if (requestedExternalRepoId !== undefined && requestedExternalRepoId !== projectId) {
      throw new GitCredDeniedError('requested project is not this agent workspace', 'SCOPE_DENIED', false)
    }
    const binding = await this.deps.bindings.byProject(agent.orgId, projectId)
    if (!binding || binding.state === 'cleanup_pending') {
      throw new GitCredDeniedError(
        'the project is not a managed GitLab binding in this organization',
        'SCOPE_DENIED',
        false
      )
    }
    if (binding.serviceAccountUsername === null || binding.serviceAccountUserId === null) {
      throw new GitCredDeniedError('the project binding has no service account yet — repair it', 'LEASE_DENIED', true)
    }
    // Access clamp (§13.1): the workspace gitAccess ceiling picks the purpose —
    // read → the read PAT, write → the git_write PAT. The effect PAT is never
    // served through this path (it backs daemon-owned effects, M5).
    const access: 'read' | 'write' = agent.workspace.gitAccess === 'read' ? 'read' : 'write'
    const purpose = access === 'read' ? 'read' : 'git_write'
    const credential = await this.deps.credentials.get(binding.id, purpose)
    if (!credential) {
      throw new GitCredDeniedError('the project binding has no usable credential — repair it', 'LEASE_DENIED', true)
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
      username: binding.serviceAccountUsername,
      token,
      ttlSec,
      expiresAt: new Date(nowMs + ttlSec * 1000).toISOString(),
      repoFullName: binding.projectPath,
      access,
      provider: 'gitlab',
      externalRepoId: projectId.toString(),
      credentialEpoch: binding.credentialEpoch.toString(),
      providerExpiresAt: credential.providerExpiresAt.toISOString()
    }
  }
}
