// gitcred leases for Azure DevOps (azure-devops-integration.md §3.4, §6.1): the connection's organization-wide token, served under the agent's tier to the proxy plane only. The grant carries TOKEN MATERIAL — never log it.
import type { GitCredGrant } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { GitCredDeniedError } from '../github/service.js'
import type {
  AgentRecord,
  AgentRepoAuthorizationRepo,
  AzureDevOpsConnectionRecord,
  AzureDevOpsConnectionRepo,
  AzureDevOpsRepositoryBindingRepo
} from '../persistence/ports.js'
import { AzureDevOpsApiError, readConnectionData, type AzureDevOpsApiClient } from './api.js'
import { AzureDevOpsConnectDenied, type AzureDevOpsConnectionService } from './connection.service.js'

/** A lease ends this long before the token inside it, so the proxy never presents an expired one. */
export const LEASE_MARGIN_SEC = 300
/** And never runs longer than this, whatever the token's life. */
const LEASE_MAX_SEC = 3600

export interface AzureDevOpsGitcredDeps {
  connections: Pick<AzureDevOpsConnectionRepo, 'get'>
  bindings: Pick<AzureDevOpsRepositoryBindingRepo, 'byRepo'>
  /** The additional-repository allowlist, the second authority beside the workspace. */
  repoAuths: Pick<AgentRepoAuthorizationRepo, 'listForAgent'>
  service: Pick<AzureDevOpsConnectionService, 'accessToken' | 'withApi'>
  api: AzureDevOpsApiClient
  clock: Clock
}

export class AzureDevOpsGitcredService {
  constructor(private readonly deps: AzureDevOpsGitcredDeps) {}

  /** The workspace repository or an explicit grant, under that authority's tier; a requested access only narrows it. */
  async grantForAgent(
    agent: AgentRecord,
    requestedExternalRepoId?: bigint,
    requestedAccess?: 'read' | 'write'
  ): Promise<GitCredGrant> {
    const { repoId, connectionId, clamp } = await this.authority(agent, requestedExternalRepoId)
    const access: 'read' | 'write' = requestedAccess === 'read' ? 'read' : clamp
    return this.lease(agent.orgId, connectionId, repoId, access)
  }

  /** The repository this request may be served for, the connection that serves it, and its ceiling. */
  private async authority(
    agent: AgentRecord,
    requested?: bigint
  ): Promise<{ repoId: bigint; connectionId: string; clamp: 'read' | 'write' }> {
    const workspace =
      agent.workspace.mode === 'git' && agent.workspace.credential?.provider === 'azure-devops'
        ? agent.workspace.credential
        : undefined
    const workspaceRepo = workspace !== undefined ? agent.workspaceRepoId : undefined
    if (requested === undefined || requested === workspaceRepo) {
      if (workspace === undefined || workspaceRepo === undefined) {
        throw new GitCredDeniedError('agent workspace is not an Azure DevOps repository', 'SCOPE_DENIED', false)
      }
      return { repoId: workspaceRepo, connectionId: workspace.connectionId, clamp: workspace.access }
    }
    const grant = (await this.deps.repoAuths.listForAgent(agent.id)).find(
      (row) => row.provider === 'azure-devops' && row.repoId === requested && row.connectionId !== undefined
    )
    if (!grant?.connectionId) {
      throw new GitCredDeniedError(
        'requested repository is neither this agent’s workspace nor an authorized additional repository',
        'SCOPE_DENIED',
        false
      )
    }
    // `comment` reads only on Azure DevOps (§6.3), so it leases as `read`.
    return { repoId: requested, connectionId: grant.connectionId, clamp: grant.access === 'write' ? 'write' : 'read' }
  }

  private async lease(
    orgId: string,
    connectionId: string,
    repoId: bigint,
    access: 'read' | 'write'
  ): Promise<GitCredGrant> {
    const binding = await this.deps.bindings.byRepo(orgId, connectionId, repoId)
    if (!binding) {
      throw new GitCredDeniedError(
        'the repository is not bound through that Azure DevOps connection',
        'SCOPE_DENIED',
        false
      )
    }
    if (binding.stateReason === 'repository_unavailable') {
      throw new GitCredDeniedError(
        'the repository is deleted, disabled or no longer visible to the application',
        'LEASE_DENIED',
        true
      )
    }
    const connection = await this.deps.connections.get(orgId, connectionId)
    if (!connection) throw new GitCredDeniedError('the Azure DevOps connection is gone', 'SCOPE_DENIED', false)
    const token = await this.token(connection)
    const nowMs = this.deps.clock.now()
    const remainingSec = Math.floor((token.expiresAtMs - nowMs) / 1000)
    const ttlSec = Math.min(LEASE_MAX_SEC, remainingSec - LEASE_MARGIN_SEC)
    if (ttlSec <= 0)
      throw new GitCredDeniedError('the Azure DevOps token is about to expire — retry', 'LEASE_DENIED', true)
    return {
      // Azure DevOps ignores the basic-auth user; the identity's name keeps it readable (§6.4).
      username: connection.identityName ?? connection.identityId,
      token: token.token,
      ttlSec,
      expiresAt: new Date(nowMs + ttlSec * 1000).toISOString(),
      providerExpiresAt: new Date(token.expiresAtMs).toISOString(),
      repoFullName: binding.repoPath,
      access,
      provider: 'azure-devops',
      externalRepoId: repoId.toString(),
      credentialEpoch: connection.credentialEpoch.toString()
    }
  }

  /** The connection's token; a degraded connection first proves access again with one connectionData read (§3.5). */
  private async token(connection: AzureDevOpsConnectionRecord): Promise<{ token: string; expiresAtMs: number }> {
    try {
      if (connection.state === 'degraded') {
        await this.deps.service.withApi(connection, (token) =>
          readConnectionData(this.deps.api, token, connection.organization)
        )
      }
      return await this.deps.service.accessToken(connection)
    } catch (e) {
      if (e instanceof AzureDevOpsConnectDenied) throw new GitCredDeniedError(e.message, 'LEASE_DENIED', true)
      if (e instanceof AzureDevOpsApiError) {
        if (e.code === 'RATE_LIMITED') throw new GitCredDeniedError(`azure devops: ${e.message}`, 'RATE_LIMITED', true)
        const retryable = e.retryable || e.code === 'SECRET_REJECTED' || e.code === 'ACCESS_REVOKED'
        throw new GitCredDeniedError(`azure devops: ${e.message}`, 'LEASE_DENIED', retryable)
      }
      throw e
    }
  }
}
