import { createHash } from 'node:crypto'
import type { McpServer } from '@agentclientprotocol/sdk'
import { McpAppsHost, type McpAppsHostDeps } from './apps/host.js'
import { INTEGRATION_SETUP_URI, NativeMcpUi } from '@agentconnect.md/protocol/mcp-app'
import type {
  WebchatMcpGrantAccept,
  WebchatMcpGrantActivate,
  WebchatMcpGrantIssue,
  WebchatMcpGrantIssued,
  WebchatMcpGrantRevoke,
  WebchatMcpGrantRevoked,
  WebchatRemoteMcpEntitlement
} from '@agentconnect.md/protocol'

export const ADMIN_MCP_SERVER_NAME = 'agentconnect-admin'
const RENEW_BEFORE_EXPIRY_MS = 5 * 60_000

export interface RemoteWebchatGrantClient {
  issueWebchatMcpGrant(input: WebchatMcpGrantIssue, orgId?: string): Promise<WebchatMcpGrantIssued>
  acceptWebchatMcpGrant(input: WebchatMcpGrantAccept, orgId?: string): Promise<WebchatMcpGrantActivate>
  revokeWebchatMcpGrant(input: WebchatMcpGrantRevoke, orgId?: string): Promise<WebchatMcpGrantRevoked>
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
  apps?: McpAppsHost
  appsReady?: boolean
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
    private readonly ledger?: RemoteWebchatGrantLedger,
    private readonly orgForAgent?: (agentId: string) => string | undefined
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
    if (agentId && current?.agentId && current.agentId !== agentId)
      throw new Error('remote MCP conversation belongs to another agent')
    if (
      current &&
      current.expiresAt > now + RENEW_BEFORE_EXPIRY_MS &&
      sameEntitlement(current.entitlement, entitlement)
    ) {
      return { server: current.server, changed: false }
    }

    const descriptorInstanceId = current?.descriptorInstanceId ?? stableDescriptorId(conversationId)
    const orgId = agentId ? this.orgForAgent?.(agentId) : undefined
    const issue = {
      authorityId: entitlement.authorityId,
      authorityGeneration: entitlement.authorityGeneration,
      conversationId,
      descriptorInstanceId
    }
    const issued = orgId
      ? await this.client.issueWebchatMcpGrant(issue, orgId)
      : await this.client.issueWebchatMcpGrant(issue)
    this.assertIssued(issued, entitlement, conversationId, descriptorInstanceId, current)

    const accept = {
      authorityId: issued.authorityId,
      authorityGeneration: issued.authorityGeneration,
      conversationId: issued.conversationId,
      descriptorInstanceId: issued.descriptorInstanceId,
      grantRevision: issued.grantRevision,
      grantId: issued.grantId
    }
    const activated = orgId
      ? await this.client.acceptWebchatMcpGrant(accept, orgId)
      : await this.client.acceptWebchatMcpGrant(accept)
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
      name: ADMIN_MCP_SERVER_NAME,
      url: issued.mcpUrl,
      headers: [{ name: 'Authorization', value: `Bearer ${issued.token}` }]
    }
    await current?.apps?.close()
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

  // Each conversation owns its connection and template cache under its own activated grant.
  async prepareApps(conversationId: string, agentId: string): Promise<boolean> {
    const entry = this.active.get(conversationId)
    if (!entry || entry.agentId !== agentId || !('type' in entry.server) || entry.server.type !== 'http') return false
    const server = entry.server
    entry.apps ??= new McpAppsHost({
      nativeResource: (tool, uri, result) => {
        if (tool !== 'configureIntegration' || uri !== INTEGRATION_SETUP_URI) return undefined
        const content = (result as { content?: Array<{ type?: string; text?: string }> }).content
        try {
          const parsed = NativeMcpUi.safeParse(
            JSON.parse(content?.find((block) => block.type === 'text')?.text ?? 'null')
          )
          return parsed.success && parsed.data.orgId === this.orgForAgent?.(agentId) ? parsed.data : undefined
        } catch {
          return undefined
        }
      },
      defs: (): ReturnType<McpAppsHostDeps['defs']> =>
        this.active.get(conversationId) === entry && entry.expiresAt > Date.now()
          ? {
              [ADMIN_MCP_SERVER_NAME]: {
                transport: 'http',
                args: [],
                env: [],
                url: server.url,
                headers: server.headers,
                ui: true
              }
            }
          : {}
    })
    const tools = await entry.apps.toolsFor(undefined, [ADMIN_MCP_SERVER_NAME])
    entry.appsReady = this.active.get(conversationId) === entry && tools.length > 0
    return entry.appsReady
  }

  appsFor(conversationId: string, agentId: string): McpAppsHost | undefined {
    const entry = this.active.get(conversationId)
    return entry?.agentId === agentId && entry.expiresAt > Date.now() && entry.appsReady ? entry.apps : undefined
  }

  async revoke(
    conversationId: string,
    entitlement: WebchatRemoteMcpEntitlement,
    reason: WebchatMcpGrantRevoke['reason']
  ): Promise<void> {
    const agentId = this.active.get(conversationId)?.agentId
    try {
      const input = {
        authorityId: entitlement.authorityId,
        authorityGeneration: entitlement.authorityGeneration,
        conversationId,
        reason
      }
      const orgId = agentId ? this.orgForAgent?.(agentId) : undefined
      if (orgId) await this.client.revokeWebchatMcpGrant(input, orgId)
      else await this.client.revokeWebchatMcpGrant(input)
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
      if (failed && sameEntitlement(failed.entitlement, entitlement)) {
        this.active.delete(conversationId)
        await failed.apps?.close()
      }
      throw error
    }
    this.ledger?.clear({
      conversationId,
      authorityId: entitlement.authorityId,
      authorityGeneration: entitlement.authorityGeneration
    })
    const current = this.active.get(conversationId)
    if (current && sameEntitlement(current.entitlement, entitlement)) {
      this.active.delete(conversationId)
      await current.apps?.close()
    }
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
