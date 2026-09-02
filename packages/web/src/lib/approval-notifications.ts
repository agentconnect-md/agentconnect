import type { PendingApprovalSession } from '@/lib/api'
import type { NotificationSnapshotInput } from '@/lib/notifications'

/** One bell item per waiting session (slack-approval-dm.md §7). */
export function approvalSourceKey(sessionId: string): string {
  return `approval:${sessionId}`
}

/** The agents whose approvals the viewer may act on — the same `canEdit` the decision route enforces. */
export interface ApprovalAgentView {
  id: string
  name: string
  canEdit: boolean
}

// The bell is a "you can act" signal: sessions of agents the viewer cannot edit are dropped, not shown read-only.
// Resolution text is fixed here — the browser never learns who decided or how; that stays on the approval card (§7).
export function approvalNotifications(
  pending: readonly PendingApprovalSession[],
  agents: readonly ApprovalAgentView[],
  orgPath: (path: string) => string
): NotificationSnapshotInput[] {
  const editable = new Map(agents.filter((agent) => agent.canEdit).map((agent) => [agent.id, agent]))
  const items: NotificationSnapshotInput[] = []
  for (const session of pending) {
    const agent = editable.get(session.agentId)
    if (!agent) continue
    const agentName = session.agentName?.trim() || agent.name
    const where = session.title?.trim() ? ` in “${session.title.trim()}”` : ''
    items.push({
      category: 'approval',
      severity: 'warning',
      sourceKey: approvalSourceKey(session.sessionId),
      title: 'Approval needed',
      message: `${agentName} is waiting for permission${where}.`,
      action: {
        label: 'Open session',
        href: orgPath(`/sessions/${encodeURIComponent(session.sessionId)}`),
        external: false
      },
      resolution: {
        title: 'Approval resolved',
        message: `${agentName} is no longer waiting for permission${where}.`,
        severity: 'info',
        read: true
      }
    })
  }
  return items
}
