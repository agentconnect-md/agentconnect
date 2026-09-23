import { botCardCopy } from '@/components/console/platforms/registry'
import type { IntegrationRow } from '@/lib/data'
import type { NotificationSnapshotInput } from '@/lib/notifications'

/** One bell item per revoked integration. */
export function revokedIntegrationSourceKey(integrationId: string): string {
  return `integration-revoked:${integrationId}`
}

/** The agents whose integrations the viewer may fix — the same `canEdit` the approval bell reads. */
export interface IntegrationAgentView {
  id: string
  name: string
  canEdit: boolean
}

// The bell is a "you can act" signal: integrations of agents the viewer cannot edit, or does not know, are dropped.
export function revokedIntegrationNotifications(
  integrations: readonly IntegrationRow[],
  agents: readonly IntegrationAgentView[],
  orgPath: (path: string) => string
): NotificationSnapshotInput[] {
  const editable = new Map(agents.filter((agent) => agent.canEdit).map((agent) => [agent.id, agent]))
  const items: NotificationSnapshotInput[] = []
  for (const row of integrations) {
    if (!row.revoked || !row.id || !row.agentId) continue
    const agent = editable.get(row.agentId)
    if (!agent) continue
    const integration = `“${row.name}”`
    items.push({
      category: 'integration',
      severity: 'error',
      sourceKey: revokedIntegrationSourceKey(row.id),
      title: 'Integration revoked',
      message: `${agent.name} can no longer use ${integration}. ${botCardCopy(row.platform).revokedHint}.`,
      action: {
        label: 'Open agent',
        href: orgPath(`/agents/${encodeURIComponent(row.agentId)}`),
        external: false
      },
      resolution: {
        title: 'Revocation resolved',
        message: `${agent.name}’s ${integration} no longer needs your attention.`,
        severity: 'info',
        read: true
      }
    })
  }
  return items
}
