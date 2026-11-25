// Agent grants by custody: which one a daemon receives, and the lazy mint that binds it on the relays first (mcp-tool-permissions.md §5.4, §5.6).
import { MCP_TOOL_APPROVAL_V1_FEATURE } from '@agentconnect.md/protocol'
import type {
  AgentMcpToolPolicyRepo,
  McpAgentGrantRecord,
  McpGrantCustody,
  McpGrantRepo,
  McpProviderRecord
} from '../persistence/ports.js'
import { OrgId } from '../domain/ids.js'
import { currentMcpGrant, mcpBinding, type McpBinding } from './mcpProvider.js'
import { restrictedGrantsFor } from './mcpRestrictedGrants.js'
import { resolveUpstreamHeaders, type McpUpstreamHeaderDeps } from './mcpUpstreamHeaders.js'

/** The custody of the agent grant a daemon receives: `daemon` only where it keeps the key from its runtimes. */
export function grantCustodyFor(features: readonly string[] | undefined): McpGrantCustody {
  return features?.includes(MCP_TOOL_APPROVAL_V1_FEATURE) === true ? 'daemon' : 'runtime'
}

/** The agent's current grant of one custody, or the one minted and bound now; undefined once the agent has no policy for the provider. */
export type McpAgentGrantMinter = (
  provider: McpProviderRecord,
  agentId: string,
  custody: McpGrantCustody
) => Promise<McpAgentGrantRecord | undefined>

export interface McpAgentGrantMintDeps extends McpUpstreamHeaderDeps {
  grants: McpGrantRepo
  policies: Pick<AgentMcpToolPolicyRepo, 'get' | 'listForProvider'>
  /** Carries the upstream credential — NEVER logged. */
  relays: { mcpAssign(binding: McpBinding): void }
  /** The provider's binding chain, so this push never interleaves with a rotation, a removal or a policy write. */
  serialize: <T>(orgId: string, name: string, run: () => Promise<T>) => Promise<T>
}

/** Re-push a provider's relay binding with its shared keys and every restricted grant; nothing without a callable upstream. */
export async function rebindMcpProvider(
  provider: McpProviderRecord,
  deps: Omit<McpAgentGrantMintDeps, 'serialize'>
): Promise<void> {
  const orgId = OrgId(provider.orgId)
  const keys = (await deps.grants.activeForProvider(orgId, provider.id)).map((g) => g.key)
  if (keys.length === 0) return
  // Cached-only: a projection must not wait on a third-party authorization server.
  const headers = await resolveUpstreamHeaders(deps, provider, orgId, { allowNetwork: false })
  if (headers === null) return
  deps.relays.mcpAssign(mcpBinding(provider, headers, keys, await restrictedGrantsFor(orgId, provider.id, deps)))
}

/** Mints a missing agent grant inside the provider's chain, never promoting another custody's, and binds it before the caller projects it. */
export function makeMcpAgentGrantMinter(deps: McpAgentGrantMintDeps): McpAgentGrantMinter {
  return (provider, agentId, custody) =>
    deps.serialize(provider.orgId, provider.name, async () => {
      const orgId = OrgId(provider.orgId)
      if (!(await deps.policies.get(orgId, agentId, provider.id))) return undefined
      const active = await deps.grants.activeForAgent(orgId, provider.id, agentId)
      const current = currentMcpGrant(active.filter((g) => g.custody === custody))
      if (current) return current
      const grant = await deps.grants.mintForAgent(orgId, provider.id, agentId, custody)
      await rebindMcpProvider(provider, deps)
      return grant
    })
}
