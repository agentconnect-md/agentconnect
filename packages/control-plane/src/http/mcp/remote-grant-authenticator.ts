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
  /** The daemon serving the agent for this invocation, resolved live — never a stored member id. */
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
  /** The raw JSON-RPC method — classification is this module's job, not the caller's. */
  method: string
  requestId?: string
  toolName?: string
}

/** Transport-level methods a grant may issue without an invocation identity. The MCP
 *  handshake is MANDATORY (a client sends `initialize` before anything else and may
 *  keep the connection warm with `ping`), so denying these denies the whole server:
 *  the adapter never completes `initialize` and the session shows no admin tools at
 *  all. They are answered inside the MCP handler, reach no tool, no nested REST call,
 *  and no org-scoped data — but they still require a live, unrevoked grant, so an
 *  expired credential learns nothing beyond the same 401. */
const HANDSHAKE_METHODS = new Set(['initialize', 'notifications/initialized', 'ping'])

export type RemoteGrantClaimResult =
  { kind: 'execute'; context: InvocationContext } | { kind: 'handshake' } | { kind: 'denied'; reason: string }

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
    // No daemon identity on this seam — the grant arrives over HTTP from the agent's adapter — so
    // the live check asks the resolver for whichever daemon serves the agent now.
    const live = await resolveLiveWebchatMcpAuthority(this.deps, {
      conversationId: authority.conversationId,
      expectedUserId: authority.userId,
      orgId: authority.orgId,
      agentId: authority.agentId
    })
    if (!live.ok) return { kind: 'denied', reason: live.reason }

    let metadata: ParsedInvocationMetadata
    try {
      metadata = await input.parseMetadata()
    } catch {
      return { kind: 'denied', reason: 'metadata' }
    }
    if (HANDSHAKE_METHODS.has(metadata.method)) return { kind: 'handshake' }
    const method = metadata.method
    if (
      (method !== 'tools/list' && method !== 'tools/call') ||
      (method === 'tools/list' && metadata.toolName !== undefined) ||
      (method === 'tools/call' && (!metadata.toolName || !this.deps.isCuratedTool(metadata.toolName)))
    ) {
      return { kind: 'denied', reason: 'tool' }
    }
    // The private-current-session predicate gates only `tools/call`. The descriptor
    // is installed during `session/new`, and the daemon can register the session row
    // (`webchat_conversation.currentSessionId` → `session_meta`) only after that call
    // returns — so the adapter's `initialize` and immediate `tools/list` always race
    // the registration and would lose deterministically, killing the server for the
    // session's whole lifetime (adapters do not retry a failed connect). Both are
    // safe without the predicate: the handshake reaches no tool, and `tools/list`
    // returns the static curated catalog with no org-scoped data. `tools/call` is
    // the authority-wielding step; it is issued mid-turn, after registration, and
    // must stop the moment the conversation's current session is not private.
    if (
      method === 'tools/call' &&
      !(await this.deps.sessions.hasPrivateWebchatSession(authority.conversationId, authority.agentId as AgentId))
    ) {
      return { kind: 'denied', reason: 'session_not_private' }
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
        daemonId: live.daemonId,
        orgId: authority.orgId,
        userId: authority.userId,
        startedAt: now,
        ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
        requestHash: createHash('sha256').update(input.requestBytes).digest('hex'),
        method,
        ...(metadata.toolName ? { toolName: metadata.toolName } : {})
      }
    }
  }
}
