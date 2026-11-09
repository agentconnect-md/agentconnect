// gitcred leases for Azure DevOps (azure-devops-integration.md §3.4, §6.1): the connection's organization-wide token, served under the agent's tier to the proxy plane only. The grant carries TOKEN MATERIAL — never log it.
import type { GitCredGrant } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import { GitCredDeniedError } from '../github/service.js'
import type {
  AgentRecord,
  AgentRepo,
  AgentRepoAuthorizationRepo,
  AzureDevOpsConnectionRecord,
  AzureDevOpsConnectionRepo,
  AzureDevOpsRepositoryBindingRepo
} from '../persistence/ports.js'
import { isHonoredRepoGrant } from '../persistence/ports.js'
import { AzureDevOpsApiError, readConnectionData, type AzureDevOpsApiClient } from './api.js'
import { AzureDevOpsConnectDenied, type AzureDevOpsConnectionService } from './connection.service.js'
import { LEASE_MARGIN_MS } from './token-cache.js'
import { hookBindingOf } from './hook.service.js'
import type { AzureDevOpsUserAuthzService } from './user-authz.js'
import { AZURE_STALE_REASON_TEXT } from './repository-grant-reattestor.js'

/** A lease ends this long before the token inside it, so the proxy never presents an expired one. */
export const LEASE_MARGIN_SEC = LEASE_MARGIN_MS / 1000
/** And never runs longer than this, whatever the token's life. */
const LEASE_MAX_SEC = 3600
/** A degraded connection's failed probe is trusted this long, so leases do not re-probe Entra on every request. */
export const DEGRADED_PROBE_HOLD_MS = 60_000
/** A forced refresh purges the connection's token at most this often, so a client cannot hammer Entra. */
export const FORCE_REFRESH_MIN_INTERVAL_MS = 30_000

export interface AzureDevOpsGitcredDeps {
  agents: Pick<AgentRepo, 'get'>
  authz: Pick<AzureDevOpsUserAuthzService, 'attestAccess'>
  connections: Pick<AzureDevOpsConnectionRepo, 'get'>
  bindings: Pick<AzureDevOpsRepositoryBindingRepo, 'byRepo' | 'listForRepo'>
  /** The additional-repository allowlist, the second authority beside the workspace. */
  repoAuths: Pick<AgentRepoAuthorizationRepo, 'listForAgent'>
  service: Pick<AzureDevOpsConnectionService, 'accessToken' | 'withApi' | 'purgeToken'>
  api: AzureDevOpsApiClient
  clock: Clock
}

interface Authority {
  repoId: bigint
  connectionId: string
  clamp: 'read' | 'write'
  attestedByUserId: string | null
  grantId: string | null
}

export class AzureDevOpsGitcredService {
  /** Connection → when its last degraded probe failed. */
  private readonly failedProbes = new Map<string, number>()
  /** Connection → when a forced refresh last purged its token. */
  private readonly forcedAt = new Map<string, number>()

  constructor(private readonly deps: AzureDevOpsGitcredDeps) {}

  /** The workspace repository or an explicit grant, under that authority's tier; a requested access only narrows it. */
  async grantForAgent(
    agent: AgentRecord,
    requestedExternalRepoId?: bigint,
    requestedAccess?: 'read' | 'write',
    forceRefresh = false
  ): Promise<GitCredGrant> {
    const authority = await this.authority(agent, requestedExternalRepoId)
    const { repoId, connectionId, clamp } = authority
    const access: 'read' | 'write' = requestedAccess === 'read' ? 'read' : clamp
    const grant = await this.lease(agent.orgId, connectionId, repoId, access, forceRefresh, authority)
    // A completed external check cannot lend its authority to a replacement workspace or grant.
    const current = await this.deps.agents.get(agent.orgId, agent.id)
    const next = current && (await this.authority(current, requestedExternalRepoId))
    if (
      !next ||
      next.repoId !== repoId ||
      next.connectionId !== connectionId ||
      next.clamp !== clamp ||
      next.attestedByUserId !== authority.attestedByUserId ||
      next.grantId !== authority.grantId
    ) {
      throw new GitCredDeniedError(
        'repository authorization changed while verifying access — retry',
        'LEASE_DENIED',
        true
      )
    }
    return grant
  }

  /** §11.5: the final poster's lease, at `comment` on the repository's hooked binding; the handler already checked the enabled hook. */
  async grantForHookReply(orgId: string, repoId: bigint, forceRefresh = false): Promise<GitCredGrant> {
    const binding = hookBindingOf(await this.deps.bindings.listForRepo(orgId, repoId))
    if (!binding) {
      throw new GitCredDeniedError(
        'the repository is not bound through an Azure DevOps connection',
        'SCOPE_DENIED',
        false
      )
    }
    return this.lease(orgId, binding.connectionId, repoId, 'comment', forceRefresh)
  }

