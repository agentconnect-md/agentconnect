// No 'use client' here: reached only from ModalProvider's tree (the client boundary).

import useSWR from 'swr'
import type { GoogleChatDeploymentAppDto } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { googleChatApi } from './api'
import { googleChatMarketplaceUrl } from './setup'

// Design mode has no Control Plane behind it, so a synthetic app keeps the Marketplace pane reachable.
const MOCK_PROJECT_NUMBER = '100000000000'

/** The deployment app's Marketplace listing when `enabled`: undefined while it is read, null when there is none or the read failed. */
export function useGoogleChatMarketplaceUrl(enabled: boolean, mockMode: boolean): string | null | undefined {
  const { activeOrg } = useOrgs()
  const { data, error } = useSWR<GoogleChatDeploymentAppDto>(
    enabled && !mockMode ? consoleKeys.googleChatApp(activeOrg?.id) : null,
    ([, orgId]: readonly [string, string]) => googleChatApi.deploymentApp(orgId),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  )
  if (!enabled) return null
  if (mockMode) return googleChatMarketplaceUrl(MOCK_PROJECT_NUMBER)
  if (data) return data.projectNumber ? googleChatMarketplaceUrl(data.projectNumber) : null
  return error === undefined ? undefined : null
}
