import useSWR from 'swr'
import { fetchSessionFacets, type SessionFacets, type SessionListFilters } from './api'
import { consoleKeys } from './swr-keys'

type SessionFacetKey = NonNullable<ReturnType<typeof consoleKeys.sessionFacets>>
export const SESSION_FACET_REFRESH_MS = 60_000

export function useSessionFacets(
  orgId: string | null | undefined,
  filters: SessionListFilters = {},
  fallbackData?: SessionFacets
) {
  const agentId = filters.agentId ?? ''
  const integration = filters.integration ?? ''
  const platform = filters.platform ?? ''
  const channel = filters.channel ?? ''
  const triggeredBy = filters.triggeredBy ?? ''
  const githubRepoId = filters.githubRepoId ?? ''

  return useSWR<SessionFacets>(
    consoleKeys.sessionFacets(orgId, agentId, integration, platform, channel, triggeredBy, githubRepoId),
    (args) => {
      const [, keyOrgId, , keyAgentId, keyIntegration, keyPlatform, keyChannel, keyTriggeredBy, keyGithubRepoId] =
        args as SessionFacetKey
      return fetchSessionFacets(keyOrgId, {
        ...(keyAgentId ? { agentId: keyAgentId } : {}),
        ...(keyIntegration ? { integration: keyIntegration } : {}),
        ...(keyPlatform ? { platform: keyPlatform } : {}),
        ...(keyChannel ? { channel: keyChannel } : {}),
        ...(keyTriggeredBy ? { triggeredBy: keyTriggeredBy } : {}),
        ...(keyGithubRepoId ? { githubRepoId: keyGithubRepoId } : {})
      })
    },
    { fallbackData, refreshInterval: SESSION_FACET_REFRESH_MS }
  )
}
