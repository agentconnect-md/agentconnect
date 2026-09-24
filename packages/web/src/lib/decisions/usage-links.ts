// Where the console opens each kind of Decision usage.

import type { DecisionUsage } from '@agentconnect.md/protocol/decision-api'
import type { IntegrationRow } from '@/lib/data'

/** A usage's console destination, or null where the console has no page for it (yet). */
export function decisionUsageHref(
  usage: DecisionUsage,
  orgPath: (path: string) => string,
  integrations: readonly Pick<IntegrationRow, 'id' | 'agentId'>[]
): string | null {
  const agentPath = (agentId: string, tab?: string) =>
    orgPath(`/agents/${encodeURIComponent(agentId)}${tab ? `?tab=${tab}` : ''}`)
  if (usage.kind === 'gate') {
    // The agent's default Integrations tab lists the gated conversation.
    const agentId = usage.integrationId
      ? integrations.find((row) => row.id === usage.integrationId)?.agentId
      : undefined
    return agentId ? agentPath(agentId) : null
  }
  if (usage.kind === 'agent_tool') return agentPath(usage.id, 'tools')
  if (usage.kind === 'model_selection') return agentPath(usage.id, 'config')
  // Routing rules open from each routed conversation, so a bot's usage lands on its configuration.
  if (usage.kind === 'shared_bot_routing') return orgPath(`/integrations?bot=${encodeURIComponent(usage.id)}`)
  return null
}