  /** The repository this request may be served for, the connection that serves it, and its ceiling. */
  private async authority(agent: AgentRecord, requested?: bigint): Promise<Authority> {
    const workspace =
      agent.workspace.mode === 'git' && agent.workspace.credential?.provider === 'azure-devops'
        ? agent.workspace.credential
        : undefined
    const workspaceRepo = workspace !== undefined ? agent.workspaceRepoId : undefined
    if (requested === undefined || requested === workspaceRepo) {
      if (workspace === undefined || workspaceRepo === undefined) {
        throw new GitCredDeniedError('agent workspace is not an Azure DevOps repository', 'SCOPE_DENIED', false)
      }
      return {
        repoId: workspaceRepo,
        connectionId: workspace.connectionId,
        clamp: workspace.access,
        attestedByUserId: workspace.attestedByUserId,
        grantId: null
      }
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
    if (!isHonoredRepoGrant(grant)) {
      throw new GitCredDeniedError(
        `repository authorization is suspended: ${AZURE_STALE_REASON_TEXT[grant.stale!.reason]}`,
        'LEASE_DENIED',
        false
      )
    }
    // `comment` reads only on Azure DevOps (§6.3), so it leases as `read`.
    return {
      repoId: requested,
      connectionId: grant.connectionId,
      clamp: grant.access === 'write' ? 'write' : 'read',
      attestedByUserId: grant.attestedByUserId,
      grantId: grant.id
    }
  }

  private async lease(
    orgId: string,
    connectionId: string,
    repoId: bigint,
    access: 'read' | 'comment' | 'write',
    forceRefresh: boolean,
    authority?: Authority
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
    if (authority) {
      let reason
      try {
        reason = await this.deps.authz.attestAccess(
          authority.attestedByUserId,
          {
            connection,
            repository: { id: binding.repositoryId, projectId: binding.projectId }
          },
          authority.clamp
        )
      } catch (error) {
        const code = error instanceof AzureDevOpsApiError && error.code === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'INTERNAL'
        throw new GitCredDeniedError(
          'could not verify the repository authorizer’s Azure DevOps access — retry',
          code,
          true
        )
      }
      if (reason)
        throw new GitCredDeniedError(
          `repository authorization is suspended: ${AZURE_STALE_REASON_TEXT[reason]}`,
          'LEASE_DENIED',
          false
        )
    }
    if (forceRefresh) this.purgeForced(connection.id)
    const token = await this.token(connection)
    const nowMs = this.deps.clock.now()
    const remainingSec = Math.floor((token.expiresAtMs - nowMs) / 1000)
    const ttlSec = Math.min(LEASE_MAX_SEC, remainingSec - LEASE_MARGIN_SEC)
    if (ttlSec <= 0)
      throw new GitCredDeniedError('the Azure DevOps token is about to expire — retry', 'LEASE_DENIED', true)
    return {
      // Azure DevOps ignores the basic-auth user; the identity id is a GUID, never a customer-chosen name with a colon (§3.4).
      username: connection.identityId,
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

  /** A forced refresh drops the cached token, at most once per interval per connection. */
  private purgeForced(connectionId: string): void {
    const now = this.deps.clock.now()
    const last = this.forcedAt.get(connectionId)
    if (last !== undefined && now - last < FORCE_REFRESH_MIN_INTERVAL_MS) return
    this.forcedAt.set(connectionId, now)
    this.deps.service.purgeToken(connectionId)
  }

  /** The connection's token; a degraded connection first proves access again with one connectionData read, at most once a minute (§3.5). */
  private async token(connection: AzureDevOpsConnectionRecord): Promise<{ token: string; expiresAtMs: number }> {
    const now = this.deps.clock.now()
    try {
      if (connection.state === 'degraded') {
        const failedAt = this.failedProbes.get(connection.id)
        if (failedAt !== undefined && now - failedAt < DEGRADED_PROBE_HOLD_MS) {
          throw new GitCredDeniedError(
            `the Azure DevOps connection is degraded (${connection.stateReason ?? 'unknown'}) — retry later`,
            'LEASE_DENIED',
            true
          )
        }
        try {
          await this.deps.service.withApi(connection, (token) =>
            readConnectionData(this.deps.api, token, connection.organization)
          )
        } catch (e) {
          this.failedProbes.set(connection.id, now)
          throw e
        }
        this.failedProbes.delete(connection.id)
      }
      return await this.deps.service.accessToken(connection)
    } catch (e) {
      if (e instanceof GitCredDeniedError) throw e
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
