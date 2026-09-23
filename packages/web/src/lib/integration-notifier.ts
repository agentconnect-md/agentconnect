'use client'

import { useEffect } from 'react'
import type { IntegrationRow } from '@/lib/data'
import { revokedIntegrationNotifications, type IntegrationAgentView } from '@/lib/integration-notifications'
import { useNotifications, type NotificationSnapshotInput, type NotificationSourceScope } from '@/lib/notifications'

interface IntegrationNotifierInputs {
  /** The viewer's integrations, already filtered to what they can see. */
  integrations: readonly IntegrationRow[]
  /** Until the list has answered once, its empty default must not resolve every item. */
  integrationsLoaded: boolean
  agents: readonly IntegrationAgentView[]
  /** Until the roster has answered once, its empty default would drop every item; loading and a failed pull alike. */
  agentsLoaded: boolean
  orgPath: (path: string) => string
}

type SyncSourceSnapshot = (scope: NotificationSourceScope, items: NotificationSnapshotInput[]) => void

/** Keep the bell's `integrations` scope equal to the viewer's revoked integrations, once both reads have landed. */
export function syncIntegrationNotifications(inputs: IntegrationNotifierInputs, sync: SyncSourceSnapshot): void {
  if (!inputs.integrationsLoaded || !inputs.agentsLoaded) return
  sync('integrations', revokedIntegrationNotifications(inputs.integrations, inputs.agents, inputs.orgPath))
}

export function useIntegrationNotifier({
  integrations,
  integrationsLoaded,
  agents,
  agentsLoaded,
  orgPath
}: IntegrationNotifierInputs): void {
  const { syncSourceSnapshot } = useNotifications()
  useEffect(() => {
    syncIntegrationNotifications(
      { integrations, integrationsLoaded, agents, agentsLoaded, orgPath },
      syncSourceSnapshot
    )
  }, [integrations, integrationsLoaded, agents, agentsLoaded, orgPath, syncSourceSnapshot])
}
