import { createHash } from 'node:crypto'
import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import type {
  WebchatMcpGrantAccept,
  WebchatMcpGrantActivate,
  WebchatMcpGrantIssue,
  WebchatMcpGrantIssued,
  WebchatMcpGrantRenew,
  WebchatMcpGrantRenewed,
  WebchatMcpGrantRevoke,
  WebchatMcpGrantRevoked,
  WebchatRemoteMcpEntitlement
} from '@agentconnect.md/protocol'

export const ADMIN_MCP_SERVER_NAME = 'agentconnect-admin'
const RENEW_BEFORE_EXPIRY_MS = 5 * 60_000

export interface RemoteWebchatGrantClient {
  issueWebchatMcpGrant(input: WebchatMcpGrantIssue, orgId?: string): Promise<WebchatMcpGrantIssued>
  acceptWebchatMcpGrant(input: WebchatMcpGrantAccept, orgId?: string): Promise<WebchatMcpGrantActivate>
  renewWebchatMcpGrant?(input: WebchatMcpGrantRenew, orgId?: string): Promise<WebchatMcpGrantRenewed | 'unsupported'>
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
  conversationId: string
  /** The session a task's own descriptor serves; absent for the conversation's own session. */
  sessionKey?: string
  agentId?: string
  entitlement: WebchatRemoteMcpEntitlement
  descriptorInstanceId: string
  grantId: string
  grantRevision: number
  expiresAt: number
  server: McpServer
}

