// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import useSWR from 'swr'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { googleChatApi, type GoogleChatPlatformInstallDto } from './api'

/** Whether the deployment-owned Chat app can be installed here: null while the read is in flight, false when it failed. */
export function useGoogleChatPlatformInstall(mockMode: boolean): boolean | null {
  const { activeOrg } = useOrgs()
  const { data, error } = useSWR<GoogleChatPlatformInstallDto>(
    mockMode ? null : consoleKeys.googleChatPlatformInstall(activeOrg?.id),
    ([, orgId]: readonly [string, string]) => googleChatApi.readPlatformInstall(orgId),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  )
  // Design mode has no Control Plane behind it, so every pane stays reachable.
  if (mockMode) return true
  if (data) return data.available
  return error === undefined ? null : false
}
