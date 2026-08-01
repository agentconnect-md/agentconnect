import { createHash } from 'node:crypto'
import type { McpServer } from '@agentclientprotocol/sdk'
import type {
  WebchatMcpGrantAccept,
  WebchatMcpGrantActivate,
  WebchatMcpGrantIssue,
  WebchatMcpGrantIssued,
  WebchatMcpGrantRevoke,
  WebchatMcpGrantRevoked,
  WebchatRemoteMcpEntitlement
} from '@agentconnect.md/protocol'

const SERVER_NAME = 'agentconnect-admin'
const RENEW_BEFORE_EXPIRY_MS = 5 * 60_000

export interface RemoteWebchatGrantClient {
  issueWebchatMcpGrant(input: WebchatMcpGrantIssue): Promise<WebchatMcpGrantIssued>
  acceptWebchatMcpGrant(input: WebchatMcpGrantAccept): Promise<WebchatMcpGrantActivate>
  revokeWebchatMcpGrant(input: WebchatMcpGrantRevoke): Promise<WebchatMcpGrantRevoked>
}

/** Durable, non-secret sidecar for grant lifecycle. `recordActive` mirrors a
 *  provisioned authority tuple; `markRevoking` queues a revocation that MUST
 *  eventually reach the CP (it is written before a failed revoke surfaces, so
 *  lifecycle teardown can proceed without losing the obligation); `clear` drops
 *  the record once the CP confirmed revocation. */
export interface RemoteWebchatGrantLedger {
  recordActive(entry: {
    conversationId: string
    agentId?: string
    authorityId: string
    authorityGeneration: number
  }): void
  markRevoking(entry: {
    conversationId: string
    agentId?: string
    authorityId: string
    authorityGeneration: number
    reason: WebchatMcpGrantRevoke['reason']
  }): void
  clear(entry: { conversationId: string; authorityId: string; authorityGeneration: number }): void
}

interface ActiveDescriptor {
  agentId?: string
  entitlement: WebchatRemoteMcpEntitlement
  descriptorInstanceId: string
  grantId: string
  grantRevision: number
  expiresAt: number
  server: McpServer
}

