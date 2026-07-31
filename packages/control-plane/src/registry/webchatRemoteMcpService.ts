import type {
  WebchatMcpGrantAccept,
  WebchatMcpGrantIssue,
  WebchatMcpGrantRevoke,
  WebchatRemoteMcpEntitlement
} from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId } from '../domain/ids.js'
import type { Clock } from '../domain/clock.js'
import type { WebchatMcpAccessGrantRepo, WebchatMcpDelegationRepo } from '../persistence/ports.js'
import type { WebchatMcpGrantTokenCodec } from './webchatMcpGrantToken.js'
import { resolveLiveWebchatMcpAuthority, type LiveWebchatMcpAuthorityDeps } from './webchatMcpAuthority.js'

export const WEBCHAT_MCP_AUTHORITY_TTL_MS = 12 * 60 * 60_000
export const WEBCHAT_MCP_GRANT_TTL_MS = 30 * 60_000
export const WEBCHAT_MCP_PENDING_TTL_MS = 2 * 60_000

export interface EstablishRemoteMcpInput {
  conversationId: string
  verifiedUserId: string
  orgId: string
  agentId: string
  daemonId: string
  sessionExpiresAt?: Date
}

export interface WebchatRemoteMcpServiceDeps extends LiveWebchatMcpAuthorityDeps {
  clock: Pick<Clock, 'now'>
  tokenCodec: WebchatMcpGrantTokenCodec
  authorities: Pick<WebchatMcpDelegationRepo, 'establish' | 'getCurrent'>
  grants: WebchatMcpAccessGrantRepo
  mcpUrl: string
}

export class WebchatRemoteMcpService {
  constructor(private readonly deps: WebchatRemoteMcpServiceDeps) {}

  async establish(input: EstablishRemoteMcpInput): Promise<WebchatRemoteMcpEntitlement | null> {
    const now = new Date(this.deps.clock.now())
    const defaultExpiry = new Date(now.getTime() + WEBCHAT_MCP_AUTHORITY_TTL_MS)
    const expiresAt =
      input.sessionExpiresAt && input.sessionExpiresAt < defaultExpiry ? input.sessionExpiresAt : defaultExpiry
    if (expiresAt <= now) return null
    const live = await resolveLiveWebchatMcpAuthority(this.deps, {
      conversationId: input.conversationId,
      expectedUserId: input.verifiedUserId,
      orgId: input.orgId,
      agentId: input.agentId,
      daemonId: input.daemonId
    })
    if (!live.ok) return null
    const authority = await this.deps.authorities.establish({
      conversationId: input.conversationId,
      userId: live.userId,
      orgId: OrgId(input.orgId),
      agentId: AgentId(input.agentId),
      daemonId: DaemonId(input.daemonId),
      now,
      expiresAt
    })
    return authority
      ? {
          authorityId: authority.id,
          authorityGeneration: authority.generation,
          expiresAt: authority.expiresAt.toISOString()
        }
      : null
  }

  async issue(input: WebchatMcpGrantIssue & { authenticatedDaemonId: string }) {
    const now = new Date(this.deps.clock.now())
    const authority = await this.deps.authorities.getCurrent(input.authorityId)
    if (
      !authority ||
      authority.generation !== input.authorityGeneration ||
      authority.conversationId !== input.conversationId ||
      authority.daemonId !== input.authenticatedDaemonId ||
      authority.revokedAt ||
      authority.expiresAt <= now
    ) {
      return null
    }
    const live = await resolveLiveWebchatMcpAuthority(this.deps, {
      conversationId: authority.conversationId,
      expectedUserId: authority.userId,
      orgId: authority.orgId,
      agentId: authority.agentId,
      daemonId: authority.daemonId
    })
    if (!live.ok) return null

    const token = this.deps.tokenCodec.mint()
    const expiresAt = new Date(Math.min(authority.expiresAt.getTime(), now.getTime() + WEBCHAT_MCP_GRANT_TTL_MS))
    const grant = await this.deps.grants.issue({
      ...input,
      tokenHash: token.tokenHash,
      now,
      pendingExpiresAt: new Date(now.getTime() + WEBCHAT_MCP_PENDING_TTL_MS),
      expiresAt
    })
    return grant
      ? {
          authorityId: input.authorityId,
          authorityGeneration: input.authorityGeneration,
          conversationId: input.conversationId,
          descriptorInstanceId: input.descriptorInstanceId,
          grantRevision: grant.grantRevision,
          grantId: grant.id,
          token: token.plaintext,
          expiresAt: grant.expiresAt.toISOString(),
          mcpUrl: this.deps.mcpUrl
        }
      : null
  }

  async accept(input: WebchatMcpGrantAccept & { authenticatedDaemonId: string }) {
    return this.deps.grants.accept({ ...input, now: new Date(this.deps.clock.now()) })
  }

  async revoke(input: WebchatMcpGrantRevoke & { authenticatedDaemonId: string }): Promise<boolean> {
    return this.deps.grants.revokeAuthority({
      ...input,
      now: new Date(this.deps.clock.now())
    })
  }
}
