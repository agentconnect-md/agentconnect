import { isDeepStrictEqual } from 'node:util'
import type { McpServerDef } from '../config/config-schema.js'

/** Keeps CP MCP definitions tenant-scoped while layering them over daemon-local definitions. */
export class CpMcpDefs {
  private cp = new Map<string, Map<string, McpServerDef>>()

  constructor(private readonly local: Record<string, McpServerDef>) {}

  upsert(orgId: string, name: string, def: McpServerDef): boolean {
    const definitions = this.cp.get(orgId) ?? new Map<string, McpServerDef>()
    if (isDeepStrictEqual(definitions.get(name), def)) return false
    definitions.set(name, def)
    this.cp.set(orgId, definitions)
    return true
  }

  remove(orgId: string, name: string): boolean {
    const definitions = this.cp.get(orgId)
    if (!definitions?.delete(name)) return false
    if (definitions.size === 0) this.cp.delete(orgId)
    return true
  }

  converge(entries: Array<[string, string, McpServerDef]>): boolean {
    const next = new Map<string, Map<string, McpServerDef>>()
    for (const [orgId, name, def] of entries) {
      const definitions = next.get(orgId) ?? new Map<string, McpServerDef>()
      definitions.set(name, def)
      next.set(orgId, definitions)
    }
    if (
      next.size === this.cp.size &&
      [...next].every(([orgId, definitions]) => {
        const current = this.cp.get(orgId)
        return (
          current?.size === definitions.size &&
          [...definitions].every(([name, def]) => isDeepStrictEqual(current.get(name), def))
        )
      })
    ) {
      return false
    }
    this.cp = next
    return true
  }

  effective(orgId: string | undefined): Record<string, McpServerDef> {
    return { ...this.local, ...Object.fromEntries(orgId ? (this.cp.get(orgId) ?? []) : []) }
  }

  localDefinitions(): Record<string, McpServerDef> {
    return { ...this.local }
  }
}
