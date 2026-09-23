'use client'

import { useEffect } from 'react'
import type { PendingApprovalSession } from '@/lib/api'
import { approvalNotifications, type ApprovalAgentView } from '@/lib/approval-notifications'
import { useNotifications } from '@/lib/notifications'

interface ApprovalNotifierInputs {
  /** The org's waiting sessions; null until the first pull settles (or in mock mode). */
  pendingApprovalSessions: readonly PendingApprovalSession[] | null
  agents: readonly ApprovalAgentView[]
  /** Until the roster has answered once, its empty default would resolve every item; loading and a failed pull alike. */
  agentsLoaded: boolean
  orgPath: (path: string) => string
}

/** Keep the bell's `approvals` scope equal to the sessions the viewer can act on (slack-approval-dm.md §7). */
export function useApprovalNotifier({
  pendingApprovalSessions,
  agents,
  agentsLoaded,
  orgPath
}: ApprovalNotifierInputs) {
  const { syncSourceSnapshot } = useNotifications()
  useEffect(() => {
    if (!pendingApprovalSessions || !agentsLoaded) return
    syncSourceSnapshot('approvals', approvalNotifications(pendingApprovalSessions, agents, orgPath))
  }, [pendingApprovalSessions, agents, agentsLoaded, orgPath, syncSourceSnapshot])
}
