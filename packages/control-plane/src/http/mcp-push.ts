/**
 * Shared relay + daemon push helpers for MCP providers — used by both the generic
 * `mcp-providers` CRUD routes and the `connectors` create flow, so a provider row
 * (custom upstream OR open-connector connection) binds to the relay pool and the
 * enabling daemons the exact same way.
 *
 * SECURITY: the outputs (rc/mcp-assign, daemon proxy def) are token-bearing — they
 * carry the upstream secret headers and the plaintext grant key. NEVER log them.
 */
import type { McpProviderRecord, McpHeader } from '../persistence/ports.js'
import type { OrgId } from '../domain/ids.js'
import type { HttpDeps } from './deps.js'
import { mcpProxyDef, mcpRcAssign, relayHttpOrigin } from '../orchestrator/mcpProvider.js'

export interface McpPush {
  pushAssign(provider: McpProviderRecord, headers: McpHeader[], grantKey: string, orgId: OrgId): Promise<void>
  pushUnassign(provider: McpProviderRecord, orgId: OrgId): Promise<void>
}

export function makeMcpPush(deps: HttpDeps): McpPush {
  // The reachable relay proxy base an agent's MCP client dials (`${url}/mcp/:id`).
  // Picks any alive relay from the durable table (same window the roster uses).
  const relayBaseUrl = async (): Promise<string | null> => {
    const alive = await deps.repos.relay.listAlive(new Date(Date.now() - (deps.config.RELAY_STALE_MS ?? 0)))
    const url = alive[0]?.daemonUrl
    // daemonUrl is the rd/* WS dial address (wss://…); the MCP proxy is HTTP on the
    // same origin — normalize so the live push sends a reachable http def, not wss.
    return url ? relayHttpOrigin(url) : null
  }

  // Daemons with a placed agent that enabled `name` (runtimeOverrides.mcpServers).
  const daemonsEnabling = async (orgId: OrgId, name: string): Promise<string[]> => {
    const agents = await deps.repos.agent.list(orgId)
    return [...new Set(agents.filter((a) => a.daemonId && a.mcpServers.includes(name)).map((a) => a.daemonId!))]
  }

  return {
    // Best-effort double-push (like integrations): the relay binding carries the
    // UPSTREAM secret headers; the daemon proxy def carries the grant key + relay URL.
    // NEVER logged. Swallows NoConnection per daemon (reconcile is the backstop).
    async pushAssign(provider, headers, grantKey, orgId) {
      deps.relayControl.mcpAssign(mcpRcAssign(provider, headers, [grantKey]))
      const base = await relayBaseUrl()
      if (!base) return
      const spec = mcpProxyDef(provider, grantKey, base)
      for (const d of await daemonsEnabling(orgId, provider.name)) {
        try {
          await deps.control.mcpServerUpsert(d, spec)
        } catch {
          // daemon offline — reconcile carries the def on its next register
        }
      }
    },
    async pushUnassign(provider, orgId) {
      deps.relayControl.mcpUnassign({ providerId: provider.id })
      for (const d of await daemonsEnabling(orgId, provider.name)) {
        try {
          await deps.control.mcpServerRemove(d, provider.name)
        } catch {
          // daemon offline — reconcile drops the stale def on its next register
        }
      }
    }
  }
}
