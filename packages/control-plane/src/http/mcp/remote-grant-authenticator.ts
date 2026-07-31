import { createHash } from 'node:crypto'
import type { Clock } from '../../domain/clock.js'
import type { AgentId } from '../../domain/ids.js'
import {
  MCP_INVOCATION_RESPONSE_CACHE_TTL_MS,
  type McpInvocationRecord,
  type McpInvocationRepo,
  type WebchatMcpAccessGrantRepo,
  type WebchatMcpDelegationRepo
} from '../../persistence/ports.js'
import type { WebchatMcpGrantTokenCodec } from '../../registry/webchatMcpGrantToken.js'
import { resolveLiveWebchatMcpAuthority, type LiveWebchatMcpAuthorityDeps } from '../../registry/webchatMcpAuthority.js'

export interface InvocationContext {
  invocationId: string
  conversationId: string
  grantId: string
  agentId: string
  daemonId: string
  orgId: string
  userId: string
  startedAt: Date
}

export interface ParsedInvocationMetadata {
  method: 'tools/list' | 'tools/call'
  toolName?: string
}

export type RemoteGrantClaimResult =
  | { kind: 'execute'; context: InvocationContext }
  | { kind: 'completed'; invocationStatus: 'succeeded' | 'failed'; responseStatus: number; responseBytes: Uint8Array }
  | { kind: 'in_progress'; retryAfterMs: number }
  | { kind: 'ambiguous' }
  | { kind: 'denied'; reason: string }

export interface RemoteGrantAuthenticatorDeps extends LiveWebchatMcpAuthorityDeps {
  clock: Pick<Clock, 'now'>
  featureEnabled(): boolean
  sessions: { hasPrivateWebchatSession(conversationId: string, agentId: AgentId): Promise<boolean> }
  tokenCodec: Pick<WebchatMcpGrantTokenCodec, 'hash'>
  grants: Pick<WebchatMcpAccessGrantRepo, 'getByTokenHash'>
  authorities: Pick<WebchatMcpDelegationRepo, 'getCurrent'>
  invocations: Pick<McpInvocationRepo, 'claim'>
  isCuratedTool(toolName: string): boolean
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class RemoteGrantAuthenticator {
  constructor(private readonly deps: RemoteGrantAuthenticatorDeps) {}

  async claim(input: {
    bearer: string
    invocationId: string
    requestBytes: Uint8Array
    parseMetadata(): ParsedInvocationMetadata | Promise<ParsedInvocationMetadata>
  }): Promise<RemoteGrantClaimResult> {
    if (!this.deps.featureEnabled()) return { kind: 'denied', reason: 'feature_disabled' }
    const tokenHash = this.deps.tokenCodec.hash(input.bearer)
    if (!tokenHash || !UUID_V4_RE.test(input.invocationId)) return { kind: 'denied', reason: 'credential' }
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
    const claimed = await this.deps.invocations.claim({
      invocationId: input.invocationId,
      conversationId: authority.conversationId,
      grantId: grant.id,
      requestHash: createHash('sha256').update(input.requestBytes).digest('hex'),
      method: metadata.method,
      toolName: metadata.toolName,
      now
    })
    if (claimed.kind === 'conflict' || claimed.kind === 'denied') {
      return { kind: 'denied', reason: claimed.kind }
    }
    if (claimed.kind === 'existing') return this.replay(claimed.invocation, now)
    return {
      kind: 'execute',
      context: {
        invocationId: input.invocationId,
        conversationId: authority.conversationId,
        grantId: grant.id,
        agentId: authority.agentId,
        daemonId: authority.daemonId,
        orgId: authority.orgId,
        userId: authority.userId,
        startedAt: claimed.invocation.startedAt ?? now
      }
    }
  }

  private replay(invocation: McpInvocationRecord, now: Date): RemoteGrantClaimResult {
    if (invocation.status === 'running') return { kind: 'in_progress', retryAfterMs: 250 }
    if (invocation.status === 'ambiguous') return { kind: 'ambiguous' }
    if (
      (invocation.status === 'succeeded' || invocation.status === 'failed') &&
      invocation.responseStatus !== null &&
      invocation.responseBytes &&
      invocation.completedAt &&
      now.getTime() - invocation.completedAt.getTime() < MCP_INVOCATION_RESPONSE_CACHE_TTL_MS
    ) {
      return {
        kind: 'completed',
        invocationStatus: invocation.status,
        responseStatus: invocation.responseStatus,
        responseBytes: invocation.responseBytes
      }
    }
    return { kind: 'denied', reason: 'state' }
  }
}
