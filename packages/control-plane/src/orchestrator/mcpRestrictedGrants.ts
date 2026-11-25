// Loads a provider's restricted agent grants with the relay table each one's custody allows (mcp-tool-permissions.md §5.6, §6.1).
import type { AgentMcpToolPolicyRepo, McpGrantRepo } from '../persistence/ports.js'
import type { OrgId } from '../domain/ids.js'
import type { RestrictedGrantView } from './mcpProvider.js'
import { relayToolPolicy } from './mcpToolPolicy.js'

export interface RestrictedGrantDeps {
  grants: McpGrantRepo
  /** Absent in graphs without policies: no grant is restricted. */
  policies?: Pick<AgentMcpToolPolicyRepo, 'listForProvider'>
}

/** Every active agent grant of a provider whose agent still holds a policy; a grant without one is left out, so it fails closed. */
export async function restrictedGrantsFor(
  orgId: OrgId,
  providerId: string,
  deps: RestrictedGrantDeps
): Promise<RestrictedGrantView[]> {
  if (!deps.policies) return []
  const [grants, policies] = await Promise.all([
    deps.grants.activeRestricted(orgId, providerId),
    deps.policies.listForProvider(orgId, providerId)
  ])
  const byAgent = new Map(policies.map((policy) => [policy.agentId, policy]))
  return grants.flatMap((grant) => {
    const policy = byAgent.get(grant.agentId)
    return policy ? [{ key: grant.key, policy: relayToolPolicy(policy, grant.custody) }] : []
  })
}