function stableDescriptorId(conversationId: string): string {
  const bytes = createHash('sha256').update('agentconnect:webchat-mcp-descriptor:v1\0').update(conversationId).digest()
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function sameEntitlement(left: WebchatRemoteMcpEntitlement, right: WebchatRemoteMcpEntitlement): boolean {
  return (
    left.authorityId === right.authorityId &&
    left.authorityGeneration === right.authorityGeneration &&
    left.expiresAt === right.expiresAt
  )
}

/**
 * Owns the secret, session-scoped remote-MCP descriptor. Tokens exist only in
 * this process and are installed only after the CP activates the exact staged
 * revision.
 */
export class RemoteWebchatGrantManager {
  private readonly active = new Map<string, ActiveDescriptor>()

  constructor(
    private readonly client: RemoteWebchatGrantClient,
    private readonly ledger?: RemoteWebchatGrantLedger
  ) {}

  async descriptor(
    conversationId: string,
    entitlement: WebchatRemoteMcpEntitlement,
    now = Date.now()
  ): Promise<McpServer> {
    return (await this.provision(conversationId, entitlement, now)).server
  }

  async provision(
    conversationId: string,
    entitlement: WebchatRemoteMcpEntitlement,
    now = Date.now(),
    agentId?: string
  ): Promise<{ server: McpServer; changed: boolean }> {
    const current = this.active.get(conversationId)
    if (
      current &&
      current.expiresAt > now + RENEW_BEFORE_EXPIRY_MS &&
      sameEntitlement(current.entitlement, entitlement)
    ) {
      return { server: current.server, changed: false }
    }

    const descriptorInstanceId = current?.descriptorInstanceId ?? stableDescriptorId(conversationId)
    const issued = await this.client.issueWebchatMcpGrant({
      authorityId: entitlement.authorityId,
      authorityGeneration: entitlement.authorityGeneration,
      conversationId,
      descriptorInstanceId
    })
    this.assertIssued(issued, entitlement, conversationId, descriptorInstanceId, current)

    const activated = await this.client.acceptWebchatMcpGrant({
      authorityId: issued.authorityId,
      authorityGeneration: issued.authorityGeneration,
      conversationId: issued.conversationId,
      descriptorInstanceId: issued.descriptorInstanceId,
      grantRevision: issued.grantRevision,
      grantId: issued.grantId
    })
    if (
      !activated.activated ||
      activated.grantId !== issued.grantId ||
      activated.authorityId !== issued.authorityId ||
      activated.authorityGeneration !== issued.authorityGeneration ||
      activated.conversationId !== issued.conversationId ||
      activated.descriptorInstanceId !== issued.descriptorInstanceId ||
      activated.grantRevision !== issued.grantRevision
    ) {
      throw new Error('remote MCP grant activation binding mismatch')
    }

    const expiresAt = Date.parse(issued.expiresAt)
    const server: McpServer = {
      type: 'http',
      name: SERVER_NAME,
      url: issued.mcpUrl,
      headers: [{ name: 'Authorization', value: `Bearer ${issued.token}` }]
    }
    this.active.set(conversationId, {
      ...(agentId ? { agentId } : {}),
      entitlement: { ...entitlement },
      descriptorInstanceId,
      grantId: issued.grantId,
      grantRevision: issued.grantRevision,
      expiresAt,
      server
    })
    this.ledger?.recordActive({
      conversationId,
      ...(agentId ? { agentId } : {}),
      authorityId: issued.authorityId,
      authorityGeneration: issued.authorityGeneration
    })
    return { server, changed: true }
  }

  async revoke(
    conversationId: string,
    entitlement: WebchatRemoteMcpEntitlement,
    reason: WebchatMcpGrantRevoke['reason']
  ): Promise<void> {
    const agentId = this.active.get(conversationId)?.agentId
    try {
      await this.client.revokeWebchatMcpGrant({
        authorityId: entitlement.authorityId,
        authorityGeneration: entitlement.authorityGeneration,
        conversationId,
        reason
      })
    } catch (error) {
      // The obligation outlives this call: queue a durable retry BEFORE the
      // failure surfaces, so lifecycle teardown may proceed while the CP-side
      // authority is still guaranteed to be revoked eventually.
      this.ledger?.markRevoking({
        conversationId,
        ...(agentId ? { agentId } : {}),
        authorityId: entitlement.authorityId,
        authorityGeneration: entitlement.authorityGeneration,
        reason
      })
      // Also forget the local descriptor: the authority is queued for durable
      // revocation, so nothing may reuse or renew this conversation's plaintext.
      const failed = this.active.get(conversationId)
      if (failed && sameEntitlement(failed.entitlement, entitlement)) this.active.delete(conversationId)
      throw error
    }
    this.ledger?.clear({
      conversationId,
      authorityId: entitlement.authorityId,
      authorityGeneration: entitlement.authorityGeneration
    })
    const current = this.active.get(conversationId)
    if (current && sameEntitlement(current.entitlement, entitlement)) this.active.delete(conversationId)
  }

  async revokeConversation(conversationId: string, reason: WebchatMcpGrantRevoke['reason']): Promise<void> {
    const current = this.active.get(conversationId)
    if (!current) return
    await this.revoke(conversationId, current.entitlement, reason)
  }

  async revokeAgent(agentId: string, reason: WebchatMcpGrantRevoke['reason']): Promise<void> {
    const entries = [...this.active.entries()].filter(([, descriptor]) => descriptor.agentId === agentId)
    const results = await Promise.allSettled(
      entries.map(([conversationId, descriptor]) => this.revoke(conversationId, descriptor.entitlement, reason))
    )
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        `remote MCP revoke failed for agent ${agentId}`
      )
    }
  }

  async revokeAll(reason: WebchatMcpGrantRevoke['reason']): Promise<void> {
    const entries = [...this.active.entries()]
    const results = await Promise.allSettled(
      entries.map(([conversationId, descriptor]) => this.revoke(conversationId, descriptor.entitlement, reason))
    )
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'remote MCP revoke failed'
      )
  }

  private assertIssued(
    issued: WebchatMcpGrantIssued,
    entitlement: WebchatRemoteMcpEntitlement,
    conversationId: string,
    descriptorInstanceId: string,
    current: ActiveDescriptor | undefined
  ): void {
    const expiresAt = Date.parse(issued.expiresAt)
    if (
      issued.authorityId !== entitlement.authorityId ||
      issued.authorityGeneration !== entitlement.authorityGeneration ||
      issued.conversationId !== conversationId ||
      issued.descriptorInstanceId !== descriptorInstanceId ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      (current &&
        (issued.authorityGeneration < current.entitlement.authorityGeneration ||
          (issued.authorityGeneration === current.entitlement.authorityGeneration &&
            issued.grantRevision <= current.grantRevision)))
    ) {
      throw new Error('stale or mismatched remote MCP grant issuance')
    }
  }
}
