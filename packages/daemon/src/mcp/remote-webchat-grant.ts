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

export interface RemoteWebchatGrantClient {
  issueWebchatMcpGrant(input: WebchatMcpGrantIssue): Promise<WebchatMcpGrantIssued>
  acceptWebchatMcpGrant(input: WebchatMcpGrantAccept): Promise<WebchatMcpGrantActivate>
  revokeWebchatMcpGrant(input: WebchatMcpGrantRevoke): Promise<WebchatMcpGrantRevoked>
}

interface ActiveDescriptor {
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

  constructor(private readonly client: RemoteWebchatGrantClient) {}

  async descriptor(
    conversationId: string,
    entitlement: WebchatRemoteMcpEntitlement,
    now = Date.now()
  ): Promise<McpServer> {
    const current = this.active.get(conversationId)
    if (current && current.expiresAt > now && sameEntitlement(current.entitlement, entitlement)) {
      return current.server
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
      entitlement: { ...entitlement },
      descriptorInstanceId,
      grantId: issued.grantId,
      grantRevision: issued.grantRevision,
      expiresAt,
      server
    })
    return server
  }

  async revoke(
    conversationId: string,
    entitlement: WebchatRemoteMcpEntitlement,
    reason: WebchatMcpGrantRevoke['reason']
  ): Promise<void> {
    this.active.delete(conversationId)
    await this.client.revokeWebchatMcpGrant({
      authorityId: entitlement.authorityId,
      authorityGeneration: entitlement.authorityGeneration,
      conversationId,
      reason
    })
  }

  clear(): void {
    this.active.clear()
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
