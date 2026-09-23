import { botCardCopy, withCredentialCode } from '@/components/console/platforms/registry'
import type { IntegrationRow } from '@/lib/data'
import type { NotificationSnapshotInput } from '@/lib/notifications'

/** One bell item per revoked integration. */
export function revokedIntegrationSourceKey(integrationId: string): string {
  return `integration-revoked:${integrationId}`
}

/** One bell item per integration whose credential an ambiguous check rejected; its own key, so a later revocation swaps items. */
export function rejectedIntegrationSourceKey(integrationId: string): string {
  return `integration-rejected:${integrationId}`
}

/** The agents whose integrations the viewer may fix — the same `canEdit` the approval bell reads. */
export interface IntegrationAgentView {
  id: string
  name: string
  canEdit: boolean
}

// The bell is a "you can act" signal: integrations of agents the viewer cannot edit, or does not know, are dropped.
export function integrationCredentialNotifications(
  integrations: readonly IntegrationRow[],
  agents: readonly IntegrationAgentView[],
  orgPath: (path: string) => string
): NotificationSnapshotInput[] {
  const editable = new Map(agents.filter((agent) => agent.canEdit).map((agent) => [agent.id, agent]))
  const items: NotificationSnapshotInput[] = []
  for (const row of integrations) {
    if ((!row.revoked && !row.rejected) || !row.id || !row.agentId) continue
    const agent = editable.get(row.agentId)
    if (!agent) continue
    const integration = `“${row.name}”`
    const copy = botCardCopy(row.platform)
    // Revoked outranks a rejected mark, as on the agent page pill.
    const state = row.revoked
      ? {
          sourceKey: revokedIntegrationSourceKey(row.id),
          title: 'Integration revoked',
          message: `${agent.name} can no longer use ${integration}. ${withCredentialCode(copy.revokedHint, row.credentialCode)}.`,
          resolved: 'Revocation resolved'
        }
      : {
          sourceKey: rejectedIntegrationSourceKey(row.id),
          title: 'Integration credentials rejected',
          message: `${agent.name}’s ${integration} credentials were rejected. ${withCredentialCode(copy.rejectedHint, row.credentialCode)}.`,
          resolved: 'Rejection resolved'
        }
    items.push({
      category: 'integration',
      severity: 'error',
      sourceKey: state.sourceKey,
      title: state.title,
      message: state.message,
      action: {
        label: 'Open agent',
        href: orgPath(`/agents/${encodeURIComponent(row.agentId)}`),
        external: false
      },
      resolution: {
        title: state.resolved,
        message: `${agent.name}’s ${integration} no longer needs your attention.`,
        severity: 'info',
        read: true
      }
    })
  }
  return items
}
