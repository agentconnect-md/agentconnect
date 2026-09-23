'use client'

import { useEffect } from 'react'
import type { IntegrationRow } from '@/lib/data'
import { integrationCredentialNotifications, type IntegrationAgentView } from '@/lib/integration-notifications'
import { useNotifications, type NotificationSnapshotInput, type NotificationSourceScope } from '@/lib/notifications'

interface IntegrationNotifierInputs {
  /** The viewer's integrations, already filtered to what they can see. */
  integrations: readonly IntegrationRow[]
  /** Until the list has answered once, its empty default must not resolve every item. */
  integrationsLoaded: boolean
  /** Until the bot list has answered once, every rejected mark reads as cleared. */
  botsLoaded: boolean
  agents: readonly IntegrationAgentView[]
  /** Until the roster has answered once, its empty default would drop every item; loading and a failed pull alike. */
  agentsLoaded: boolean
  orgPath: (path: string) => string
}

type SyncSourceSnapshot = (scope: NotificationSourceScope, items: NotificationSnapshotInput[]) => void

/** Keep the bell's `integrations` scope equal to the viewer's revoked or rejected integrations, once all three reads have landed. */
export function syncIntegrationNotifications(inputs: IntegrationNotifierInputs, sync: SyncSourceSnapshot): void {
  if (!inputs.integrationsLoaded || !inputs.botsLoaded || !inputs.agentsLoaded) return
  sync('integrations', integrationCredentialNotifications(inputs.integrations, inputs.agents, inputs.orgPath))
}

export function useIntegrationNotifier({
  integrations,
  integrationsLoaded,
  botsLoaded,
  agents,
  agentsLoaded,
  orgPath
}: IntegrationNotifierInputs): void {
  const { syncSourceSnapshot } = useNotifications()
  useEffect(() => {
    syncIntegrationNotifications(
      { integrations, integrationsLoaded, botsLoaded, agents, agentsLoaded, orgPath },
      syncSourceSnapshot
    )
  }, [integrations, integrationsLoaded, botsLoaded, agents, agentsLoaded, orgPath, syncSourceSnapshot])
}
