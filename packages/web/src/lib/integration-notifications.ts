import { botCardCopy } from '@/components/console/platforms/registry'
import type { IntegrationRow } from '@/lib/data'
import type { NotificationSnapshotInput } from '@/lib/notifications'

/** One bell item per revoked integration. */
export function revokedIntegrationSourceKey(integrationId: string): string {
  return `integration-revoked:${integrationId}`
}

/** The roster a revoked integration's item names its agent from. */
export interface IntegrationAgentView {
  id: string
  name: string
}

// The active set follows the integration list alone; the roster only supplies the agent's name.
export function revokedIntegrationNotifications(
  integrations: readonly IntegrationRow[],
  agents: readonly IntegrationAgentView[],
  orgPath: (path: string) => string
): NotificationSnapshotInput[] {
  const names = new Map(agents.map((agent) => [agent.id, agent.name.trim()]))
  const items: NotificationSnapshotInput[] = []
  for (const row of integrations) {
    if (!row.revoked || !row.id || !row.agentId) continue
    const agentName = names.get(row.agentId)
    const integration = `“${row.name}”`
    const lead = agentName ? `${agentName} can no longer use ${integration}.` : `${integration} can no longer be used.`
    items.push({
      category: 'integration',
      severity: 'error',
      sourceKey: revokedIntegrationSourceKey(row.id),
      title: 'Integration revoked',
      message: `${lead} ${botCardCopy(row.platform).revokedHint}.`,
      action: {
        label: 'Open agent',
        href: orgPath(`/agents/${encodeURIComponent(row.agentId)}`),
        external: false
      },
      resolution: {
        title: 'Revocation cleared',
        message: `${agentName ? `${agentName}’s ` : ''}${integration} is no longer revoked.`,
        severity: 'info',
        read: true
      }
    })
  }
  return items
}
