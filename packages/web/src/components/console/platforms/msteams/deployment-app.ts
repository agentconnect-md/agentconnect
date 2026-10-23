// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import useSWR from 'swr'
import type { MsTeamsDeploymentAppDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { msTeamsApi } from './api'

/** Whether the deployment's Teams app is offered when `enabled`: null while it is read, false when there is none or the read failed. */
export function useMsTeamsDeploymentApp(enabled: boolean, mockMode: boolean): boolean | null {
  const { activeOrg } = useOrgs()
  const { data, error } = useSWR<MsTeamsDeploymentAppDto>(
    enabled && !mockMode ? consoleKeys.msTeamsApp(activeOrg?.id) : null,
    ([, orgId]: readonly [string, string]) => msTeamsApi.deploymentApp(orgId),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  )
  // Design mode has no Control Plane behind it, so the pane stays reachable there.
  if (!enabled) return false
  if (mockMode) return true
  if (data) return data.appId !== null
  return error === undefined ? null : false
}
