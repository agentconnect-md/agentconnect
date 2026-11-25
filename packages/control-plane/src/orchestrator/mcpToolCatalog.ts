// Provider tool catalogs, fetched by a capable relay with its own binding and stored as snapshots (mcp-tool-permissions.md §4).
import { MCP_TOOL_POLICY_V1_FEATURE, type McpCatalogFailure, type RcMcpCatalogOk } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import type { OrgId } from '../domain/ids.js'
import { advertises } from '../domain/daemon-features.js'
import type { McpToolCatalogRecord, McpToolCatalogRepo } from '../persistence/ports.js'
import { RequestTimeout } from '../ws/correlator.js'
import type { RelayChannel } from '../ws/relay-registry.js'

/** Why the last fetch failed: the relay's closed codes plus the CP's own two. */
export type McpCatalogFailureCode = McpCatalogFailure | 'relay_unavailable' | 'relay_timeout'

export interface McpToolCatalogDeps {
  relays: { all(): RelayChannel[] }
  catalogs: McpToolCatalogRepo
  clock: Pick<Clock, 'now'>
  log?: { warn: (obj: Record<string, unknown>, message: string) => void }
}

export class McpToolCatalogService {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly scheduled = new Set<Promise<void>>()

  constructor(private readonly deps: McpToolCatalogDeps) {}

  get(orgId: OrgId, providerId: string): Promise<McpToolCatalogRecord | null> {
    return this.deps.catalogs.get(orgId, providerId)
  }

  /** Fetch now and return the stored row; a failure keeps the previous tools and records its code. */
  refresh(orgId: OrgId, providerId: string): Promise<McpToolCatalogRecord | null> {
    return this.serialize(providerId, async () => {
      await this.fetchOnce(orgId, providerId)
      return this.deps.catalogs.get(orgId, providerId)
    })
  }

  /** Refresh without blocking the caller, after a provider's binding changed. */
  schedule(orgId: OrgId, providerId: string): void {
    const run = this.refresh(orgId, providerId).then(
      () => undefined,
      (err: unknown) => this.deps.log?.warn({ err, providerId }, 'mcp tool catalog: scheduled refresh failed')
    )
    this.scheduled.add(run)
    void run.finally(() => this.scheduled.delete(run))
  }

  /** Resolve once every scheduled refresh has finished (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.scheduled.size > 0) await Promise.allSettled([...this.scheduled])
  }

  private async fetchOnce(orgId: OrgId, providerId: string): Promise<void> {
    const relay = this.deps.relays
      .all()
      .find((ch) => ch.request && advertises(ch.features, [MCP_TOOL_POLICY_V1_FEATURE]))
    if (!relay?.request) return this.fail(orgId, providerId, 'relay_unavailable')
    let reply: RcMcpCatalogOk
    try {
      reply = await relay.request('rc/mcp-catalog', { providerId })
    } catch (err) {
      // The relay's error text is never logged or stored: only the closed code leaves this function.
      return this.fail(
        orgId,
        providerId,
        err instanceof RequestTimeout ? 'relay_timeout' : 'relay_unavailable',
        relay.relayId
      )
    }
    if (!reply.tools) return this.fail(orgId, providerId, reply.failure ?? 'invalid_response', relay.relayId)
    await this.deps.catalogs.put(orgId, providerId, {
      tools: reply.tools,
      fetchedAt: new Date(this.deps.clock.now()),
      failure: null
    })
  }

  private async fail(orgId: OrgId, providerId: string, failure: McpCatalogFailureCode, relayId?: string) {
    this.deps.log?.warn({ providerId, failure, ...(relayId ? { relayId } : {}) }, 'mcp tool catalog: fetch failed')
    await this.deps.catalogs.recordFailure(orgId, providerId, failure)
  }

  /** One refresh per provider at a time, so an older fetch never overwrites a newer one. */
  private serialize<T>(providerId: string, run: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(providerId) ?? Promise.resolve()
    const result = prev.then(run, run)
    const settled = result.then(
      () => undefined,
      () => undefined
    )
    this.chains.set(providerId, settled)
    void settled.finally(() => {
      if (this.chains.get(providerId) === settled) this.chains.delete(providerId)
    })
    return result
  }
}
