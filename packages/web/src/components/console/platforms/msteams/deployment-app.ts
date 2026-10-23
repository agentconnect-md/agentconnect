// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import useSWR from 'swr'
import type { MsTeamsDeploymentAppDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { msTeamsApi } from './api'

/** Whether the deployment's Teams app is offered, which Setup configuring one decides: null while it is read, false when there is none or the read failed. */
export function useMsTeamsDeploymentApp(mockMode: boolean): boolean | null {
  const { activeOrg } = useOrgs()
  const { data, error } = useSWR<MsTeamsDeploymentAppDto>(
    mockMode ? null : consoleKeys.msTeamsApp(activeOrg?.id),
    ([, orgId]: readonly [string, string]) => msTeamsApi.deploymentApp(orgId),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  )
  // Design mode has no Control Plane behind it, so it shows an organization's own bot.
  if (mockMode) return false
  if (data) return data.appId !== null
  return error === undefined ? null : false
}
