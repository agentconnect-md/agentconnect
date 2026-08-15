import { isDeepStrictEqual } from 'node:util'
import type { McpServerDef } from '../config/config-schema.js'

/** One CP definition plus the marker that orders it. `issuedAt` is the epoch
 *  millis of the grant it was projected from; absent means "unordered". */
interface Entry {
  def: McpServerDef
  issuedAt?: number
}

/** Keeps CP MCP definitions tenant-scoped while layering them over daemon-local definitions. */
export class CpMcpDefs {
  private cp = new Map<string, Map<string, Entry>>()

  constructor(private readonly local: Record<string, McpServerDef>) {}

  /**
   * Apply one CP definition, refusing a STRICTLY OLDER one.
   *
   * A proxy def is versioned by its grant, and grant rotation deliberately keeps
   * the retiring and the fresh grant both active until the fresh one is
   * distributed — so a definition projected inside that window (a `duty/fetch`
   * bundle, or a slower live push) can arrive after the fresh key and would
   * otherwise reinstate a key the relay is about to revoke, silently breaking
   * this agent's tools until the next unrelated update. Same monotonic discipline
   * as the external-memory registry's revision fence.
   *
   * Equal-or-newer applies: a relay-base change carries the same grant instant and
   * must still converge. An absent marker on either side is "unordered" and
   * applies, which is exactly the pre-marker behavior for an older CP.
   */
  upsert(orgId: string, name: string, def: McpServerDef, issuedAt?: number): boolean {
    const definitions = this.cp.get(orgId) ?? new Map<string, Entry>()
    const previous = definitions.get(name)
    if (previous?.issuedAt !== undefined && issuedAt !== undefined && issuedAt < previous.issuedAt) return false
    if (previous && isDeepStrictEqual(previous.def, def) && previous.issuedAt === issuedAt) return false
    definitions.set(name, { def, ...(issuedAt !== undefined ? { issuedAt } : {}) })
    this.cp.set(orgId, definitions)
    return true
  }

  remove(orgId: string, name: string): boolean {
    const definitions = this.cp.get(orgId)
    if (!definitions?.delete(name)) return false
    if (definitions.size === 0) this.cp.delete(orgId)
    return true
  }

  /** Full-replace from the reconnect snapshot. Deliberately NOT fenced — the CP
   *  wins on reconcile and this is the backstop that repairs any regression — but
   *  it RECORDS each marker, so a live push or a bundle that raced the snapshot
   *  is compared against what the snapshot installed rather than against nothing. */
  converge(entries: Array<[string, string, McpServerDef, number | undefined]>): boolean {
    const next = new Map<string, Map<string, Entry>>()
    for (const [orgId, name, def, issuedAt] of entries) {
      const definitions = next.get(orgId) ?? new Map<string, Entry>()
      definitions.set(name, { def, ...(issuedAt !== undefined ? { issuedAt } : {}) })
      next.set(orgId, definitions)
    }
    if (
      next.size === this.cp.size &&
      [...next].every(([orgId, definitions]) => {
        const current = this.cp.get(orgId)
        return (
          current?.size === definitions.size &&
          [...definitions].every(([name, entry]) => isDeepStrictEqual(current.get(name), entry))
        )
      })
    ) {
      return false
    }
    this.cp = next
    return true
  }

  effective(orgId: string | undefined): Record<string, McpServerDef> {
    const scoped = orgId ? (this.cp.get(orgId) ?? new Map<string, Entry>()) : new Map<string, Entry>()
    return { ...this.local, ...Object.fromEntries([...scoped].map(([name, entry]) => [name, entry.def])) }
  }

  localDefinitions(): Record<string, McpServerDef> {
    return { ...this.local }
  }
}
