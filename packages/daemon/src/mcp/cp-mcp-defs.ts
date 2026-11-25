import { isDeepStrictEqual } from 'node:util'
import type { McpToolDecisions } from '@agentconnect.md/protocol'
import type { McpServerDef } from '../config/config-schema.js'

/** One CP definition plus the marker that orders it: the epoch millis of its grant, absent meaning "unordered". */
interface Entry {
  def: McpServerDef
  issuedAt?: number
  /** An agent-scoped definition's decision table (mcp-tool-permissions.md §7.1). */
  toolDecisions?: McpToolDecisions
}

/** One CP definition as the reconnect snapshot carries it. */
export type CpMcpDefTuple = [
  orgId: string,
  name: string,
  def: McpServerDef,
  issuedAt: number | undefined,
  agentId?: string,
  toolDecisions?: McpToolDecisions
]

const VIEW_SEPARATOR = '\u0001'

/** The view an agent resolves MCP definitions in: its organization, narrowed to the agent; ids never contain the separator. */
export function mcpView(orgId: string | undefined, agentId?: string): string | undefined {
  if (!orgId) return undefined
  return agentId ? `${orgId}${VIEW_SEPARATOR}${agentId}` : orgId
}

/** The organization and agent a view names. */
export function parseMcpView(view: string | undefined): { orgId?: string; agentId?: string } {
  if (!view) return {}
  const at = view.indexOf(VIEW_SEPARATOR)
  return at < 0 ? { orgId: view } : { orgId: view.slice(0, at), agentId: view.slice(at + 1) }
}

/** Keeps CP MCP definitions tenant-scoped, with an agent's own definitions layered over its organization's. */
export class CpMcpDefs {
  /** Keyed by layer: an organization's view, or one agent's within it. */
  private cp = new Map<string, Map<string, Entry>>()

  constructor(private readonly local: Record<string, McpServerDef>) {}

  /** Apply one CP definition, refusing a strictly older one, so a rotation's retiring key is never reinstated. */
  upsert(
    orgId: string,
    name: string,
    def: McpServerDef,
    issuedAt?: number,
    agentId?: string,
    toolDecisions?: McpToolDecisions
  ): boolean {
    const layer = mcpView(orgId, agentId)!
    const definitions = this.cp.get(layer) ?? new Map<string, Entry>()
    const previous = definitions.get(name)
    if (previous?.issuedAt !== undefined && issuedAt !== undefined && issuedAt < previous.issuedAt) return false
    const next = entry(def, issuedAt, toolDecisions)
    if (previous && isDeepStrictEqual(previous, next)) return false
    definitions.set(name, next)
    this.cp.set(layer, definitions)
    return true
  }

  /** Drop one definition; with `agentId`, only that agent's own, so the agent falls back to its organization's. */
  remove(orgId: string, name: string, agentId?: string): boolean {
    const layer = mcpView(orgId, agentId)!
    const definitions = this.cp.get(layer)
    if (!definitions?.delete(name)) return false
    if (definitions.size === 0) this.cp.delete(layer)
    return true
  }

  /** Full-replace from the reconnect snapshot. Deliberately NOT fenced — the CP wins on reconcile — but it records each marker, so a later push is compared against it. */
  converge(entries: CpMcpDefTuple[]): boolean {
    const next = new Map<string, Map<string, Entry>>()
    for (const [orgId, name, def, issuedAt, agentId, toolDecisions] of entries) {
      const layer = mcpView(orgId, agentId)!
      const definitions = next.get(layer) ?? new Map<string, Entry>()
      definitions.set(name, entry(def, issuedAt, toolDecisions))
      next.set(layer, definitions)
    }
    if (
      next.size === this.cp.size &&
      [...next].every(([layer, definitions]) => {
        const current = this.cp.get(layer)
        return (
          current?.size === definitions.size &&
          [...definitions].every(([name, value]) => isDeepStrictEqual(current.get(name), value))
        )
      })
    ) {
      return false
    }
    this.cp = next
    return true
  }

  /** Local definitions, then the organization's, then the agent's own: each later layer wins a name. */
  effective(orgId: string | undefined, agentId?: string): Record<string, McpServerDef> {
    const org = this.layer(mcpView(orgId))
    const own = agentId ? this.layer(mcpView(orgId, agentId)) : new Map<string, Entry>()
    return {
      ...this.local,
      ...Object.fromEntries([...org].map(([name, value]) => [name, value.def])),
      ...Object.fromEntries([...own].map(([name, value]) => [name, value.def]))
    }
  }

  /** Whether THIS org's view of `name` comes from a CP push rather than daemon-local config. */
  isOrgScoped(orgId: string | undefined, name: string): boolean {
    return orgId !== undefined && this.cp.get(orgId)?.has(name) === true
  }

  /** Who owns the definition a view resolves `name` to: the agent's view, the organization, or nobody for a daemon-local one every organization shares. */
  scopeOf(view: string | undefined, name: string): string | undefined {
    const { orgId, agentId } = parseMcpView(view)
    if (agentId && this.layer(mcpView(orgId, agentId)).has(name)) return mcpView(orgId, agentId)
    return this.isOrgScoped(orgId, name) ? orgId : undefined
  }

  /** The decision table of an agent's own definition, when it has one. */
  toolDecisions(orgId: string | undefined, agentId: string, name: string): McpToolDecisions | undefined {
    return this.layer(mcpView(orgId, agentId)).get(name)?.toolDecisions
  }

  /** An agent's own definitions, each with its decision table: a table absent from the CP reads as every tool Blocked. */
  agentDefinitions(
    orgId: string | undefined,
    agentId: string
  ): Map<string, { def: McpServerDef; toolDecisions: McpToolDecisions }> {
    const none: McpToolDecisions = { allow: [], approval: [], ask: [], block: [] }
    return new Map(
      [...this.layer(mcpView(orgId, agentId))].map(([name, value]) => [
        name,
        { def: value.def, toolDecisions: value.toolDecisions ?? none }
      ])
    )
  }

  /** Every organization this daemon currently holds CP definitions for. */
  orgs(): string[] {
    return [...new Set([...this.cp.keys()].map((layer) => parseMcpView(layer).orgId!))]
  }

  /** Every view a CP definition can be resolved in: each organization, and each agent with definitions of its own. */
  views(): string[] {
    return [...new Set([...this.orgs(), ...this.cp.keys()])]
  }

  localDefinitions(): Record<string, McpServerDef> {
    return { ...this.local }
  }

  private layer(view: string | undefined): Map<string, Entry> {
    return (view ? this.cp.get(view) : undefined) ?? new Map<string, Entry>()
  }
}

function entry(def: McpServerDef, issuedAt: number | undefined, toolDecisions: McpToolDecisions | undefined): Entry {
  return {
    def,
    ...(issuedAt !== undefined ? { issuedAt } : {}),
    ...(toolDecisions !== undefined ? { toolDecisions } : {})
  }
}
