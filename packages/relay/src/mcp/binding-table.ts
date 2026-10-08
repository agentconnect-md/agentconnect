import { createHash } from 'node:crypto'
import type { RcMcpAssign } from '@agentconnect.md/protocol'
import { ProjectionSnapshot } from '../projection-snapshot.js'

/** The upstream a resolved grant maps to. `headers` carry the UPSTREAM credential — NEVER log. */
export interface McpUpstream {
  upstreamUrl: string
  headers: Array<{ name: string; value: string }>
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * In-memory MCP proxy bindings (centralized-tool-management.md §5.2). The CP pushes
 * `providerId → { upstreamUrl, headers, grantKeyHashes }` over `rc/mcp-assign` (whole-pool
 * broadcast, like `rc/bot-assign`), so every relay holds the same set. The proxy route
 * resolves a `providerId` + the agent-presented bearer grant key to its upstream, and the
 * route injects the real `headers` on forward. Grant keys are matched by sha256 (only hashes
 * ride the wire / live here). Upstream headers are the upstream credential — NEVER logged.
 */
export class McpBindingTable {
  private byProvider = new Map<string, { upstreamUrl: string; headers: McpUpstream['headers']; hashes: Set<string> }>()
  private readonly snapshot = new ProjectionSnapshot()

  /** Load/replace one provider's binding (`rc/mcp-assign`). */
  assign(a: RcMcpAssign): void {
    this.snapshot.see(a.providerId)
    this.byProvider.set(a.providerId, {
      upstreamUrl: a.upstreamUrl,
      headers: a.headers,
      hashes: new Set(a.grantKeyHashes)
    })
  }

  /** Drop a whole provider, or retire a single grant hash (`rc/mcp-unassign`). A provider
   *  left with no valid grant is dropped (a keyless binding is never callable). */
  unassign(providerId: string, grantKeyHash?: string): void {
    if (grantKeyHash === undefined) {
      this.byProvider.delete(providerId)
      return
    }
    const b = this.byProvider.get(providerId)
    if (!b) return
    b.hashes.delete(grantKeyHash)
    if (b.hashes.size === 0) this.byProvider.delete(providerId)
  }

  /** Resolve a providerId + the raw bearer grant key to its upstream, or null if the
   *  provider is unknown or the key is not in its allowlist. */
  resolve(providerId: string, grantKey: string): McpUpstream | null {
    const b = this.byProvider.get(providerId)
    if (!b || !b.hashes.has(sha256(grantKey))) return null
    return { upstreamUrl: b.upstreamUrl, headers: b.headers }
  }

  /** `rc/snapshot-begin`: the current bindings keep serving while the replay lands. */
  beginSnapshot(snapshotId: string): void {
    this.snapshot.begin(snapshotId)
  }

  /** `rc/snapshot-end`: drop each provider the replay neither sent nor withheld, such as one revoked while the link was down. */
  endSnapshot(snapshotId: string, withheld: readonly string[]): void {
    for (const providerId of this.snapshot.end(snapshotId, this.byProvider.keys(), withheld)) {
      this.byProvider.delete(providerId)
    }
  }

  abandonSnapshot(): void {
    this.snapshot.abandon()
  }

  /** Test/introspection: number of bound providers. */
  size(): number {
    return this.byProvider.size
  }
}