function stableDescriptorId(conversationId: string, sessionKey?: string): string {
  const hash = createHash('sha256').update('agentconnect:webchat-mcp-descriptor:v1\0').update(conversationId)
  if (sessionKey !== undefined) hash.update('\0').update(sessionKey)
  const bytes = hash.digest()
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** One descriptor per runtime session: the conversation's own session, or a task it opened (webchat-preset-agentconnect-mcp.md §5.2). */
function descriptorKey(conversationId: string, sessionKey?: string): string {
  return sessionKey === undefined ? conversationId : `${conversationId}\0${sessionKey}`
}

function sameEntitlement(left: WebchatRemoteMcpEntitlement, right: WebchatRemoteMcpEntitlement): boolean {
  return (
    left.authorityId === right.authorityId &&
    left.authorityGeneration === right.authorityGeneration &&
    left.expiresAt === right.expiresAt
  )
}

/** Owns each runtime session's secret remote-MCP descriptor, held only in memory and installed only once the CP activates its revision. */
export class RemoteWebchatGrantManager {
  private readonly active = new Map<string, ActiveDescriptor>()
  /** The newest entitlement each conversation's turns carried, which a task the conversation opened inherits. */
  private readonly latest = new Map<string, { agentId: string; entitlement: WebchatRemoteMcpEntitlement }>()
  private readonly renewals = new WeakMap<ActiveDescriptor, Promise<boolean>>()

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

  /** Remember the entitlement a conversation's turn carried, for the tasks it opens; the coordinator itself installs none. */
  noteEntitlement(conversationId: string, agentId: string, entitlement: WebchatRemoteMcpEntitlement): void {
    const known = this.latest.get(conversationId)
    if (known && known.agentId !== agentId) return
    if (known && known.entitlement.authorityGeneration > entitlement.authorityGeneration) return
    this.latest.set(conversationId, { agentId, entitlement: { ...entitlement } })
  }

  /** The conversation's newest unexpired entitlement for `agentId`, which a task it opened provisions its own grant under. */
  inheritedEntitlement(
    conversationId: string,
    agentId: string,
    now = Date.now()
  ): WebchatRemoteMcpEntitlement | undefined {
    const known = this.latest.get(conversationId)
    if (!known || known.agentId !== agentId || Date.parse(known.entitlement.expiresAt) <= now) return undefined
    return known.entitlement
  }

  async provision(
    conversationId: string,
    entitlement: WebchatRemoteMcpEntitlement,
    now = Date.now(),
    agentId?: string,
    sessionKey?: string
  ): Promise<{ server: McpServer; changed: boolean }> {
    const key = descriptorKey(conversationId, sessionKey)
    const current = this.active.get(key)
    if (agentId && current?.agentId && current.agentId !== agentId)
      throw new Error('remote MCP conversation belongs to another agent')
    if (agentId) this.noteEntitlement(conversationId, agentId, entitlement)
    if (current && sameEntitlement(current.entitlement, entitlement)) {
      if (current.expiresAt > now + RENEW_BEFORE_EXPIRY_MS) return { server: current.server, changed: false }
      // Renewing in place keeps the installed bearer valid: a runtime may ignore a reloaded descriptor.
      if (current.expiresAt > now && (await this.renewInPlace(current, agentId))) {
        return { server: current.server, changed: false }
      }
    }

    const descriptorInstanceId = current?.descriptorInstanceId ?? stableDescriptorId(conversationId, sessionKey)
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
    this.active.set(key, {
      conversationId,
      ...(sessionKey !== undefined ? { sessionKey } : {}),
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

  /** Renews each grant inside its renewal window whose session `isOpen`; returns the conversations it could not renew. */
  async renewExpiring(
    now: number,
    isOpen: (conversationId: string, agentId: string, sessionKey?: string) => Promise<boolean>
  ): Promise<string[]> {
    const failed: string[] = []
    for (const [key, current] of [...this.active]) {
      // A task's expired grant is never revoked on its own (revocation is the conversation's), so it is dropped here.
      if (current.sessionKey !== undefined && current.expiresAt <= now) this.active.delete(key)
      if (!current.agentId || current.expiresAt <= now || current.expiresAt > now + RENEW_BEFORE_EXPIRY_MS) continue
      const open =
        current.sessionKey === undefined
          ? await isOpen(current.conversationId, current.agentId)
          : await isOpen(current.conversationId, current.agentId, current.sessionKey)
      if (!open) continue
      if (!(await this.renewInPlace(current, current.agentId))) failed.push(current.conversationId)
    }
    return failed
  }

  /** True when the CP extended the active grant; anything else falls back to rotation. */
  private renewInPlace(current: ActiveDescriptor, agentId?: string): Promise<boolean> {
    // One renewal per descriptor at a time: the sweep and a turn start must not race into a rotation.
    const inFlight = this.renewals.get(current)
    if (inFlight) return inFlight
    const renewal = this.requestRenewal(current, agentId).finally(() => this.renewals.delete(current))
    this.renewals.set(current, renewal)
    return renewal
  }

  private async requestRenewal(current: ActiveDescriptor, agentId?: string): Promise<boolean> {
    if (!this.client.renewWebchatMcpGrant) return false
    const conversationId = current.conversationId
    const renew = {
      authorityId: current.entitlement.authorityId,
      authorityGeneration: current.entitlement.authorityGeneration,
      conversationId,
      descriptorInstanceId: current.descriptorInstanceId,
      grantRevision: current.grantRevision,
      grantId: current.grantId
    }
    const orgId = agentId ? this.orgForAgent?.(agentId) : undefined
    let renewed: WebchatMcpGrantRenewed | 'unsupported'
    try {
      renewed = orgId
        ? await this.client.renewWebchatMcpGrant(renew, orgId)
        : await this.client.renewWebchatMcpGrant(renew)
    } catch {
      return false
    }
    if (renewed === 'unsupported') return false
    const expiresAt = Date.parse(renewed.expiresAt)
    if (
      renewed.grantId !== renew.grantId ||
      renewed.authorityId !== renew.authorityId ||
      renewed.authorityGeneration !== renew.authorityGeneration ||
      renewed.conversationId !== renew.conversationId ||
      renewed.descriptorInstanceId !== renew.descriptorInstanceId ||
      renewed.grantRevision !== renew.grantRevision ||
      !Number.isFinite(expiresAt) ||
      expiresAt < current.expiresAt ||
      this.active.get(descriptorKey(conversationId, current.sessionKey)) !== current
    ) {
      return false
    }
    current.expiresAt = expiresAt
    return true
  }

  async revoke(
    conversationId: string,
    entitlement: WebchatRemoteMcpEntitlement,
    reason: WebchatMcpGrantRevoke['reason']
  ): Promise<void> {
    const agentId = this.descriptorsOf(conversationId)[0]?.agentId ?? this.latest.get(conversationId)?.agentId
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
      // Queue a durable retry before the failure surfaces, so teardown proceeds while revocation still happens.
      this.ledger?.markRevoking({
        conversationId,
        ...(agentId ? { agentId } : {}),
        authorityId: entitlement.authorityId,
        authorityGeneration: entitlement.authorityGeneration,
        reason
      })
      // The authority is queued for revocation, so nothing may reuse or renew its plaintext.
      this.forgetAuthority(conversationId, entitlement)
      throw error
    }
    this.ledger?.clear({
      conversationId,
      authorityId: entitlement.authorityId,
      authorityGeneration: entitlement.authorityGeneration
    })
    this.forgetAuthority(conversationId, entitlement)
  }

  async revokeConversation(conversationId: string, reason: WebchatMcpGrantRevoke['reason']): Promise<void> {
    const failures = await this.revokeEach(
      this.authoritiesOf((_agentId, conversation) => conversation === conversationId),
      reason
    )
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, `remote MCP revoke failed for ${conversationId}`)
  }

  /** Conversations holding an active grant, or an entitlement their tasks inherit, for `agentId`. */
  conversationsForAgent(agentId: string): string[] {
    const ids = new Set<string>()
    for (const descriptor of this.active.values())
      if (descriptor.agentId === agentId) ids.add(descriptor.conversationId)
    for (const [conversationId, known] of this.latest) if (known.agentId === agentId) ids.add(conversationId)
    return [...ids]
  }

  /** The task sessions holding a descriptor under `conversationId`'s authority. */
  taskSessionKeys(conversationId: string): string[] {
    const keys: string[] = []
    for (const descriptor of this.active.values())
      if (descriptor.conversationId === conversationId && descriptor.sessionKey !== undefined)
        keys.push(descriptor.sessionKey)
    return keys
  }

  /** Drop the descriptors of `agentId`'s task sessions `pick` selects, so the next turn there installs a freshly issued grant. */
  forgetSessions(agentId: string, pick: (sessionKey: string) => boolean): void {
    for (const [key, descriptor] of [...this.active])
      if (descriptor.agentId === agentId && descriptor.sessionKey !== undefined && pick(descriptor.sessionKey))
        this.active.delete(key)
  }

  async revokeAgent(agentId: string, reason: WebchatMcpGrantRevoke['reason']): Promise<void> {
    const failures = await this.revokeEach(
      this.authoritiesOf((agentOf) => agentOf === agentId),
      reason
    )
    if (failures.length) throw new AggregateError(failures, `remote MCP revoke failed for agent ${agentId}`)
  }

  async revokeAll(reason: WebchatMcpGrantRevoke['reason']): Promise<void> {
    const failures = await this.revokeEach(
      this.authoritiesOf(() => true),
      reason
    )
    if (failures.length) throw new AggregateError(failures, 'remote MCP revoke failed')
  }

  /** Revoke every listed authority, each attempted; returns the failures. */
  private async revokeEach(
    entries: [string, WebchatRemoteMcpEntitlement][],
    reason: WebchatMcpGrantRevoke['reason']
  ): Promise<unknown[]> {
    const results = await Promise.allSettled(
      entries.map(([conversationId, entitlement]) => this.revoke(conversationId, entitlement, reason))
    )
    return results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []))
  }

  private descriptorsOf(conversationId: string): ActiveDescriptor[] {
    return [...this.active.values()].filter((descriptor) => descriptor.conversationId === conversationId)
  }

  /** Every distinct authority a picked conversation's descriptors or remembered entitlement name: tasks may straddle a rotation. */
  private authoritiesOf(
    pick: (agentId: string | undefined, conversationId: string) => boolean
  ): [string, WebchatRemoteMcpEntitlement][] {
    const found = new Map<string, [string, WebchatRemoteMcpEntitlement]>()
    const add = (conversationId: string, entitlement: WebchatRemoteMcpEntitlement) => {
      const key = `${conversationId}\0${entitlement.authorityId}\0${entitlement.authorityGeneration}`
      if (!found.has(key)) found.set(key, [conversationId, entitlement])
    }
    for (const descriptor of this.active.values())
      if (pick(descriptor.agentId, descriptor.conversationId)) add(descriptor.conversationId, descriptor.entitlement)
    for (const [conversationId, known] of this.latest)
      if (pick(known.agentId, conversationId)) add(conversationId, known.entitlement)
    return [...found.values()]
  }

  /** Drop every local descriptor and the remembered entitlement of a revoked authority. */
  private forgetAuthority(conversationId: string, entitlement: WebchatRemoteMcpEntitlement): void {
    const same = (other: WebchatRemoteMcpEntitlement) =>
      other.authorityId === entitlement.authorityId && other.authorityGeneration === entitlement.authorityGeneration
    for (const [key, descriptor] of [...this.active])
      if (descriptor.conversationId === conversationId && same(descriptor.entitlement)) this.active.delete(key)
    const known = this.latest.get(conversationId)
    if (known && same(known.entitlement)) this.latest.delete(conversationId)
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
