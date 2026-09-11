/**
 * gitcred v2 Gitea grants (gitea-integration.md §4.2, §9, §10): the organization's one bot token,
 * served as a short authorization lease under the agent's access clamp — the workspace repository,
 * or a repository the agent holds an explicit additional authorization on. Every purpose is served
 * from the same token; what differs is the authority checked and the clamp echoed.
 *
 * The grant carries TOKEN MATERIAL — never log it. Every request re-resolves the live binding, the
 * connection's state and its credential epoch.
 */
import type { GitCredGrant } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { GitCredDeniedError } from '../github/service.js'
import type {
  AgentRecord,
  AgentRepoAuthorizationRepo,
  GiteaConnectionRecord,
  GiteaConnectionRepo,
  GiteaConnectionSecretStore,
  GiteaRepositoryBindingRecord,
  GiteaRepositoryBindingRepo
} from '../persistence/ports.js'
import { servesRuntime } from './binding-state.js'

/** Local lease ceiling — the daemon refreshes hourly even though the token never expires (§4.3). */
const LEASE_MAX_SEC = 3600
/** Effect leases are action-time: enough for one post + one auth retry. */
const EFFECT_LEASE_MAX_SEC = 900

export interface GiteaGitcredDeps {
  connections: Pick<GiteaConnectionRepo, 'get'>
  secrets: Pick<GiteaConnectionSecretStore, 'get'>
  bindings: Pick<GiteaRepositoryBindingRepo, 'byRepo'>
  /** The additional-repository allowlist — the second authority beside the workspace. */
  repoAuths: Pick<AgentRepoAuthorizationRepo, 'listForAgent'>
  clock: Clock
  /** The normalized instance base URL (§3), echoed on every grant for the consumer to verify. */
  baseUrl: string
}

export class GiteaGitcredService {
  constructor(private readonly deps: GiteaGitcredDeps) {}

  /** §10.1: the daemon-owned reply poster — its authority is the ENABLED gitea hook, not the workspace clamp. */
  async grantForHookReply(orgId: string, repoId: bigint): Promise<GitCredGrant> {
    // The wire access field describes CONTENTS capability here — 'read' is the conservative label.
    return this.lease(orgId, repoId, 'read', EFFECT_LEASE_MAX_SEC)
  }

  /** §10.2 broker effect lease: authorized by the agent's Gitea workspace binding or an enabled gitea hook. */
  async grantForBrokerEffect(agent: AgentRecord, repoId: bigint, hookAuthorized: boolean): Promise<GitCredGrant> {
    const credential =
      agent.workspace.mode === 'git' &&
      agent.workspace.credential?.provider === 'gitea' &&
      agent.workspaceRepoId === repoId
        ? agent.workspace.credential
        : undefined
    if (credential === undefined && !hookAuthorized) {
      throw new GitCredDeniedError('the agent is not authorized for that gitea repository', 'SCOPE_DENIED', false)
    }
    // The clamp the daemon broker enforces per operation: only a write workspace earns full effect authority.
    const access = credential !== undefined && credential.access !== 'read' ? 'write' : 'comment'
    return this.lease(agent.orgId, repoId, access, EFFECT_LEASE_MAX_SEC)
  }

  /** The Git plane: the workspace repository or an explicit grant, under the authority's clamp (§9). */
  async grantForAgent(
    agent: AgentRecord,
    requestedExternalRepoId?: bigint,
    requestedAccess?: 'read' | 'write'
  ): Promise<GitCredGrant> {
    const { repoId, clamp } = await this.authority(agent, requestedExternalRepoId)
    // A requested access may only NARROW the clamp: the read-only CLI asks for read on a write workspace.
    const access: 'read' | 'write' = requestedAccess === 'read' ? 'read' : clamp
    return this.lease(agent.orgId, repoId, access, LEASE_MAX_SEC)
  }

  /** The repository this request may be served for, and the ceiling it carries. */
  private async authority(
    agent: AgentRecord,
    requestedExternalRepoId?: bigint
  ): Promise<{ repoId: bigint; clamp: 'read' | 'write' }> {
    const workspaceCredential =
      agent.workspace.mode === 'git' && agent.workspace.credential?.provider === 'gitea'
        ? agent.workspace.credential
        : undefined
    const workspaceRepo = workspaceCredential !== undefined ? agent.workspaceRepoId : undefined
    if (requestedExternalRepoId === undefined || requestedExternalRepoId === workspaceRepo) {
      if (workspaceCredential === undefined || workspaceRepo === undefined) {
        throw new GitCredDeniedError('agent workspace is not a managed Gitea repository', 'SCOPE_DENIED', false)
      }
      return { repoId: workspaceRepo, clamp: workspaceCredential.access === 'read' ? 'read' : 'write' }
    }
    const grants = await this.deps.repoAuths.listForAgent(agent.id)
    const grant = grants.find((row) => row.provider === 'gitea' && row.repoId === requestedExternalRepoId)
    if (!grant) {
      throw new GitCredDeniedError(
        'requested repository is neither this agent’s workspace nor an authorized additional repository',
        'SCOPE_DENIED',
        false
      )
    }
    // `comment` earns no push: on Git it is contents-read, the same as `read`.
    return { repoId: requestedExternalRepoId, clamp: grant.access === 'write' ? 'write' : 'read' }
  }

  /** The live binding and its connection, or the denial their lifecycle states earn. */
  private async servable(
    orgId: string,
    repoId: bigint
  ): Promise<{ binding: GiteaRepositoryBindingRecord; connection: GiteaConnectionRecord }> {
    const binding = await this.deps.bindings.byRepo(orgId, repoId)
    if (!binding || binding.state === 'cleanup_pending') {
      throw new GitCredDeniedError(
        'the repository is not a managed Gitea binding in this organization',
        'SCOPE_DENIED',
        false
      )
    }
    // §4.3/§4.4: a rejected token stops NEW authority; admin_degraded keeps serving runtime.
    if (!servesRuntime(binding.state)) {
      throw new GitCredDeniedError(
        'the repository binding is runtime-degraded — replace the token',
        'LEASE_DENIED',
        true
      )
    }
    const connection = await this.deps.connections.get(orgId, binding.connectionId)
    if (!connection) {
      throw new GitCredDeniedError('the repository has no Gitea connection', 'SCOPE_DENIED', false)
    }
    if (connection.state !== 'connected') {
      throw new GitCredDeniedError(
        connection.state === 'token_rejected'
          ? 'the Gitea token was rejected — replace it'
          : 'the Gitea connection is being removed',
        'LEASE_DENIED',
        true
      )
    }
    return { binding, connection }
  }

  private async lease(
    orgId: string,
    repoId: bigint,
    access: 'read' | 'comment' | 'write',
    ttlSec: number
  ): Promise<GitCredGrant> {
    const { binding, connection } = await this.servable(orgId, repoId)
    const token = await this.deps.secrets.get(orgId, connection.id)
    if (!token) {
      throw new GitCredDeniedError('the Gitea token is sealed away — replace it', 'LEASE_DENIED', true)
    }
    const nowMs = this.deps.clock.now()
    return {
      username: connection.botUsername,
      token,
      ttlSec,
      expiresAt: new Date(nowMs + ttlSec * 1000).toISOString(),
      repoFullName: binding.repoPath,
      access,
      provider: 'gitea',
      externalRepoId: repoId.toString(),
      credentialEpoch: connection.credentialEpoch.toString(),
      host: this.deps.baseUrl
    }
  }
}
