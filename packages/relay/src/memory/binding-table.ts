import { createHash } from 'node:crypto'
import type { RcMemoryConnectionAssign } from '@agentconnect.md/protocol'

/** Relay-only upstream material. Secret header values must never be logged. */
export interface MemoryPluginUpstream {
  upstreamUrl: string
  headers: Array<{ name: string; value: string }>
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/**
 * Purpose-separated memory-plugin proxy bindings. Keeping this table distinct
 * from the model-facing MCP table makes it impossible for an MCP provider grant
 * or enable-list entry to authorize daemon-private memory traffic.
 */
export class MemoryConnectionBindingTable {
  private readonly byConnection = new Map<
    string,
    {
      revision: number
      upstream?: { upstreamUrl: string; headers: MemoryPluginUpstream['headers']; hashes: Set<string> }
    }
  >()

  assign(binding: RcMemoryConnectionAssign): void {
    const current = this.byConnection.get(binding.connectionId)
    // Every material binding change increments revision. First-writer wins for
    // an equal revision so duplicated delivery stays idempotent while a stale
    // or equivocating frame cannot replace credentials based on arrival order.
    if (current && binding.revision <= current.revision) return
    this.byConnection.set(binding.connectionId, {
      revision: binding.revision,
      upstream: {
        upstreamUrl: binding.upstreamUrl,
        headers: binding.headers,
        hashes: new Set(binding.grantKeyHashes)
      }
    })
  }

  unassign(connectionId: string, revision: number, grantKeyHash?: string): void {
    const current = this.byConnection.get(connectionId)
    if (current && revision < current.revision) return
    if (grantKeyHash === undefined) {
      // Keep a body-free tombstone so a delayed older assignment cannot
      // resurrect a deleted binding on this relay process.
      this.byConnection.set(connectionId, { revision })
      return
    }
    const upstream = current?.upstream
    if (!upstream || revision !== current.revision) return
    upstream.hashes.delete(grantKeyHash)
    if (upstream.hashes.size === 0) this.byConnection.set(connectionId, { revision })
  }

  resolve(connectionId: string, grantKey: string): MemoryPluginUpstream | null {
    const binding = this.byConnection.get(connectionId)
    const upstream = binding?.upstream
    if (!upstream || !upstream.hashes.has(sha256(grantKey))) return null
    return { upstreamUrl: upstream.upstreamUrl, headers: upstream.headers }
  }

  /** Start a fresh CP registration baseline. Kept explicit (rather than tied to
   * socket close) so a transient CP outage does not interrupt cached traffic. */
  clear(): void {
    this.byConnection.clear()
  }

  size(): number {
    return [...this.byConnection.values()].filter((binding) => binding.upstream !== undefined).length
  }
}
