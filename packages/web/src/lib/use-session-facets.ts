import useSWR from 'swr'
import { fetchSessionFacets, type SessionFacets, type SessionListFilters } from './api'
import { consoleKeys } from './swr-keys'
import { sessionFilterAgentKey } from './use-session-list'

type SessionFacetKey = NonNullable<ReturnType<typeof consoleKeys.sessionFacets>>

export function useSessionFacets(
  orgId: string | null | undefined,
  filters: SessionListFilters = {},
  fallbackData?: SessionFacets
) {
  const agentId = sessionFilterAgentKey(filters.agentId)
  const integration = filters.integration ?? ''
  const platform = filters.platform ?? ''
  const channel = filters.channel ?? ''
  const triggeredBy = filters.triggeredBy ?? ''
  const githubRepoId = filters.githubRepoId ?? ''
  const tasks = filters.excludeTasks ? 'exclude' : ''
  const dreams = filters.excludeDreams ? 'exclude' : ''

  return useSWR<SessionFacets>(
    consoleKeys.sessionFacets(orgId, agentId, integration, platform, channel, triggeredBy, githubRepoId, tasks, dreams),
    (args) => {
      const [
        ,
        keyOrgId,
        ,
        keyAgentId,
        keyIntegration,
        keyPlatform,
        keyChannel,
        keyTriggeredBy,
        keyGithubRepoId,
        keyTasks,
        keyDreams
      ] = args as SessionFacetKey
      return fetchSessionFacets(keyOrgId, {
        ...(keyAgentId ? { agentId: keyAgentId.split(',') } : {}),
        ...(keyIntegration ? { integration: keyIntegration } : {}),
        ...(keyPlatform ? { platform: keyPlatform } : {}),
        ...(keyChannel ? { channel: keyChannel } : {}),
        ...(keyTriggeredBy ? { triggeredBy: keyTriggeredBy } : {}),
        ...(keyGithubRepoId ? { githubRepoId: keyGithubRepoId } : {}),
        ...(keyTasks === 'exclude' ? { excludeTasks: true } : {}),
        ...(keyDreams === 'exclude' ? { excludeDreams: true } : {})
      })
    },
    { fallbackData }
  )
}
