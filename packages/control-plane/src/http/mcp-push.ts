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
import { mcpBinding, type GrantView } from '../orchestrator/mcpProvider.js'
import { restrictedGrantsFor } from '../orchestrator/mcpRestrictedGrants.js'
import { makeMcpDefSync } from './mcp-defs.js'

export interface McpPush {
  /** Takes the grant ROW: the daemon def carries its issuance instant as the
   *  ordering marker, and that must come from the same grant as the key. */
  /** `headers: null` means there is no callable upstream credential yet (an oauth2 provider
   *  that has not been authorized): the daemon definition is still published, because the
   *  agent-facing proxy url and grant key are real, but no relay binding is — binding with an
   *  empty credential is how a working OAuth binding gets overwritten by a rotation or a PATCH. */
  pushAssign(provider: McpProviderRecord, headers: McpHeader[] | null, grant: GrantView, orgId: OrgId): Promise<void>
  pushUnassign(provider: McpProviderRecord, orgId: OrgId): Promise<void>
  /** Relay-only re-bind with every active shared key the caller supplies and the restricted grants it loads; the daemon definitions are untouched. */
  pushBinding(provider: McpProviderRecord, headers: McpHeader[], grantKeys: string[]): Promise<void>
  /** Relay-only unbind: drop the proxy binding while LEAVING the daemon definition in place.
   *  What an OAuth disconnect uses — the agent-facing proxy url and grant key are unchanged by
   *  it, so removing the def would make every enabling daemon lose the server until some other
   *  definition sync happened, and a later reconnect (which republishes only the binding)
   *  would not bring it back. */
  unbindRelay(provider: McpProviderRecord): void
}

export function makeMcpPush(deps: HttpDeps): McpPush {
  const defs = makeMcpDefSync(deps)
  const bindingOf = async (provider: McpProviderRecord, headers: McpHeader[], grantKeys: string[]) =>
    mcpBinding(
      provider,
      headers,
      grantKeys,
      await restrictedGrantsFor(provider.orgId, provider.id, {
        grants: deps.repos.mcpGrant,
        policies: deps.repos.agentMcpToolPolicy
      })
    )

  // Every daemon SERVING an agent that enabled `name` — its placement plus any
  // duty holder. Resolved through AgentDelivery, never `a.daemonId` inline: a
  // holder that installed the agent through `duty/fetch` must see the provider's
  // rotations and its removal, or it keeps calling with a retired grant key.
  const daemonsEnabling = async (orgId: OrgId, name: string): Promise<string[]> => {
    const agents = (await deps.repos.agent.list(orgId)).filter((a) => a.mcpServers.includes(name))
    return deps.agentDelivery.daemonsForAgents(agents)
  }

  return {
    // The relay binding (upstream secret headers, restricted grants kept) lands before the daemon definitions; NEVER logged.
    async pushAssign(provider, headers, grant, orgId) {
      if (headers !== null) deps.relayControl.mcpAssign(await bindingOf(provider, headers, [grant.key]))
      await defs.converge(orgId, provider, { sharedGrant: grant })
    },
    async pushBinding(provider, headers, grantKeys) {
      if (grantKeys.length === 0) return // a keyless binding is never callable
      deps.relayControl.mcpAssign(await bindingOf(provider, headers, grantKeys))
    },
    unbindRelay(provider) {
      deps.relayControl.mcpUnassign({ providerId: provider.id })
    },
    async pushUnassign(provider, orgId) {
      deps.relayControl.mcpUnassign({ providerId: provider.id })
      for (const d of await daemonsEnabling(orgId, provider.name)) {
        try {
          await deps.control.mcpServerRemove(d, orgId, provider.name)
        } catch {
          // daemon offline — reconcile drops the stale def on its next register
        }
      }
    }
  }
}
