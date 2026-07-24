import { isDeepStrictEqual } from 'node:util'
import type { McpServerDef } from '../config/config-schema.js'

/**
 * `CpMcpDefs` — merges CP-pushed MCP server defs over the daemon's local
 * `config.mcpServers`, producing the EFFECTIVE def map used at ACP `session/new`
 * and reported to the CP as facts (centralized-tool-management.md §7/§8).
 *
 * Precedence: a CP-pushed def WINS over a same-named local def; when the CP def
 * is removed, the shadowed local def is restored automatically (local is the
 * immutable base, CP layers on top). Names only in local — or only in CP — pass
 * through unchanged.
 *
 * CP defs are MEMORY-ONLY: they are pushed live via `mcpserver/upsert` /
 * `mcpserver/remove` and re-converged whole from the `register/ok` reconcile
 * snapshot, so `converge()` FULL-REPLACES the CP set (a def removed while the
 * daemon was disconnected is pruned on reconnect).
 * `ponytail: memory-only — add cache-file persistence if MCP-proxy must survive a
 * daemon restart while the CP is down (local config still works air-gapped).`
 *
 * Pure + logging-free: the caller strips the reserved bridge name and logs
 * (never the def values — an http proxy def's headers carry a bearer grant key).
 */
export class CpMcpDefs {
  private cp = new Map<string, McpServerDef>()

  constructor(private readonly local: Record<string, McpServerDef>) {}

  /** Add or replace one CP-pushed def (mcpserver/upsert); returns whether the effective set changed. */
  upsert(name: string, def: McpServerDef): boolean {
    if (isDeepStrictEqual(this.cp.get(name), def)) return false // idempotent re-push — no re-emit churn
    this.cp.set(name, def)
    return true
  }

  /** Drop one CP-pushed def by name; returns whether it was present (mcpserver/remove). */
  remove(name: string): boolean {
    return this.cp.delete(name)
  }

  /** Full-replace the CP set with the reconcile snapshot (register/ok.mcpServers);
   *  returns whether the set changed. */
  converge(entries: Array<[string, McpServerDef]>): boolean {
    const next = new Map(entries)
    if (next.size === this.cp.size && [...next].every(([k, v]) => isDeepStrictEqual(this.cp.get(k), v))) return false
    this.cp = next
    return true
  }

  /** The effective def map: local config with CP-pushed defs layered on top (CP wins). */
  effective(): Record<string, McpServerDef> {
    return { ...this.local, ...Object.fromEntries(this.cp) }
  }
}
