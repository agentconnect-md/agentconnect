import { createHash } from 'node:crypto'
import type { RcMcpAssign } from '@agentconnect.md/protocol'
import { ProjectionSnapshot } from '../projection-snapshot.js'
import type { ToolDecisions } from './tool-policy.js'

/** The upstream a resolved grant maps to. `headers` carry the UPSTREAM credential — NEVER log. */
export interface McpUpstream {
  upstreamUrl: string
  headers: Array<{ name: string; value: string }>
}

/** A resolved grant: its upstream, and the decision table when the grant is a restricted agent's. */
export interface McpResolved extends McpUpstream {
  policy?: ToolDecisions
}

interface Binding {
  upstreamUrl: string
  headers: McpUpstream['headers']
  hashes: Set<string>
  restricted: Map<string, ToolDecisions>
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** The table a restricted grant is judged by; approval-gated names stay Blocked until this relay handles approvals. */
function decisionsOf(policy: NonNullable<RcMcpAssign['toolPolicies']>[number]): ToolDecisions {
  return { allow: new Set(policy.allow) }
}

/** The pool-wide MCP proxy bindings `rc/mcp-assign` delivers, matched by grant-key hash; headers are the upstream credential — NEVER logged. */
export class McpBindingTable {
  private byProvider = new Map<string, Binding>()
  private readonly snapshot = new ProjectionSnapshot()

  /** Load/replace one provider's binding (`rc/mcp-assign`). */
  assign(a: RcMcpAssign): void {
    this.snapshot.see(a.providerId)
    const tables = (a.toolPolicies ?? []).map(decisionsOf)
    const restricted = new Map<string, ToolDecisions>()
    for (const grant of a.restrictedGrants ?? []) {
      const table = tables[grant.policy]
      if (table) restricted.set(grant.grantKeyHash, table)
    }
    this.byProvider.set(a.providerId, {
      upstreamUrl: a.upstreamUrl,
      headers: a.headers,
      hashes: new Set(a.grantKeyHashes),
      restricted
    })
  }

  /** Drop a whole provider, or retire one grant hash; a provider left with no grant of either kind is dropped. */
  unassign(providerId: string, grantKeyHash?: string): void {
    if (grantKeyHash === undefined) {
      this.byProvider.delete(providerId)
      return
    }
    const b = this.byProvider.get(providerId)
    if (!b) return
    b.hashes.delete(grantKeyHash)
    b.restricted.delete(grantKeyHash)
    if (b.hashes.size === 0 && b.restricted.size === 0) this.byProvider.delete(providerId)
  }

  /** A providerId + raw bearer grant key → its upstream (and table, when restricted), or null. */
  resolve(providerId: string, grantKey: string): McpResolved | null {
    const b = this.byProvider.get(providerId)
    if (!b) return null
    const keyHash = sha256(grantKey)
    const policy = b.restricted.get(keyHash)
    if (policy) return { upstreamUrl: b.upstreamUrl, headers: b.headers, policy }
    if (!b.hashes.has(keyHash)) return null
    return { upstreamUrl: b.upstreamUrl, headers: b.headers }
  }

  /** A provider's upstream without a grant, for the relay's own catalog fetch (`rc/mcp-catalog`). */
  upstream(providerId: string): McpUpstream | null {
    const b = this.byProvider.get(providerId)
    return b ? { upstreamUrl: b.upstreamUrl, headers: b.headers } : null
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
