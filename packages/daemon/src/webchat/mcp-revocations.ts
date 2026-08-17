/**
 * The remote-MCP grant revocation half of webchat: the lifecycle revoke calls and the
 * durable drain that replays whatever they could not deliver. The Daemon keeps thin
 * same-name delegates; everything here reaches back through {@link WebchatMcpRevocationHost}.
 */
import { WebchatMcpGrantRevoke } from '@agentconnect.md/protocol'
import type { CpAgentRegistry } from '../cp/cp-agent-registry.js'
import type { CpClient } from '../cp/client.js'
import type { RemoteWebchatGrantManager } from '../mcp/remote-webchat-grant.js'
import type { LocalStore } from '../store/local-store.js'
import { formatErr } from '../daemon/text.js'

/** Exactly what the revocation drain touches on the Daemon — nothing wider. */
export interface WebchatMcpRevocationHost {
  warn(message: string): void
  now(): number
  store(): LocalStore
  cpClient(): CpClient | undefined
  cpAgents(): CpAgentRegistry | undefined
  remoteWebchatGrants(): RemoteWebchatGrantManager | undefined
}

export class WebchatMcpRevocations {
  private draining = false

  constructor(private readonly host: WebchatMcpRevocationHost) {}

  async revokeAllRemoteWebchatGrants(reason: Parameters<RemoteWebchatGrantManager['revokeAll']>[0]): Promise<void> {
    try {
      await this.host.remoteWebchatGrants()?.revokeAll(reason)
    } catch (error) {
      // A failed revoke is already queued durably (grant-ledger `revoking` row),
      // so lifecycle convergence may proceed without losing the CP-side
      // revocation obligation — the drain loop replays it until it lands.
      this.host.warn(`remote MCP cleanup revoke deferred to durable retry (${formatErr(error)})`)
      void this.drainWebchatMcpRevocations()
    }
  }

  async revokeRemoteWebchatGrantsForAgent(
    agentId: string,
    reason: Parameters<RemoteWebchatGrantManager['revokeAgent']>[1]
  ): Promise<void> {
    try {
      await this.host.remoteWebchatGrants()?.revokeAgent(agentId, reason)
    } catch (error) {
      this.host.warn(`remote MCP cleanup revoke for agent ${agentId} deferred to durable retry (${formatErr(error)})`)
      void this.drainWebchatMcpRevocations()
    }
  }

  /** Deliver queued (`revoking`) grant-ledger rows to the CP. Runs on CP READY,
   *  after any failed lifecycle revoke, and from the idle sweep, so a revocation
   *  that missed its moment (disconnect, restart, transient error) still lands.
   *  Exact-tuple fencing on clear/retry keeps a concurrently re-provisioned
   *  conversation's fresh `active` row untouched. */
  async drainWebchatMcpRevocations(): Promise<void> {
    const cpClient = this.host.cpClient()
    if (this.draining || !cpClient) return
    this.draining = true
    try {
      const store = this.host.store()
      const due = store.listDueWebchatMcpRevocations(this.host.now())
      for (const row of due) {
        const reason = WebchatMcpGrantRevoke.shape.reason.safeParse(row.reason)
        try {
          await cpClient.revokeWebchatMcpGrant(
            {
              authorityId: row.authorityId,
              authorityGeneration: row.authorityGeneration,
              conversationId: row.conversationId,
              reason: reason.success ? reason.data : 'session_closed'
            },
            this.host.cpAgents()?.orgForAgent(row.agentId)
          )
          store.clearWebchatMcpGrant(row.conversationId, row.authorityId, row.authorityGeneration)
        } catch (error) {
          const backoff = Math.min(10 * 60_000, 5_000 * 2 ** Math.min(row.attempts, 8))
          store.retryWebchatMcpRevocation(
            row.conversationId,
            row.authorityId,
            row.authorityGeneration,
            this.host.now() + backoff,
            this.host.now()
          )
          this.host.warn(`remote MCP revoke retry deferred for ${row.conversationId} (${formatErr(error)})`)
        }
      }
    } finally {
      this.draining = false
    }
  }
}
