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
/** Effect leases are action-time (§14.1): enough for one post + one auth retry. */
const EFFECT_LEASE_MAX_SEC = 900
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

  /** §14.1 effect lease: the binding's effect PAT for the note poster, authorized by the enabled hook, not the workspace gitAccess. */
  async grantForHookReply(orgId: string, projectId: bigint): Promise<GitCredGrant> {
    const binding = await this.deps.bindings.byProject(orgId, projectId)
    if (!binding || binding.state === 'cleanup_pending') {
      throw new GitCredDeniedError(
        'the project is not a managed GitLab binding in this organization',
        'SCOPE_DENIED',
        false
      )
    }
    if (binding.state === 'runtime_degraded') {
      throw new GitCredDeniedError('the project binding is runtime-degraded — repair it', 'LEASE_DENIED', true)
    }
    if (binding.serviceAccountUsername === null || binding.serviceAccountUserId === null) {
      throw new GitCredDeniedError('the project binding has no service account yet — repair it', 'LEASE_DENIED', true)
    }
    const credential = await this.deps.credentials.get(binding.id, 'effect')
    if (!credential) {
      throw new GitCredDeniedError('the project binding has no effect credential — repair it', 'LEASE_DENIED', true)
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
      username: binding.serviceAccountUsername,
      token,
      ttlSec,
      expiresAt: new Date(nowMs + ttlSec * 1000).toISOString(),
      repoFullName: binding.projectPath,
      // The wire access field describes CONTENTS capability — 'read' is the conservative label, as for the GitHub hook-reply grant.
      access: 'read',
      provider: 'gitlab',
      externalRepoId: projectId.toString(),
      credentialEpoch: binding.credentialEpoch.toString(),
      providerExpiresAt: credential.providerExpiresAt.toISOString()
    }
  }

  async grantForAgent(
    agent: AgentRecord,
    requestedExternalRepoId?: bigint,
    requestedAccess?: 'read' | 'write'
  ): Promise<GitCredGrant> {
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
    // §19.3: runtime drift stops NEW authority — no fresh local lease until a
    // repair reconverges. admin_degraded (§19.2) keeps serving existing runtime
    // credentials; only the admin plane is broken there.
    if (binding.state === 'runtime_degraded') {
      throw new GitCredDeniedError('the project binding is runtime-degraded — repair it', 'LEASE_DENIED', true)
    }
    if (binding.serviceAccountUsername === null || binding.serviceAccountUserId === null) {
      throw new GitCredDeniedError('the project binding has no service account yet — repair it', 'LEASE_DENIED', true)
    }
    // Access clamp (§13.1): the workspace gitAccess ceiling picks the purpose —
    // read → the read PAT, write → the git_write PAT. The effect PAT is never
    // served through this path (it backs daemon-owned effects, M5). A v2
    // `requestedAccess` may only NARROW the clamp (§17.1): the read-only CLI
    // wrapper asks for read even on a write workspace.
    const clamp: 'read' | 'write' = agent.workspace.gitAccess === 'read' ? 'read' : 'write'
    const access: 'read' | 'write' = requestedAccess === 'read' ? 'read' : clamp
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
