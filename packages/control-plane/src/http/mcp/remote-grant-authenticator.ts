import { createHash } from 'node:crypto'
import type { Clock } from '../../domain/clock.js'
import type { AgentId } from '../../domain/ids.js'
import type { WebchatMcpAccessGrantRepo, WebchatMcpDelegationRepo } from '../../persistence/ports.js'
import type { WebchatMcpGrantTokenCodec } from '../../registry/webchatMcpGrantToken.js'
import { resolveLiveWebchatMcpAuthority, type LiveWebchatMcpAuthorityDeps } from '../../registry/webchatMcpAuthority.js'

export interface InvocationContext {
  /** Request-local correlation only; delegated write identity lives in the operation ledger. */
  invocationId: string
  conversationId: string
  grantId: string
  authorityGeneration: number
  agentId: string
  daemonId: string
  orgId: string
  userId: string
  startedAt: Date
  requestId?: string
  requestHash: string
  method: 'tools/list' | 'tools/call'
  toolName?: string
}

export interface ParsedInvocationMetadata {
  method: 'tools/list' | 'tools/call'
  requestId?: string
  toolName?: string
}

export type RemoteGrantClaimResult =
  { kind: 'execute'; context: InvocationContext } | { kind: 'denied'; reason: string }

export interface RemoteGrantAuthenticatorDeps extends LiveWebchatMcpAuthorityDeps {
  clock: Pick<Clock, 'now'>
  sessions: { hasPrivateWebchatSession(conversationId: string, agentId: AgentId): Promise<boolean> }
  tokenCodec: Pick<WebchatMcpGrantTokenCodec, 'hash'>
  grants: Pick<WebchatMcpAccessGrantRepo, 'getByTokenHash'>
  authorities: Pick<WebchatMcpDelegationRepo, 'getCurrent'>
  isCuratedTool(toolName: string): boolean
}

export class RemoteGrantAuthenticator {
  constructor(private readonly deps: RemoteGrantAuthenticatorDeps) {}

  async authenticate(input: {
    bearer: string
    requestBytes: Uint8Array
    parseMetadata(): ParsedInvocationMetadata | Promise<ParsedInvocationMetadata>
  }): Promise<RemoteGrantClaimResult> {
    const tokenHash = this.deps.tokenCodec.hash(input.bearer)
    if (!tokenHash) return { kind: 'denied', reason: 'credential' }
    const now = new Date(this.deps.clock.now())
    const grant = await this.deps.grants.getByTokenHash(tokenHash)
    if (!grant || grant.status !== 'active' || grant.revokedAt || grant.expiresAt <= now) {
      return { kind: 'denied', reason: 'grant_inactive' }
    }
    const authority = await this.deps.authorities.getCurrent(grant.authorityId)
    if (!authority || authority.revokedAt || authority.expiresAt <= now) {
      return { kind: 'denied', reason: 'authority_inactive' }
    }
    const live = await resolveLiveWebchatMcpAuthority(this.deps, {
      conversationId: authority.conversationId,
      expectedUserId: authority.userId,
      orgId: authority.orgId,
      agentId: authority.agentId,
      daemonId: authority.daemonId
    })
    if (!live.ok) return { kind: 'denied', reason: live.reason }
    if (!(await this.deps.sessions.hasPrivateWebchatSession(authority.conversationId, authority.agentId as AgentId))) {
      return { kind: 'denied', reason: 'session_not_private' }
    }

    let metadata: ParsedInvocationMetadata
    try {
      metadata = await input.parseMetadata()
    } catch {
      return { kind: 'denied', reason: 'metadata' }
    }
    if (
      (metadata.method !== 'tools/list' && metadata.method !== 'tools/call') ||
      (metadata.method === 'tools/list' && metadata.toolName !== undefined) ||
      (metadata.method === 'tools/call' && (!metadata.toolName || !this.deps.isCuratedTool(metadata.toolName)))
    ) {
      return { kind: 'denied', reason: 'tool' }
    }
    return {
      kind: 'execute',
      context: {
        invocationId: createHash('sha256')
          .update(`${grant.id}\0${metadata.requestId ?? createHash('sha256').update(input.requestBytes).digest('hex')}`)
          .digest('hex'),
        conversationId: authority.conversationId,
        grantId: grant.id,
        authorityGeneration: authority.generation,
        agentId: authority.agentId,
        daemonId: authority.daemonId,
        orgId: authority.orgId,
        userId: authority.userId,
        startedAt: now,
        ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
        requestHash: createHash('sha256').update(input.requestBytes).digest('hex'),
        method: metadata.method,
        ...(metadata.toolName ? { toolName: metadata.toolName } : {})
      }
    }
  }
}
